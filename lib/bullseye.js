// Money week side pots: whoever scores closest to a target total (over or under) takes the bonus. Pure, no DOM.
// bullseye(D, { week, target }) → null when it isn't the week (or the week after, for the result), else
// { state: 'soon' | 'upcoming' | 'live' | 'final', week, target, rows: [{ rid, score, banked, dist, side, pWin }] }
// rows run closest first. Before the week is scored, score is the projection (banked points plus the rest projected,
// same numbers as the matchup previews) and pWin is each team's share of simulated weeks in which it lands closest.
export function bullseye(D, { week, target, sims = 20000, seed = 120 }) {
  const upcoming = D.previews[0]?.week ?? null;
  const last = D.meta.lastScored;
  if (week === last) {
    const wk = D.weekly.find((w) => w.week === week);
    if (!wk) return null;
    const rows = Object.entries(wk.scores).map(([rid, s]) => row(Number(rid), s, null, target));
    sort(rows);
    rows.forEach((r, i) => (r.pWin = i === 0 ? 1 : 0));
    return { state: 'final', week, target, rows };
  }
  if (upcoming !== week) return week > (upcoming ?? last) ? { state: 'soon', week, target, rows: [] } : null;

  const sd = D.meta.sd;
  const rows = D.previews.flatMap((p) => [[p.a, p.projA, p.liveA], [p.b, p.projB, p.liveB]])
    .map(([rid, proj, banked]) => ({ ...row(rid, proj, banked, target), sd: D.byRid[rid].sdWeek?.[week] ?? sd }));
  // Monte Carlo: draw every team's week, count who lands nearest the target
  const wins = new Array(rows.length).fill(0);
  const rnd = mulberry(seed);
  const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  for (let s = 0; s < sims; s++) {
    let best = -1, bd = Infinity;
    rows.forEach((r, i) => { const d = Math.abs(Math.max(r.banked || 0, r.score + r.sd * gauss()) - target); if (d < bd) { bd = d; best = i; } });
    wins[best]++;
  }
  rows.forEach((r, i) => (r.pWin = wins[i] / sims));
  sort(rows);
  return { state: rows.some((r) => r.banked) ? 'live' : 'upcoming', week, target, rows };
}

const row = (rid, score, banked, target) => ({ rid, score, banked, dist: Math.abs(score - target), side: score > target ? 'over' : score < target ? 'under' : 'on' });
const sort = (rows) => rows.sort((a, b) => a.dist - b.dist || b.pWin - a.pWin);

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
