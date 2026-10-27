// Trade ideas: search every 1-for-1, 2-for-1 and 1-for-2 swap between one team and the rest of the league,
// keep the ones that make BOTH starting lineups better and are fair by consensus value, then explain them.
// Pure functions over computeLeague() output; no DOM, runs in the browser and in Node tests.
//
// Lineup gain: change in the team's best rest-of-season starting lineup (projected pts/wk), after roster
//   fallout: a side that receives an extra player cuts its lowest-value bench piece; a side that frees a
//   spot adds the best available free agent.
// Fairness: value in minus value out, with each net extra player charged one replacement-level pickup
//   (the same rule the trade ledger uses), must sit inside a band that scales with the size of the deal.

import { bestLineup } from './engine.js';

const SKILL = ['QB', 'RB', 'WR', 'TE'];
const MIN_VALUE = 8;        // players below this are throw-ins, not trade pieces
const MIN_GAIN_ME = 0.3;    // pts/wk the requesting team must gain
const MIN_GAIN_THEM = 0.1;  // pts/wk the partner must gain, unless they win the value side instead
const VALUE_SWEETENER = 3;  // a partner with a flat lineup still says yes if they come out this far ahead on value
const PER_PARTNER = 2;      // keep the list varied
const PER_TARGET = 2;       // don't show the same incoming headliner over and over

const sum = (a) => a.reduce((s, x) => s + x, 0);
const combos2 = (arr) => arr.flatMap((a, i) => arr.slice(i + 1).map((b) => [a, b]));
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

