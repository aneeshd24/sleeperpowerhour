// The night desk: the late edition written after Sunday night football, from a fresh snapshot. Pure, no DOM.
//
// By then every Sunday game is final, so any starter whose NFL team hasn't played (and isn't on a bye) plays Monday
// night. Each matchup is either locked (the trailing side's Monday players can't cover the gap even at their
// DraftSharks ceilings, or nobody is left) or still live, in which case Monday night decides it. nightEdition picks
// three: the tightest Monday decider, the most brutal locked game, and the next best of either, with the editor's own
// game swapped in when it's live. Win odds are the previews' (banked points plus the rest, spread shrunk to the slots
// still open), so they match the matchup cards.
import { breakdown } from './matchup.js';

const f1 = (x) => Number(x || 0).toFixed(1);
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

// every matchup, sorted out into locked and Monday-decides (before any games, nothing is locked and everyone is left)
export function nightBoard(D) {
  if (!D.previews.length) return [];
  return D.previews.map((p) => {
    const bd = breakdown(D, p);
    const side = (k) => {
      const t = D.byRid[k === 'a' ? p.a : p.b];
      const left = bd.rows.map((r) => r[k]).filter((x) => x && !x.played && !x.out && !x.bye && x.proj > 0)
        .sort((x, y) => y.proj - x.proj);
      return {
        t, banked: (k === 'a' ? p.liveA : p.liveB) ?? 0, left,
        proj: sum(left.map((x) => x.proj)),
        ceil: sum(left.map((x) => (x.ceil != null && x.ceil > x.proj ? x.ceil : x.proj * 1.7))),
        win: k === 'a' ? p.winA : 1 - p.winA,
      };
    };
    const A = side('a'), B = side('b');
    const [lead, trail] = A.banked >= B.banked ? [A, B] : [B, A];
    const gap = lead.banked - trail.banked;
    // a finished game is decided even when it's dead level (a tie), so Monday night never "decides" it
    const final = !A.left.length && !B.left.length;
    const locked = final || (trail.left.length === 0 ? gap > 0 : gap > trail.ceil || lead.win > 0.985);
    return { p, lead, trail, gap, locked, final };
  });
}

