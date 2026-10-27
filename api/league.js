// GET /api/league — one snapshot of everything the site reads from Sleeper for the league.
//
// The front end asks for /api/league?d=<key>. The key is set by the news clock (lib/newsclock.js): the Central date,
// rolling over at 6am so last night's games are final, plus a "-late" copy after Sunday night football. That is the
// whole Sleeper schedule. Any other key is redirected to the current one, and each snapshot is kept in the store
// (lib/snapstore.js), so the CDN purge on every deploy, odd query strings or many visitors never cause another pull.
import { leagueKey } from '../lib/newsclock.js';
import { once } from '../lib/snapstore.js';

// Your Sleeper league: the number at the end of your league's URL (sleeper.com/leagues/<LEAGUE_ID>/...). Set it here, or
// as the SLEEPER_LEAGUE_ID environment variable in Vercel (that wins if both are set).
const LEAGUE_ID = '1389360536516329472'; // jits and diddles
const SLEEPER = 'https://api.sleeper.app/v1';

async function getJSON(path) {
  const r = await fetch(`${SLEEPER}${path}`);
  if (!r.ok) throw new Error(`Sleeper ${r.status} on ${path}`);
  return r.json();
}

export async function snapshot() {
  const id = process.env.SLEEPER_LEAGUE_ID || LEAGUE_ID;
  if (!/^\d+$/.test(id)) throw new Error('No Sleeper league set up yet: put your league ID in api/league.js or the SLEEPER_LEAGUE_ID environment variable');
  const [state, league, users, rosters] = await Promise.all([
    getJSON('/state/nfl'),
    getJSON(`/league/${id}`),
    getJSON(`/league/${id}/users`),
    getJSON(`/league/${id}/rosters`),
  ]);
  const regEnd = (league.settings?.playoff_week_start || 15) - 1;
  const weeks = Array.from({ length: regEnd }, (_, i) => i + 1);
  const txWeeks = Array.from({ length: Math.max(1, Math.min(18, state.leg || state.week || 1)) }, (_, i) => i + 1);
  const [mus, txs] = await Promise.all([
    Promise.all(weeks.map((w) => getJSON(`/league/${id}/matchups/${w}`).catch(() => []))),
    Promise.all(txWeeks.map((w) => getJSON(`/league/${id}/transactions/${w}`).catch(() => []))),
  ]);
  return {
    fetched: new Date().toISOString(),
    state, league, users, rosters,
    matchups: Object.fromEntries(weeks.map((w, i) => [w, mus[i]])),
    transactions: txs.flat(),
  };
}

const askedKey = (req) => req.query?.d ?? (req.url ? new URL(req.url, 'http://x').searchParams.get('d') : null);

export default async function handler(req, res) {
  try {
    // only the current key is served; anything else redirects to it, so every visitor reads the same snapshot
    const key = leagueKey(), canonical = key;
    const asked = askedKey(req);
    if (req.url && asked !== canonical) {
      // a key that's about to become current (a page whose clock runs a little fast, just before a scheduled pull)
      // mustn't have its redirect to the old snapshot cached, or that URL would serve the old one after the switch
      const soon = leagueKey(new Date(Date.now() + 120000));
      res.setHeader('Cache-Control', soon !== key && String(asked || '') === soon ? 'no-store' : 'public, s-maxage=60');
      res.setHeader('Location', `/api/league?d=${encodeURIComponent(canonical)}`);
      return res.status(307).end();
    }
    // three days in the store: long enough to outlive any deploy, short enough to clean itself up
    const { body, from } = await once('league', key, async () => ({ body: await snapshot(), ttl: 3 * 86400 }));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Snapshot', `${canonical} ${from}`);
    // a key's snapshot never changes (a new pull is a new key), so browsers can keep it too: a second visit within the
    // hour opens without asking for the data again
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600');
    res.status(200).send(JSON.stringify(body));
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
}