export function tradeIdeas(D, rid, { limit = 12 } = {}) {
  const me = D.byRid[rid];
  if (!me || !D.meta.hasRos) return [];
  // the search asks for the same few hundred players' position, value and projection thousands of times; they're pure
  // lookups, so each is worked out once
  const memo = (f) => { const m = new Map(); return (id) => { if (!m.has(id)) m.set(id, f(id)); return m.get(id); }; };
  const { nameOf } = D.helpers;
  const posOf = memo(D.helpers.posOf), valueOf = memo(D.helpers.valueOf), effWeekly = memo(D.helpers.effWeekly);
  const slots = D.meta.slots, repl = D.meta.replacement || 0, n = D.teams.length;
  const fas = D.freeAgents.filter((f) => SKILL.includes(f.pos)).map((f) => f.id);

  const lineup = (ids) => bestLineup(ids, slots, effWeekly, posOf);
  const groups = (lu) => {
    const g = Object.fromEntries(SKILL.map((p) => [p, 0]));
    for (const l of lu.lineup) if (l.p && g[l.p.pos] != null) g[l.p.pos] += l.p.m;
    return g;
  };
  // league position-group totals today, to rank a team's groups after a trade against everyone else
  const leagueGroups = Object.fromEntries(D.teams.map((t) => [t.rid, groups(lineup(t.players))]));
  const rankAt = (team, pos, val) => 1 + D.teams.filter((t) => t.rid !== team && leagueGroups[t.rid][pos] > val).length;

  // roster after the swap, including the cut or the free-agent pickup it forces
  const after = (players, out, inn) => {
    let ids = players.filter((id) => !out.includes(id)).concat(inn);
    const extra = inn.length - out.length;
    const cut = [], add = [];
    if (extra > 0) {
      const cuttable = ids.filter((id) => !inn.includes(id) && SKILL.includes(posOf(id))).sort((a, b) => valueOf(a) - valueOf(b));
      cut.push(...cuttable.slice(0, extra));
      ids = ids.filter((id) => !cut.includes(id));
    } else if (extra < 0) {
      add.push(...fas.filter((id) => !ids.includes(id)).slice(0, -extra));
      ids = ids.concat(add);
    }
    return { ids, cut, add };
  };

  const pieces = (t) => t.players.filter((id) => SKILL.includes(posOf(id)) && valueOf(id) >= MIN_VALUE);
  const mine = pieces(me);
  const myBase = lineup(me.players), myGroups = groups(myBase);
  const ideas = [];

  for (const them of D.teams) {
    if (them.rid === rid) continue;
    const theirs = pieces(them);
    const theirBase = lineup(them.players), theirGroups = groups(theirBase);
    const shapes = [
      ...mine.flatMap((a) => theirs.map((b) => [[a], [b]])),
      ...combos2(mine).flatMap((pair) => theirs.map((b) => [pair, [b]])),
      ...mine.flatMap((a) => combos2(theirs).map((pair) => [[a], pair])),
    ];
    for (const [give, get] of shapes) {
      const vOut = sum(give.map(valueOf)), vIn = sum(get.map(valueOf));
      const value = vIn - vOut - repl * (get.length - give.length); // my side, over replacement
      const band = Math.max(6, 0.15 * (vIn + vOut) / 2);
      if (Math.abs(value) > band) continue;
      // your side first: most shapes don't help you, and then their lineup never needs working out
      const myAfter = after(me.players, give, get), myLu = lineup(myAfter.ids), gainMe = myLu.total - myBase.total;
      if (gainMe < MIN_GAIN_ME) continue;
      const theirAfter = after(them.players, get, give), theirLu = lineup(theirAfter.ids), gainThem = theirLu.total - theirBase.total;
      if (gainThem < 0) continue;
      if (gainThem < MIN_GAIN_THEM && -value < VALUE_SWEETENER) continue;
      ideas.push({
        partner: them.rid, give, get, value, gainMe, gainThem,
        shape: `${give.length} for ${get.length}`,
        myCut: myAfter.cut, myAdd: myAfter.add, theirCut: theirAfter.cut, theirAdd: theirAfter.add,
        myGroups: groups(myLu), theirGroups: groups(theirLu), myBefore: myGroups, theirBefore: theirGroups,
        // mostly about helping you, but a deal the other side loves is a deal that actually happens
        score: gainMe + 0.6 * gainThem - 0.08 * Math.abs(value),
      });
    }
  }

  ideas.sort((a, b) => b.score - a.score);
  const picked = [], perPartner = {}, perTarget = {};
  for (const idea of ideas) {
    if (picked.length >= limit) break;
    const headliner = [...idea.get].sort((a, b) => valueOf(b) - valueOf(a))[0];
    if ((perPartner[idea.partner] || 0) >= PER_PARTNER || (perTarget[headliner] || 0) >= PER_TARGET) continue;
    perPartner[idea.partner] = (perPartner[idea.partner] || 0) + 1;
    perTarget[headliner] = (perTarget[headliner] || 0) + 1;
    picked.push(idea);
  }

  // explain each idea through the positions of the players changing hands
  const posList = (ids) => [...new Set(ids.map(posOf))];
  const change = (team, before, afterG, p) => ({ p, from: rankAt(team, p, before[p]), to: rankAt(team, p, afterG[p]), d: afterG[p] - before[p] });
  const side = (who, team, before, afterG, inn, out) => {
    const ups = posList(inn).map((p) => change(team, before, afterG, p)).filter((c) => c.d > 0.1);
    const downs = posList(out).filter((p) => !posList(inn).includes(p)).map((p) => change(team, before, afterG, p)).filter((c) => c.to > c.from);
    const up = ups.map((c) => c.to < c.from ? `${c.p} climbs from ${ordinal(c.from)} to ${ordinal(c.to)}` : `${c.p} gains ${c.d.toFixed(1)} pts/wk`).join(' and ');
    const down = downs.map((c) => `${c.p} slips from ${ordinal(c.from)} to ${ordinal(c.to)}`).join(' and ');
    return `${who}: ${up || 'the starting lineup holds steady, so this one is about the value'}${down ? `, while ${down}` : ''}.`;
  };
  return picked.map((idea) => {
    const them = D.byRid[idea.partner];
    const why = [
      side('You', rid, idea.myBefore, idea.myGroups, idea.get, idea.give),
      side(them.name, idea.partner, idea.theirBefore, idea.theirGroups, idea.give, idea.get),
    ];
    if (idea.myCut.length) why.push(`You'd cut ${idea.myCut.map(nameOf).join(' and ')} to make room.`);
    if (idea.myAdd.length) why.push(`Frees a spot for ${idea.myAdd.map(nameOf).join(' and ')} off waivers.`);
    if (idea.theirCut.length) why.push(`They'd cut ${idea.theirCut.map(nameOf).join(' and ')} to make room.`);
    const fair = Math.abs(idea.value) < 2 ? 'Dead even on consensus value.'
      : idea.value > 0 ? `You come out ${idea.value.toFixed(1)} ahead on consensus value, inside a fair margin.`
      : `They come out ${(-idea.value).toFixed(1)} ahead on consensus value, the sweetener that gets it done.`;
    return { ...idea, why, fair };
  });
}