export function nightEdition(D, { dateKey = '', editor = null, people = {} } = {}) {
  const games = nightBoard(D);
  if (!games.length) return null;
  // only once Sunday is done: everyone still to play should come from the Monday night game (two teams, four at most
  // on a doubleheader). More than that means the snapshot is from mid-Sunday, so stay quiet.
  const pending = new Set(games.flatMap((g) => [...g.lead.left, ...g.trail.left].map((x) => x.team)).filter(Boolean));
  if (pending.size > 4) return null;
  const who = (t) => people[t.rid] || t.name;
  const rec = (t, won) => `${t.wins + (won ? 1 : 0)}-${t.losses + (won ? 0 : 1)}${t.ties ? `-${t.ties}` : ''}`;
  const names = (s, n = 2) => and(s.left.slice(0, n).map((x) => x.name));
  const odds = (t, won) => (won ? t.playoffIfWin : t.playoffIfLoss);
  const kicker = 'Sunday night edition';

  const monday = (g) => {
    const { lead: L, trail: T, gap } = g;
    const both = L.left.length > 0;
    const star = T.left[0];
    const k = hash(`${dateKey}${g.p.a}`);
    const headline = gap < 5 && both
      ? pick([`${f1(gap)} points. Monday night. ${who(L.t)} and ${who(T.t)} can't breathe`, `${who(L.t)} and ${who(T.t)} go to Monday night separated by ${f1(gap)}`], k)
      : both
        ? pick([`${who(T.t)} is down ${f1(gap)} and it's all on ${star.name} Monday night`, `Monday night belongs to ${star.name}. ${who(T.t)} needs ${f1(gap)} and a prayer`], k)
        : pick([`${who(T.t)} needs ${f1(gap)} from ${star.name}. ${who(L.t)} can only watch`, `${who(L.t)} is out of bullets. ${star.name} has ${f1(gap)} points to steal it for ${who(T.t)}`], k);
    const stakes = odds(T.t, true) != null ? ` A win sends ${T.t.name} to ${pct(odds(T.t, true))} playoff odds; a loss drops them to ${pct(odds(T.t, false))}.` : '';
    const deck = `${L.t.name} leads ${f1(L.banked)} to ${f1(T.banked)}. ` +
      (both
        ? `Still to play Monday: ${names(T)} for ${T.t.name} (${f1(T.proj)} projected) against ${names(L)} for ${L.t.name} (${f1(L.proj)}). `
        : `${L.t.name} has nobody left. ${T.t.name} has ${names(T)}, projected for ${f1(T.proj)}. `) +
      `${T.t.name} wins this ${pct(T.win)} of the time.${stakes}`;
    return { type: 'monday', kicker, tone: 'neutral', stamp: 'Monday', rids: [T.t.rid, L.t.rid], headline, deck: deck.trim() };
  };

  const done = (g) => {
    const { lead: W, trail: X, gap } = g;
    const upset = W.t.powerRank - X.t.powerRank >= 4;
    const k = hash(`${dateKey}${g.p.b}`);
    if (g.final && !gap) {
      return { type: 'locked', kicker, tone: 'neutral', stamp: 'Tie', rids: [W.t.rid, X.t.rid],
        headline: pick([`Dead even: ${who(W.t)} and ${who(X.t)} finish level at ${f1(W.banked)}`, `Nobody blinked. ${who(W.t)} and ${who(X.t)} tie at ${f1(W.banked)}`], k),
        deck: `${W.t.name} and ${X.t.name} both finished on ${f1(W.banked)}. A tie goes in the books for both.` };
    }
    const headline = gap >= 40
      ? pick([`${who(X.t)} got buried. ${who(W.t)} wins by ${f1(gap)}`, `Call the coroner: ${who(W.t)} is up ${f1(gap)} on ${who(X.t)}`], k)
      : upset
        ? pick([`Upset in the books: ${who(W.t)} took down ${who(X.t)}`, `No. ${W.t.powerRank} just mugged No. ${X.t.powerRank}. ${who(X.t)} has no answer`], k)
        : pick([`It's over for ${who(X.t)}. ${who(W.t)} already locked it up`, `${who(X.t)} is done, and Monday night can't save them`], k);
    const deck = `${W.t.name} ${g.final ? 'beat' : 'leads'} ${X.t.name} ${f1(W.banked)} to ${f1(X.banked)}. ` +
      (X.left.length
        ? `${X.t.name} still has ${names(X)} on Monday, ${f1(X.ceil)} points at their absolute best, and needs ${f1(gap)}. Not happening. `
        : `${X.t.name} has nobody left to play. `) +
      `That's ${rec(W.t, true)} for ${W.t.name} and ${rec(X.t, false)} for ${X.t.name}.`;
    return { type: 'locked', kicker, tone: gap >= 40 ? 'bad' : 'good', stamp: g.final ? 'Final' : 'Locked', rids: [W.t.rid, X.t.rid], headline, deck };
  };

  const live = games.filter((g) => !g.locked).sort((a, b) => Math.abs(a.trail.win - 0.5) - Math.abs(b.trail.win - 0.5));
  const locked = games.filter((g) => g.locked).sort((a, b) => b.gap - a.gap);
  const chosen = [live[0], locked[0], live[1] || locked[1], locked[1], live[2], locked[2]].filter(Boolean);
  const out = [...new Set(chosen)].slice(0, 3);
  // the editor's own game always makes the night edition when Monday still decides it
  const mine = editor && live.find((g) => [g.lead, g.trail].some((s) => s.t.owner === editor.user));
  if (mine && !out.includes(mine)) out[out.length - 1] = mine;
  return out.map((g) => (g.locked ? done(g) : monday(g)));
}
