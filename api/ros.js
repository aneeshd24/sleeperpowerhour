// GET /api/ros — consensus rest-of-season values keyed by Sleeper player ID.
//
// Pulls FantasyPros, DraftSharks and LeagueLogs ROS rankings (full or half PPR, SCORING in lib/sources.js) plus Sleeper's player map,
// matches every ranked player to a Sleeper ID and blends the sources (lib/consensus.js).
// The front end asks for /api/ros?d=<morning key> (lib/newsclock.js); any other key is redirected to it. Sleeper's
// player map is read at most once per morning: it's kept slimmed in the store (lib/snapstore.js) under that key, so
// deploys, CDN purges and the hourly retry while a ranking site is down all reuse it. The ranking sites are scraped
// once per morning too (hourly while one of them is failing).
import { morningKey } from '../lib/newsclock.js';
import { once } from '../lib/snapstore.js';

import {
  FANTASYPROS_URL, DRAFTSHARKS_URL, LEAGUELOGS_URL,
  parseFantasyPros, parseDraftSharks, parseLeagueLogs,
} from '../lib/sources.js';
import { buildIndex, buildConsensus } from '../lib/consensus.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const POS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

async function getText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*', 'accept-language': 'en-US,en;q=0.9' },
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadSource(key, url, parse) {
  const t0 = Date.now();
  try {
    const parsed = parse(await getText(url));
    if (!parsed.players.length) throw new Error('parsed 0 players');
    return [key, { ok: true, ms: Date.now() - t0, updated: parsed.updated, players: parsed.players }];
  } catch (e) {
    return [key, { ok: false, ms: Date.now() - t0, error: String(e.message || e) }];
  }
}

// Sleeper's /players/nfl (~5 MB), cut to the fields we use for fantasy positions
async function sleeperPlayers() {
  const r = await fetch('https://api.sleeper.app/v1/players/nfl');
  if (!r.ok) throw new Error(`Sleeper players ${r.status}`);
  const all = await r.json(), slim = {};
  for (const [id, p] of Object.entries(all)) {
    if (!POS.has(p.position)) continue;
    slim[id] = { full_name: p.full_name, first_name: p.first_name, last_name: p.last_name, position: p.position, team: p.team, injury_status: p.injury_status, active: p.active, age: p.age };
  }
  return slim;
}

const askedKey = (req) => req.query?.d ?? (req.url ? new URL(req.url, 'http://x').searchParams.get('d') : null);

export default async function handler(req, res) {
  try {
    const key = morningKey(), canonical = key;
    if (req.url && askedKey(req) !== canonical) {
      res.setHeader('Cache-Control', 'public, s-maxage=60');
      res.setHeader('Location', `/api/ros?d=${encodeURIComponent(canonical)}`);
      return res.status(307).end();
    }
    const { body, from } = await once('ros', key, async () => {
      const body = await build(key);
      const allOk = Object.values(body.sources).every((s) => s.ok);
      return { body, ttl: allOk ? 3 * 86400 : 3600 }; // a failed source gets retried after an hour
    });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Snapshot', `${canonical} ${from}`);
    // A day at the edge, then serve stale for another day while a fresh copy is fetched in the background; browsers keep
    // it for an hour (the morning's values don't change). If a source failed, only cache for an hour at the edge and not
    // at all in the browser, so the next visit picks up the retry.
    const allOk = Object.values(body.sources).every((s) => s.ok);
    res.setHeader('Cache-Control', allOk ? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400' : 'public, s-maxage=3600');
    res.status(200).send(JSON.stringify(body));
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
}

// players: the stored Sleeper player map, when the caller already has it, so nothing reads Sleeper
export async function build(key, { players: stored = null } = {}) {
    const [sources, sleeper] = await Promise.all([
      Promise.all([
        loadSource('fp', FANTASYPROS_URL, parseFantasyPros),
        loadSource('ds', DRAFTSHARKS_URL, parseDraftSharks),
        loadSource('ll', LEAGUELOGS_URL, parseLeagueLogs),
      ]).then(Object.fromEntries),
      stored || once('players', key, async () => ({ body: await sleeperPlayers(), ttl: 3 * 86400 })).then((x) => x.body),
    ]);

    const idx = buildIndex(sleeper);
    const okSources = Object.fromEntries(Object.entries(sources).filter(([, s]) => s.ok));
    const { values, stats } = buildConsensus(okSources, idx);

    // Compact name map for every fantasy-relevant player (rostered, ranked, or recently active).
    const players = {};
    for (const [id, p] of Object.entries(sleeper)) {
      if (!POS.has(p.position)) continue;
      if (!p.active && !p.team && !values[id]) continue;
      players[id] = {
        n: p.position === 'DEF' ? `${p.first_name} ${p.last_name}` : p.full_name || `${p.first_name} ${p.last_name}`,
        p: p.position,
        t: p.team || null,
        i: p.injury_status || null,
        a: p.age || null,
      };
    }

    // NFL bye weeks by team, from FantasyPros (every player row carries its team's bye)
    const byes = {};
    for (const p of sources.fp?.ok ? sources.fp.players : []) if (p.team && p.bye) byes[p.team] = p.bye;

    const body = {
      updated: new Date().toISOString(),
      sources: Object.fromEntries(
        Object.entries(sources).map(([k, s]) => [
          k,
          s.ok ? { ok: true, rows: stats[k]?.rows, matched: stats[k]?.matched, updated: s.updated || null, ms: s.ms } : { ok: false, error: s.error },
        ])
      ),
      weights: { fp: 1, ds: 1, ll: 0.5 },
      players,
      values,
      byes,
    };

    return body;
}
