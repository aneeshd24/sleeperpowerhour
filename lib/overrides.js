// Manual projection patches for players the ranking sources haven't caught up with (fresh signings etc.).
// A patch only applies while the consensus has no weekly projection for that player, so it retires itself
// once the sources list them. Delete the entry after that happens.
//
// wk is copied across every remaining week (no games discount). v is scaled from the lowest-valued
// player at the same position that does have a projection, so trade and waiver deltas stay sensible.

export const OVERRIDES = {
  // 1433: { pos: 'K', wk: 6.5, note: 'Player name: weekly projection set by hand until the rankings list him' },
};

export function applyOverrides(values, overrides = OVERRIDES) {
  const out = { ...values };
  const applied = [];
  for (const [id, o] of Object.entries(overrides)) {
    if (out[id] && out[id].wk) continue;
    const peers = Object.values(values).filter((r) => r.pos === o.pos && r.wk && r.v != null);
    const floor = peers.sort((a, b) => a.v - b.v)[0];
    const v = floor ? Math.round(floor.v * Math.min(1, o.wk / floor.wk) * 10) / 10 : 0;
    const base = { r: {}, spread: 0, fl: null, cl: null, ir: null, sos: null, rk: null, prk: null, ...out[id] };
    out[id] = { ...base, v: base.v || v, pos: o.pos, wk: o.wk, g: null, wkEst: true, manual: true };
    applied.push({ id, note: o.note });
  }
  return { values: out, applied };
}
