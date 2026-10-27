// /api/votes — fan picks for this week's matchups, shared by everyone.
//
//   GET  /api/votes?week=7&voter=<id>        -> { week, open, counts: { "3-8": { "3": 5, "8": 2 } }, mine: { "3-8": "8" } }
//   POST /api/votes { week, pair, pick, voter } -> same shape after recording the vote
//
// Storage is an Upstash Redis database (Vercel Storage -> Upstash for Redis), reached over its REST API with plain
// fetch, so there are still no npm dependencies. Vercel injects KV_REST_API_URL / KV_REST_API_TOKEN (or the
// UPSTASH_REDIS_REST_* names) once the database is connected to the project. Until then GET answers
// { enabled: false } (a normal 200, so browsers don't log an error) and the page simply hides voting.
//
// One vote per device: the browser keeps a random voter id and re-voting replaces its pick. As a soft guard against
// clearing storage to vote again, one network (hashed IP) can cast at most MAX_PER_NETWORK votes per matchup, which
// still lets a few friends on the same Wi-Fi vote. Voting closes at Thursday night kickoff (7:15pm Central) or once
// the morning snapshot shows points on the board, whichever comes first.
//
// Matchups come from /api/league, the once-a-morning Sleeper snapshot on the CDN, so voting never calls Sleeper itself.
import { leagueKey } from '../lib/newsclock.js';

import { createHash } from 'node:crypto';

const MAX_PER_NETWORK = 3;
const TTL = 60 * 60 * 24 * 120; // keep a season's votes around
// Vercel may prefix the injected names (e.g. STORAGE_KV_REST_API_URL), so match on the suffix
const env = (...suffixes) => {
  for (const s of suffixes) {
    const k = Object.keys(process.env).find((n) => n === s || n.endsWith(`_${s}`));
    if (k && process.env[k]) return process.env[k];
  }
};
const url = () => env('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
const token = () => env('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');

async function redis(commands) {
  const r = await fetch(`${url()}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`vote store ${r.status}`);
  return (await r.json()).map((x) => {
    if (x.error) throw new Error(x.error);
    return x.result;
  });
}

const TZ = 'America/Chicago';
const now = () => Number(process.env.VOTES_NOW) || Date.now(); // overridable for tests
// the same snapshot key the page uses, so this reads the stored copy and never causes a Sleeper pull of its own
const snapKey = () => leagueKey(new Date(now()));
// Thursday from 7:15pm through Monday, Central time: this week's games are under way
function kickedOff() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(now())).map((x) => [x.type, x.value]));
  const mins = Number(p.hour) * 60 + Number(p.minute);
  return ['Fri', 'Sat', 'Sun', 'Mon'].includes(p.weekday) || (p.weekday === 'Thu' && mins >= 19 * 60 + 15);
}

// this week's matchups from the morning snapshot: pair keys like "3-8" (lower roster id first) and whether voting is open
async function week(w, req) {
  const proto = req.headers['x-forwarded-proto'] || (String(req.headers.host).startsWith('localhost') ? 'http' : 'https');
  const r = await fetch(`${proto}://${req.headers.host}/api/league?d=${snapKey()}`);
  if (!r.ok) throw new Error(`league snapshot ${r.status}`);
  const snap = await r.json();
  const rows = snap.matchups?.[w] || [];
  const byId = {};
  for (const m of rows) (byId[m.matchup_id] ||= []).push(m.roster_id);
  const pairs = Object.values(byId).filter((p) => p.length === 2).map((p) => p.sort((a, b) => a - b).join('-'));
  const started = kickedOff() || rows.some((m) => (m.custom_points ?? m.points ?? 0) > 0);
  return { pairs, open: Number(w) === Number(snap.state?.week) && !started };
}

const key = (w, pair) => `ph:votes:${w}:${pair}`;
const hgetallToObj = (arr) => {
  const o = {};
  for (let i = 0; i + 1 < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
};

async function tally(w, pairs, voter) {
  const all = await redis(pairs.map((p) => ['HGETALL', key(w, p)]));
  const counts = {}, mine = {};
  pairs.forEach((p, i) => {
    const votes = hgetallToObj(all[i]);
    counts[p] = {};
    for (const pick of Object.values(votes)) counts[p][pick] = (counts[p][pick] || 0) + 1;
    if (voter && votes[voter]) mine[p] = votes[voter];
  });
  return { counts, mine };
}

const validVoter = (v) => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!url() || !token()) {
    return req.method === 'GET' ? res.status(200).json({ enabled: false }) : res.status(503).json({ error: 'Fan voting is not set up yet' });
  }
  try {
    if (req.method === 'GET') {
      const w = Number(req.query?.week);
      if (!Number.isInteger(w) || w < 1 || w > 18) return res.status(400).json({ error: 'Bad week' });
      const voter = validVoter(req.query?.voter) ? req.query.voter : null;
      const wk = await week(w, req);
      return res.status(200).json({ enabled: true, week: w, open: wk.open, ...(await tally(w, wk.pairs, voter)) });
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const w = Number(body.week), pair = String(body.pair || ''), pick = String(body.pick || ''), voter = body.voter;
      if (!Number.isInteger(w) || !validVoter(voter)) return res.status(400).json({ error: 'Bad vote' });
      const wk = await week(w, req);
      if (!wk.pairs.includes(pair) || !pair.split('-').includes(pick)) return res.status(400).json({ error: 'That matchup is not on this week' });
      if (!wk.open) return res.status(409).json({ error: 'Voting is closed: this week has kicked off' });
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
      const net = createHash('sha256').update(`${process.env.VOTE_SALT || 'power-hour'}:${ip}`).digest('hex').slice(0, 20);
      const netKey = `ph:net:${w}:${pair}:${net}`;
      const [already, used] = await redis([['SISMEMBER', netKey, voter], ['SCARD', netKey]]);
      if (!already && used >= MAX_PER_NETWORK) return res.status(429).json({ error: 'This network has already voted on this matchup a few times' });
      await redis([
        ['HSET', key(w, pair), voter, pick], ['EXPIRE', key(w, pair), TTL],
        ['SADD', netKey, voter], ['EXPIRE', netKey, TTL],
      ]);
      return res.status(200).json({ enabled: true, week: w, open: true, ...(await tally(w, wk.pairs, voter)) });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
