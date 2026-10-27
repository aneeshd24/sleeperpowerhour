// Joins ranking-source rows to Sleeper player IDs and blends them into one
// consensus value per player. Runs in Node (the /api/ros function) and in tests.

export const SOURCE_WEIGHTS = { fp: 1, ds: 1, ll: 0.5 }; // LeagueLogs mirrors FantasyPros' consensus closely
export const VALUE_DECAY = 0.0115; // rank 1 = 100, rank ~60 = 50, rank 150 ≈ 18
// Fallback points-per-week curve (fitted on DraftSharks, Oct 2026) used if DraftSharks is unavailable.
const DEFAULT_FIT = {
  QB: { a: 13.79, b: 0.1013 }, RB: { a: 2.44, b: 0.1519 }, WR: { a: 4.89, b: 0.1046 },
  TE: { a: 5.7, b: 0.0914 }, K: { a: 7.69, b: 0.1089 }, DEF: { a: 5.11, b: 0.1314 },
};

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g;
const NICKNAMES = {
  'cameron skattebo': 'cam skattebo',
  'chigoziem okonkwo': 'chig okonkwo',
  'bam knight': 'zonovan knight',
  'kenneth gainwell': 'kenny gainwell',
  'andres borregales': 'andy borregales',
  'hollywood brown': 'marquise brown',
  'christopher brooks': 'chris brooks',
  'cameron ward': 'cam ward',
  'joshua palmer': 'josh palmer',
  'gabriel davis': 'gabe davis',
  'nathaniel dell': 'tank dell',
};

export function normName(name) {
  let s = String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/[.'’`]/g, '')
    .replace(/-/g, ' ')
    .replace(SUFFIX, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return NICKNAMES[s] || s;
}

const POS_OK = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

// players: Sleeper /players/nfl object (or a compact subset) -> lookup indexes
export function buildIndex(players) {
  const byKey = new Map();   // norm|pos -> [ids]
  const byName = new Map();  // norm -> [ids]
  const byLast = new Map();  // last|team|pos -> [ids]
  for (const [id, p] of Object.entries(players)) {
    const pos = p.position;
    if (!POS_OK.has(pos)) continue;
    if (pos === 'DEF') { byKey.set(`def|${id}`, [id]); continue; }
    const full = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`;
    const n = normName(full);
    if (!n) continue;
    const push = (m, k) => { const a = m.get(k); a ? a.push(id) : m.set(k, [id]); };
    push(byKey, `${n}|${pos}`);
    push(byName, n);
    const last = normName(p.last_name || full.split(' ').slice(-1)[0]);
    if (p.team) push(byLast, `${last}|${p.team}|${pos}`);
  }
  return { byKey, byName, byLast, players };
}

// Prefer the candidate who is active and on the expected team.
function pick(ids, idx, team) {
  if (!ids || !ids.length) return null;
  if (ids.length === 1) return ids[0];
  const scored = ids.map((id) => {
    const p = idx.players[id];
    let s = 0;
    if (team && p.team === team) s += 4;
    if (p.active) s += 2;
    if (p.team) s += 1;
    if (p.search_rank != null) s += Math.max(0, 1 - p.search_rank / 2000);
    return [s, id];
  });
  scored.sort((a, b) => b[0] - a[0]);
  return scored[0][1];
}

export function matchRow(row, idx) {
  if (row.pos === 'DEF') return idx.byKey.has(`def|${row.team}`) ? row.team : null;
  const n = normName(row.name);
  const team = row.team && row.team !== 'FA' ? row.team : null;
  let id = pick(idx.byKey.get(`${n}|${row.pos}`), idx, team);
  if (id) return id;
  // Name matched but Sleeper lists a different position (e.g. a WR/RB hybrid)
  const loose = idx.byName.get(n);
  if (loose && loose.length === 1) return loose[0];
  if (team) {
    const last = n.split(' ').slice(-1)[0];
    const ids = idx.byLast.get(`${last}|${team}|${row.pos}`);
    if (ids && ids.length === 1) return ids[0];
  }
  return null;
}

export const rankToValue = (rank) => Math.round(100 * Math.exp(-VALUE_DECAY * (rank - 1)) * 10) / 10;

// sources: { fp: {players:[...]}, ds: {...}, ll: {...} } (any may be missing)
// returns { values: { [sleeperId]: entry }, stats }
export function buildConsensus(sources, idx) {
  const acc = new Map();
  const stats = {};
  for (const [key, src] of Object.entries(sources)) {
    if (!src || !src.players) continue;
    let matched = 0;
    const misses = [];
    for (const row of src.players) {
      const id = matchRow(row, idx);
      if (!id) { misses.push(`${row.name} (${row.pos})`); continue; }
      matched++;
      let e = acc.get(id);
      if (!e) { e = { ranks: {}, pos: row.pos }; acc.set(id, e); }
      if (e.ranks[key] == null || row.rank < e.ranks[key]) e.ranks[key] = row.rank;
      if (key === 'ds') {
        e.wk = row.weekly; e.fl = row.floor; e.cl = row.ceiling;
        e.ir = row.injuryRisk; e.sos = row.sos; e.g = row.games;
      }
    }
    stats[key] = { rows: src.players.length, matched, unmatched: misses.length, sampleMisses: misses.slice(0, 12) };
  }

  const values = {};
  for (const [id, e] of acc) {
    let wsum = 0, vsum = 0;
    for (const [k, r] of Object.entries(e.ranks)) {
      const w = SOURCE_WEIGHTS[k] ?? 1;
      wsum += w; vsum += w * rankToValue(r);
    }
    const rs = Object.values(e.ranks);
    values[id] = {
      v: Math.round((vsum / wsum) * 10) / 10,
      r: e.ranks,
      spread: rs.length > 1 ? Math.max(...rs) - Math.min(...rs) : 0,
      pos: e.pos,
      wk: e.wk ?? null, fl: e.fl ?? null, cl: e.cl ?? null,
      ir: e.ir ?? null, sos: e.sos ?? null, g: e.g ?? null,
    };
  }

  // Fill missing weekly projections with a per-position fit of DraftSharks points vs. consensus value.
  const byPos = {};
  for (const e of Object.values(values)) {
    if (e.wk == null) continue;
    (byPos[e.pos] ||= []).push([e.v, e.wk]);
  }
  const fit = { ...DEFAULT_FIT };
  for (const [pos, pts] of Object.entries(byPos)) {
    if (pts.length < 8) continue;
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n;
    const my = pts.reduce((a, p) => a + p[1], 0) / n;
    let sxy = 0, sxx = 0;
    for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    const b = sxx ? sxy / sxx : 0;
    fit[pos] = { a: my - b * mx, b };
  }
  for (const e of Object.values(values)) {
    if (e.wk == null && fit[e.pos]) {
      e.wk = Math.max(0, Math.round((fit[e.pos].a + fit[e.pos].b * e.v) * 10) / 10);
      e.wkEst = true;
    }
  }

  // Consensus overall + positional ranks
  const sorted = Object.entries(values).sort((a, b) => b[1].v - a[1].v);
  const posCount = {};
  sorted.forEach(([, e], i) => {
    e.rk = i + 1;
    posCount[e.pos] = (posCount[e.pos] || 0) + 1;
    e.prk = posCount[e.pos];
  });
  return { values, stats };
}
