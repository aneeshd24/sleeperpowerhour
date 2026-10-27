// The snapshot store: each Sleeper pull is kept in Upstash Redis (the database behind the fan picks) under its clock
// key, so it survives deploys. Vercel empties its CDN cache on every deploy; without this the first visitor after a
// push would make the API read Sleeper again. Node only (api/ functions).
//
// once(name, key, produce): the stored copy if there is one; otherwise one caller takes a short lock, runs produce()
// (the only place Sleeper gets called) and stores what it returns, while any others wait for that copy instead of
// pulling too. produce returns { body, ttl } (ttl in seconds; 0 keeps it out of the store). Without the Redis env vars
// there is no store and produce() runs on each CDN miss, as before.
import { gzipSync, gunzipSync } from 'node:zlib';

const env = (...suffixes) => {
  for (const s of suffixes) {
    const k = Object.keys(process.env).find((n) => n === s || n.endsWith(`_${s}`));
    if (k && process.env[k]) return process.env[k];
  }
};
const url = () => env('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
const token = () => env('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');
export const storeEnabled = () => !!(url() && token());

export async function redis(commands) {
  const r = await fetch(`${url()}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`snapshot store ${r.status}`);
  return (await r.json()).map((x) => {
    if (x.error) throw new Error(x.error);
    return x.result;
  });
}

export const pack = (body) => gzipSync(JSON.stringify(body)).toString('base64');
export const unpack = (s) => JSON.parse(gunzipSync(Buffer.from(s, 'base64')).toString('utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function once(name, key, produce, { wait = 25000 } = {}) {
  if (!storeEnabled()) return { ...(await produce()), from: 'live' };
  const k = `ph:snap:${name}:${key}`, lock = `ph:lock:${name}:${key}`;
  const read = async () => { const [v] = await redis([['GET', k]]); return v ? unpack(v) : null; };
  let hit;
  try { hit = await read(); } catch { return { ...(await produce()), from: 'live' }; } // store down: behave as before
  if (hit) return { body: hit, from: 'store' };
  const [got] = await redis([['SET', lock, '1', 'NX', 'EX', '120']]);
  if (got !== 'OK') {
    // someone else is pulling right now: wait for their copy
    for (let t = 0; t < wait; t += 1500) {
      await sleep(1500);
      const v = await read();
      if (v) return { body: v, from: 'store' };
    }
    throw new Error(`${name} snapshot is still being fetched, try again in a minute`);
  }
  try {
    const out = await produce();
    if (out.ttl > 0) await redis([['SET', k, pack(out.body), 'EX', String(out.ttl)]]);
    return { ...out, from: 'live' };
  } finally {
    await redis([['DEL', lock]]).catch(() => {});
  }
}
