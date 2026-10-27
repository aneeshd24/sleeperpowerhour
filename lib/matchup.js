// Matchup breakdown: both starting lineups slot by slot, where the game is won, and what to watch.
// Pure functions over computeLeague() output; no DOM, runs in the browser and in Node tests.
//
// Lineups are the starters each manager has set in Sleeper for this week; if a team hasn't set one, its best
// projected lineup stands in. Player projections are DraftSharks rest-of-season weekly averages (zero when ruled
// out), floor and ceiling come from DraftSharks too, injury status from Sleeper. Once a player's game is done
// (week in progress) his actual points replace the projection and he is locked where he is.

import { bestLineup } from './engine.js';

const FIXED = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const ELIGIBLE = { FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'] };
export const fits = (slot, pos) => (ELIGIBLE[slot] || [slot]).includes(pos);
const GROUPS = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
const groupOf = (slot) => (FIXED.includes(slot) ? slot : 'FLEX');
const f1 = (x) => Number(x || 0).toFixed(1);
const list = (a) => (a.length < 3 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

const NFL = {
  ARI: 'Cardinals', ATL: 'Falcons', BAL: 'Ravens', BUF: 'Bills', CAR: 'Panthers', CHI: 'Bears', CIN: 'Bengals', CLE: 'Browns',
  DAL: 'Cowboys', DEN: 'Broncos', DET: 'Lions', GB: 'Packers', HOU: 'Texans', IND: 'Colts', JAX: 'Jaguars', KC: 'Chiefs',
  LAC: 'Chargers', LAR: 'Rams', LV: 'Raiders', MIA: 'Dolphins', MIN: 'Vikings', NE: 'Patriots', NO: 'Saints', NYG: 'Giants',
  NYJ: 'Jets', PHI: 'Eagles', PIT: 'Steelers', SEA: 'Seahawks', SF: '49ers', TB: 'Buccaneers', TEN: 'Titans', WAS: 'Commanders',
};
export const nfl = (abbr) => NFL[abbr] || abbr;

export function breakdown(D, pv) {
  const { player, posOf, liveProj: thisWeekProj, hasPlayed } = D.helpers;
  const slots = D.meta.slots;
  const A = D.byRid[pv.a], B = D.byRid[pv.b];

  // lineup in slot order: the one set in Sleeper, or the best projected one if it hasn't been set
  const lineupFor = (t, set) => {
    if (set.length === slots.length && set.some((id) => id && id !== '0')) {
      return { source: 'set', ids: set.map((id) => (id && id !== '0' ? id : null)) };
    }
    const pool = bestLineup(t.players, slots, thisWeekProj, posOf).lineup.filter((l) => l.p);
    return { source: 'projected', ids: slots.map((s) => { const k = pool.findIndex((l) => l.slot === s); return k < 0 ? null : pool.splice(k, 1)[0].p.id; }) };
  };
  const lu = { a: lineupFor(A, pv.startersA || []), b: lineupFor(B, pv.startersB || []) };

  const rows = slots.map((slot, i) => {
    const a = player(lu.a.ids[i]), b = player(lu.b.ids[i]);
    return { slot, group: groupOf(slot), a, b, edge: (a?.proj || 0) - (b?.proj || 0) };
  });
  const totals = { a: rows.reduce((s, r) => s + (r.a?.proj || 0), 0), b: rows.reduce((s, r) => s + (r.b?.proj || 0), 0) };
  const groups = GROUPS.map((key) => {
    const rs = rows.filter((r) => r.group === key);
    return rs.length ? { key, edge: rs.reduce((s, r) => s + r.edge, 0), rows: rs } : null;
  }).filter(Boolean);

  // Points a manager leaves on the table: repeatedly make the single best legal swap of a bench player into a
  // slot he can fill (players on a bye or ruled out project zero, so they're never suggested; players whose game
  // is over can't move in or out).
  const fixes = (t, l) => {
    if (l.source !== 'set') return null;
    const ids = [...l.ids];
    const bench = t.players.filter((id) => !ids.includes(id) && !hasPlayed(id) && thisWeekProj(id) > 0);
    const swaps = [];
    for (let n = 0; n < 4; n++) {
      let best = null;
      ids.forEach((sid, i) => {
        if (sid && hasPlayed(sid)) return;
        const cur = sid ? thisWeekProj(sid) : 0;
        for (const b of bench) {
          const g = thisWeekProj(b) - cur;
          if (fits(slots[i], posOf(b)) && g >= 0.5 && (!best || g > best.g)) best = { i, b, g };
        }
      });
      if (!best) break;
      const out = ids[best.i];
      swaps.push({ in: player(best.b), out: out ? player(out) : null, gain: best.g, slot: slots[best.i] });
      ids[best.i] = best.b;
      bench.splice(bench.indexOf(best.b), 1);
      if (out && thisWeekProj(out) > 0) bench.push(out);
    }
    const gain = swaps.reduce((a, x) => a + x.gain, 0);
    return gain >= 1 ? { gain, swaps } : null;
  };

  const watch = [];
  // names like "Odell Beckham Jr." would otherwise end a sentence with ".."
  const add = (pri, tone, text) => watch.push({ pri, tone, text: text.replace(/\.\.(?!\.)/g, '.') });
  const name = { a: A.name, b: B.name };
  for (const k of ['a', 'b']) {
    const t = k === 'a' ? A : B, mine = rows.map((r) => r[k]).filter(Boolean), fx = fixes(t, lu[k]);
    const fillIn = (p) => fx?.swaps.find((s) => s.out?.id === p.id)?.in;
    for (const p of mine.filter((x) => !x.played && (x.out || x.bye))) {
      const sub = fillIn(p), why = p.bye ? `on a bye (${nfl(p.team)})` : `listed ${p.status}`;
      add(100, k, `${p.name} is ${why} but still in ${t.name}'s lineup, a guaranteed zero.${sub ? ` Starting ${sub.name} instead is worth ${f1(sub.proj)}.` : ''}`);
    }
    if (lu[k].source === 'set') rows.forEach((r, i) => {
      if (r[k]) return;
      const sub = fx?.swaps.find((s) => !s.out && s.slot === r.slot)?.in;
      add(100, k, `${t.name} has nobody in the ${r.slot} slot.${sub ? ` ${sub.name} (${f1(sub.proj)}) is sitting on the bench.` : ''}`);
    });
    const swaps = (fx?.swaps || []).filter((s) => s.out && !s.out.out && !s.out.bye).sort((x, y) => y.gain - x.gain).slice(0, 2);
    if (swaps.length) add(90, k, `${t.name} can add ${f1(swaps.reduce((a, x) => a + x.gain, 0))} projected points: start ${list(swaps.map((s) => `${s.in.name} over ${s.out.name}`))}.`);
    for (const p of mine.filter((x) => !x.played && x.status === 'Doubtful')) add(85, k, `${p.name} is doubtful, and ${f1(p.proj)} of ${t.name}'s projected points ride on him playing.`);
    const q = mine.filter((x) => !x.played && x.status === 'Questionable');
    if (q.length) add(60, k, `Questionable for ${t.name}: ${list(q.map((x) => x.name))}. Worth a look before kickoff.`);
    const form = t.form - t.pfPerGame;
    if (t.games >= 4 && Math.abs(form) >= 10) add(35, k, `${t.name} has averaged ${f1(t.form)} the last three weeks, ${f1(Math.abs(form))} ${form > 0 ? 'above' : 'below'} their season pace.`);
  }

  // where each side wins it
  for (const k of ['a', 'b']) {
    const sign = k === 'a' ? 1 : -1;
    const g = [...groups].sort((x, y) => sign * (y.edge - x.edge))[0];
    if (!g || sign * g.edge < 1) continue;
    const r = [...g.rows].sort((x, y) => sign * (y.edge - x.edge))[0];
    const me = r[k], them = r[k === 'a' ? 'b' : 'a'];
    add(70, k, `${name[k]}'s biggest edge is at ${g.key} (+${f1(sign * g.edge)})${me && them ? `, led by ${me.name} ${f1(me.proj)} against ${them.name} ${f1(them.proj)}` : ''}.`);
  }
  const diff = totals.a - totals.b;
  if (Math.abs(diff) < 4) add(65, 'n', `The starters project within ${f1(Math.abs(diff))} points of each other. One lineup call could decide it.`);
  else if (Math.abs(diff) >= 15) {
    const dog = diff > 0 ? 'b' : 'a';
    const hope = rows.map((r) => r[dog]).filter((p) => p?.ceil != null).sort((x, y) => y.ceil - x.ceil)[0];
    add(55, dog, `${name[dog]}'s starters trail by ${f1(Math.abs(diff))}.${hope ? ` They need a ceiling game from ${hope.name}, who tops out around ${f1(hope.ceil)}.` : ''}`);
  }

  // the most boom-or-bust starter on the field
  const swing = ['a', 'b'].flatMap((k) => rows.map((r) => r[k] && { k, p: r[k] })).filter((x) => x && !x.p.played && x.p.floor != null && x.p.ceil != null && x.p.proj > 0)
    .sort((x, y) => (y.p.ceil - y.p.floor) - (x.p.ceil - x.p.floor))[0];
  if (swing && swing.p.ceil - swing.p.floor >= 10) add(50, swing.k, `Swing player: ${swing.p.name} projects ${f1(swing.p.proj)} for ${name[swing.k]}, anywhere from ${f1(swing.p.floor)} to ${f1(swing.p.ceil)}.`);

  // stacks: a QB with his own pass catchers
  for (const k of ['a', 'b']) {
    const mine = rows.map((r) => r[k]).filter(Boolean);
    const qb = mine.find((p) => p.pos === 'QB');
    const mates = qb ? mine.filter((p) => p.team === qb.team && (p.pos === 'WR' || p.pos === 'TE')) : [];
    if (mates.length) add(45, k, `${name[k]} is stacking ${qb.name} with ${list(mates.map((p) => p.name))}: a big ${nfl(qb.team)} day pays twice.`);
  }
  // both sides leaning on the same NFL offense
  const teamsA = new Map(rows.filter((r) => r.a && r.a.pos !== 'DEF' && r.a.team).map((r) => [r.a.team, r.a]));
  const shared = rows.map((r) => r.b).find((p) => p && p.pos !== 'DEF' && teamsA.has(p.team));
  if (shared) add(40, 'n', `Both lineups lean on the ${nfl(shared.team)}: ${teamsA.get(shared.team).name} for ${A.name}, ${shared.name} for ${B.name}.`);

  watch.sort((x, y) => y.pri - x.pri);
  return { source: { a: lu.a.source, b: lu.b.source }, rows, totals, groups, watch: watch.slice(0, 6) };
}

// "J. Chase", "A. St. Brown"; defenses keep the nickname ("Browns")
export function shortName(p) {
  if (!p) return '';
  if (p.pos === 'DEF') return p.name.split(' ').pop();
  const [first, ...rest] = p.name.split(' ');
  return rest.length ? `${first[0]}. ${rest.join(' ')}` : first;
}
