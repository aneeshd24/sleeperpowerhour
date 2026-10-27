// /api/poll — one-question fan polls on the power rankings page, one vote per device and no changing it.
//
//   GET  /api/poll?id=w7-bottom6&device=<id>          -> { enabled, id, device, options: [rid…] | null, counts, total, mine }
//   POST /api/poll { id, pick, options, device }      -> same shape after recording the vote; 409 if this device voted
//
// One vote per device, so people sharing Wi-Fi each get their own. A device is a random id the server hands out and
// keeps in two places: an HttpOnly cookie (ph_dev) and the page's localStorage (ph-device), sent back with each call.
// Clearing one restores it from the other, and a vote under either id counts as voted. The first vote is final.
// Clearing both (or a private window) makes a new device, so each network (hashed IP, never stored raw) is capped at
// MAX_PER_NETWORK devices per poll: enough for a household or a bar, not enough to stuff the ballot.
//
// The choices (roster ids) come from the page, which works them out from the rankings; the first vote freezes them, so
// a later reshuffle of the rankings (the morning refresh) can't move a team out from under its votes. Only polls
// listed in POLLS are accepted. Storage is the Upstash store (lib/snapstore.js); without it GET answers
// { enabled: false } and the page hides the poll.
import { createHash, randomUUID } from 'node:crypto';
import { redis, storeEnabled } from '../lib/snapstore.js';

const POLLS = { 'w7-bottom6': { size: 6 } };
const TTL = 60 * 60 * 24 * 120;
const LEAGUE_SIZE = 12;
const MAX_PER_NETWORK = 4;

const k = (id, part) => `ph:poll:${id}:${part}`;
const ipHash = (req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  return createHash('sha256').update(`${process.env.VOTE_SALT || 'power-hour'}:${ip}`).digest('hex').slice(0, 20);
};
const validDevice = (v) => typeof v === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(v);
const cookieDevice = (req) => (/(?:^|;\s*)ph_dev=([A-Za-z0-9-]{16,64})/.exec(req.headers.cookie || '') || [])[1] || null;
// this caller's device ids: the cookie's and the page's (normally the same), handing out a new one if neither exists
function deviceOf(req, res, given) {
  const c = cookieDevice(req), g = validDevice(given) ? given : null, primary = c || g || randomUUID();
  if (!c) res.setHeader('Set-Cookie', `ph_dev=${primary}; Path=/; Max-Age=${TTL}; SameSite=Lax; Secure; HttpOnly`);
  return { primary, ids: [...new Set([primary, c, g].filter(Boolean))] };
}
const pairs = (arr) => { const o = {}; for (let i = 0; i + 1 < (arr || []).length; i += 2) o[arr[i]] = Number(arr[i + 1]); return o; };

async function state(id, dev) {
  const [opts, counts, ...mine] = await redis([['GET', k(id, 'options')], ['HGETALL', k(id, 'counts')], ...dev.ids.map((d) => ['GET', k(id, `dev:${d}`)])]);
  const c = pairs(counts), m = mine.find((x) => x != null);
  return { enabled: true, id, device: dev.primary, options: opts ? JSON.parse(opts) : null, counts: c, total: Object.values(c).reduce((a, b) => a + b, 0), mine: m != null ? Number(m) : null };
}

const validOptions = (o, size) => Array.isArray(o) && o.length === size && new Set(o).size === size
  && o.every((x) => Number.isInteger(x) && x >= 1 && x <= LEAGUE_SIZE);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!storeEnabled()) return req.method === 'GET' ? res.status(200).json({ enabled: false }) : res.status(503).json({ error: 'Polls are not set up yet' });
  try {
    const body = req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}) : {};
    const id = String((req.method === 'GET' ? req.query?.id : body.id) || '');
    const poll = POLLS[id];
    if (!poll) return res.status(404).json({ error: 'No such poll' });
    const dev = deviceOf(req, res, req.method === 'GET' ? req.query?.device : body.device);
    if (req.method === 'GET') return res.status(200).json(await state(id, dev));
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed' }); }

    const pick = Number(body.pick);
    // the first vote freezes the choices; after that the page's list is ignored
    if (validOptions(body.options, poll.size)) await redis([['SET', k(id, 'options'), JSON.stringify(body.options), 'NX', 'EX', String(TTL)]]);
    const [frozen] = await redis([['GET', k(id, 'options')]]);
    const options = frozen ? JSON.parse(frozen) : null;
    if (!options) return res.status(400).json({ error: 'Bad poll choices' });
    if (!options.includes(pick)) return res.status(400).json({ error: 'That team is not in this poll' });
    const now = await state(id, dev);
    if (now.mine != null) return res.status(409).json({ error: 'You already voted in this poll', ...now });
    const netKey = k(id, `net:${ipHash(req)}`);
    const [used] = await redis([['SCARD', netKey]]);
    if (used >= MAX_PER_NETWORK) return res.status(429).json({ error: `${MAX_PER_NETWORK} devices on this network have already voted`, ...now });
    // one vote per device, set only if absent, so two quick taps can't both count
    const [ok] = await redis([['SET', k(id, `dev:${dev.primary}`), String(pick), 'NX', 'EX', String(TTL)]]);
    if (ok !== 'OK') return res.status(409).json({ error: 'You already voted in this poll', ...(await state(id, dev)) });
    await redis([
      ...dev.ids.filter((d) => d !== dev.primary).map((d) => ['SET', k(id, `dev:${d}`), String(pick), 'EX', String(TTL)]),
      ['SADD', netKey, dev.primary], ['EXPIRE', netKey, String(TTL)],
      ['HINCRBY', k(id, 'counts'), String(pick), '1'], ['EXPIRE', k(id, 'counts'), String(TTL)],
    ]);
    return res.status(200).json(await state(id, dev));
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
