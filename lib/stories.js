// Newsroom for The Power Hour: the daily lead story, the game of the week and a one-liner per matchup.
// Pure functions over the output of computeLeague(); no DOM, runs in the browser and in Node tests.
//
// Every candidate story gets a drama score. Fresh moves (last 48h) and high-stakes games score highest;
// a small date-seeded jitter breaks near-ties so a quiet week still gets a different lead each day.

import { nfl } from './matchup.js';

const pctS = (x) => `${Math.round((x || 0) * 100)}%`;
const f1 = (x) => Number(x || 0).toFixed(1);
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const record = (t) => `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}`;
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
};
const HOUR = 36e5;

// Hand-written puns for players who earn one. A dud without an entry gets a generic line.
const PUNS = {
  'Roschon Johnson': 'Operation: Roschon Impossible',
};
// possessive that reads right after a name ending in s (Burrow my balls' season)
const poss = (name) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
const surname = (name) => name.split(' ').filter((w) => !/^(Jr\.?|Sr\.?|II|III|IV)$/.test(w)).pop();

// ---------- game of the week ----------
// Stakes: combined playoff-odds swing between winning and losing (from the simulation).
// Closeness: 1 at a 50/50 projection, 0 at a lock. Both count about equally.
export function rankMatchups(D) {
  const pv = D.previews || [];
  const maxStakes = Math.max(0.01, ...pv.map((p) => p.stakes || 0));
  return pv
    .map((p, i) => {
      const closeness = 1 - Math.abs(2 * p.winA - 1);
      const stakesNorm = (p.stakes || 0) / maxStakes;
      return { i, p, closeness, stakesNorm, key: 0.55 * stakesNorm + 0.45 * closeness };
    })
    .sort((a, b) => b.key - a.key);
}

export function keyMatchup(D) {
  const top = rankMatchups(D)[0];
  if (!top) return null;
  const { p } = top;
  const A = D.byRid[p.a], B = D.byRid[p.b];
  const margin = Math.abs(p.projA - p.projB);
  const loseA = A.playoffIfLoss ?? A.playoffPct, loseB = B.playoffIfLoss ?? B.playoffPct;
  const winA = A.playoffIfWin ?? A.playoffPct, winB = B.playoffIfWin ?? B.playoffPct;
  const swingA = winA - loseA, swingB = winB - loseB;
  const bigger = swingA >= swingB ? A : B;
  let headline;
  const say = (opts) => opts[Math.floor(hash(`${p.week}${p.a}${p.b}gotw`) * opts.length)];
  if (Math.min(swingA, swingB) >= 0.2) headline = top.closeness >= 0.9
    ? say(['A coin flip with both seasons riding on it. One walks out alive', 'Two seasons enter, one season leaves'])
    : say(['Both seasons ride on this one, and only one survives the night', 'Winner keeps dreaming. Loser starts planning for next year']);
  else if (Math.max(swingA, swingB) >= 0.25) headline = say([`${bigger.name} can't afford to lose this one. Season on the line`, `${poss(bigger.name)} season goes on trial this week`]);
  else if (top.closeness >= 0.85) headline = say([`${f1(margin)} projected points between them. Bring a defibrillator`, `${f1(margin)} points apart and neither one is blinking`]);
  else headline = say(['The game that shakes the standings to their core', 'The standings hold their breath for this one']);
  const deck = `${A.name} goes from ${pctS(loseA)} to ${pctS(winA)} playoff odds depending on how this ends. ` +
    `${B.name} swings from ${pctS(loseB)} to ${pctS(winB)}. ` +
    `The projections split it ${pctS(p.winA)} to ${pctS(1 - p.winA)}.`;
  return { ...top, headline, deck };
}

// ---------- matchup one-liners ----------
export function matchupQuips(D) {
  const usedKeys = new Set(), usedText = new Set();
  const n = D.teams.length;
  return (D.previews || []).map((p) => {
    const A = D.byRid[p.a], B = D.byRid[p.b];
    const fav = p.winA >= 0.5 ? A : B, dog = fav === A ? B : A;
    const fp = Math.max(p.winA, 1 - p.winA);
    const margin = f1(Math.abs(p.projA - p.projB));
    const c = [];
    // text may be a list of variants; the seeded hash picks which one leads
    const add = (key, pri, text) => {
      const v = [].concat(text), k = Math.floor(hash(`${p.week}${p.a}${p.b}${key}v`) * v.length);
      const ids = v.map((text, j) => ({ id: `${key.replace(/\d+$/, '')}#${j}`, text }));
      c.push({ key, pri: pri + 8 * hash(`${p.week}${p.a}${p.b}${key}`), texts: [...ids.slice(k), ...ids.slice(0, k)] });
    };

    if (fp >= 0.74) add('lock', 70, [`${fav.name} is a ${pctS(fp)} favorite. ${dog.name} should enjoy the Sunday anyway.`, `${dog.name} needs a miracle and maybe a power outage. ${fav.name} is a ${pctS(fp)} favorite.`]);
    else if (fp >= 0.66) add('lean', 40, [`${fav.name} by ${margin} on paper. Paper has been wrong before.`, `${dog.name} is the underdog by ${margin}. Underdogs love that.`]);
    if (fp < 0.55) add('flip', 62, [
      `${margin} projected points apart. This comes down to who checks the injury report last.`,
      `A ${pctS(fp)} favorite is not a favorite. Somebody's kicker becomes a hero.`,
      `The model shrugged at this one: ${margin} points between them. Monday night decides it.`,
    ]);
    if ((p.stakes || 0) >= 0.45) {
      const worst = Math.min(A.playoffIfLoss ?? 1, B.playoffIfLoss ?? 1);
      add('stakes', 74, [`Loser's playoff odds drop as low as ${pctS(worst)}. Nobody sleeps Saturday night.`, `Lose this and you're looking at ${pctS(worst)} playoff odds. Set your lineup twice.`]);
    }
    for (const [X, Y] of [[A, B], [B, A]]) {
      if (X.games >= 3 && X.losses === 0 && !X.ties) add(`unbeaten${X.rid}`, 72, `${X.name} is ${record(X)}. ${Y.name} is just the next name on the list.`);
      if (X.games >= 3 && X.wins === 0 && !X.ties) add(`winless${X.rid}`, 60, `${X.name} is ${record(X)}. A win here would at least change the group chat.`);
      if (X.luck >= 1 && Y.luck <= -1) add('luck', 68, `${X.name} has ${f1(X.luck)} more wins than its scores deserve. ${Y.name} has been on the wrong end of that all year.`);
      if (X.wins >= Y.wins + 2 && X.powerRank >= Y.powerRank + 3) add('inversion', 64, `${X.name} has the better record. ${Y.name} has the better team. One of those gets settled this week.`);
      if (X.ranks?.efficiency >= n - 1 && X.leftOnBench != null) add(`bench${X.rid}`, 50, `${X.name} leaves ${f1(X.leftOnBench)} points a week on the bench. Start the right guys and this gets interesting.`);
      const star = (X.injured || [])[0];
      if (star && star.v >= 30) add(`inj${X.rid}`, 55, `${X.name} plays without ${D.helpers.nameOf(star.id)}. Thoughts and prayers to the flex spot.`);
      if (X.games >= 4 && X.form - X.pfPerGame >= 10) add(`hot${X.rid}`, 52, `${X.name} has averaged ${f1(X.form)} the last three weeks and is not slowing down.`);
      if (X.games >= 4 && X.pfPerGame - X.form >= 10) add(`cold${X.rid}`, 52, `${X.name} has averaged ${f1(X.form)} over the last three. The vibes are not immaculate.`);
      if (X.ranks?.pa === 1) add(`pa${X.rid}`, 46, `${X.name} has faced the most points in the league. The schedule isn't done with them yet.`);
    }
    if (A.wins === B.wins && A.losses === B.losses && A.games >= 2) add('mirror', 48, `Two ${record(A)} teams, and only one of them gets out of the middle.`);
    add('default', 10, [`${fav.name} by ${margin} on paper. Somebody has to prove it on the field.`, `${fav.name} is favored. ${dog.name} has the group chat's sympathy, which is worth nothing.`]);

    // best joke whose family hasn't been told yet this week; failing that, any unused wording
    c.sort((x, y) => y.pri - x.pri);
    const family = (x) => x.key.replace(/\d+$/, '');
    const fresh = (x) => x.texts.find((t) => !usedText.has(t.id));
    const pick = c.find((x) => !usedKeys.has(family(x)) && fresh(x)) || c.find(fresh) || c[0];
    const text = fresh(pick) || pick.texts[0];
    usedKeys.add(family(pick));
    usedText.add(text.id);
    return text.text;
  });
}

// ---------- daily lead ----------
// editor: { user, name }, the site's author, whose own blunders always lead (no mercy for the guy who built it)
export function buildStories(D, { now = Date.now(), dateKey = '', editor = null } = {}) {
  const T = (rid) => D.byRid[rid];
  const nameOf = D.helpers.nameOf;
  const n = D.teams.length;
  const hasRos = D.meta.hasRos;
  const out = [];
  const add = (s) => out.push({ ...s, score: s.score + 12 * hash(`${dateKey}${s.type}${(s.rids || []).join()}`) });
  const fresh = (ts) => { const h = (now - ts) / HOUR; return h <= 24 ? 1 : h <= 48 ? 0.85 : h <= 96 ? 0.55 : h <= 168 ? 0.3 : 0; };
  const top = (arr) => [...arr].sort((a, b) => b.v - a.v)[0];
  // the voice of the paper: every headline has a few dramatic takes, and the date picks which one runs
  const drama = (key, opts) => opts[Math.floor(hash(`${dateKey}${key}drama`) * opts.length)];

  // trades
  for (const item of D.feed.filter((f) => f.type === 'trade' && fresh(f.ts) > 0)) {
    const [s1, s2] = item.sides;
    if (!s2) continue;
    const w = s1.net >= s2.net ? s1 : s2, l = w === s1 ? s2 : s1;
    const gap = Math.abs(s1.net - s2.net);
    const gets = (s) => s.adds.map((p) => nameOf(p.id)).join(' and ') || 'draft capital';
    const marquee = top([...s1.adds, ...s2.adds]);
    add({
      type: 'trade', kicker: 'Trade desk', rids: [w.rid, l.rid], tone: 'trade',
      score: (70 + Math.min(30, gap)) * fresh(item.ts),
      headline: hasRos && gap >= 8
        ? drama(`trade${item.ts}`, [
          `Daylight robbery: ${T(w.rid).name} wins the ${marquee ? nameOf(marquee.id) : 'blockbuster'} trade by a mile`,
          `${T(l.rid).name} just got fleeced, and ${T(w.rid).name} is already laughing about it`,
          `Somebody call the commissioner: ${T(w.rid).name} steals ${marquee ? nameOf(marquee.id) : 'the deal'}`])
        : drama(`trade${item.ts}`, [
          `Blockbuster: ${T(s1.rid).name} and ${T(s2.rid).name} pull the trigger`,
          `${T(s1.rid).name} and ${T(s2.rid).name} shake hands and roll the dice on their seasons`]),
      deck: `${T(w.rid).name} lands ${gets(w)}; ${T(l.rid).name} walks away with ${gets(l)}.` +
        (hasRos ? (gap >= 8 ? ` By consensus rest-of-season value that is a ${f1(gap)}-point swing, and ${T(l.rid).name} is on the wrong side of it.` : ` Consensus value calls it close to even, within ${f1(gap)}.`) : ''),
    });
  }

  // waiver splashes, big cuts and flurries
  const recent = D.feed.filter((f) => f.type !== 'trade' && fresh(f.ts) >= 0.85);
  for (const item of recent) {
    const s = item.sides[0];
    const best = top(s.adds), cut = top(s.drops);
    if (best && best.v >= 15) {
      add({
        type: 'wire', kicker: 'Waiver wire', rids: [s.rid], tone: 'good',
        score: (45 + 0.8 * best.v) * fresh(item.ts),
        headline: drama(`wire${best.id}`, [`${T(s.rid).name} pounces on ${nameOf(best.id)} while the league sleeps`, `Waiver heist: ${nameOf(best.id)} is now ${poss(T(s.rid).name)} problem`, `${T(s.rid).name} snatches ${nameOf(best.id)} off the wire. The rest of you blinked`]),
        deck: `${nameOf(best.id)} (${best.pos}) carries a consensus value of ${f1(best.v)}, among the best things that have been sitting on the wire.` +
          (cut ? ` ${nameOf(cut.id)} was the price of admission.` : ''),
      });
    }
    if (cut && cut.v >= 15 && (!best || best.v < cut.v - 8)) {
      add({
        type: 'cut', kicker: 'Waiver wire', rids: [s.rid], tone: 'bad',
        score: (42 + 0.8 * cut.v) * fresh(item.ts),
        headline: drama(`cut${cut.id}`, [`${T(s.rid).name} cuts ${nameOf(cut.id)} loose. No goodbye, no flowers`, `Cold-blooded: ${T(s.rid).name} throws ${nameOf(cut.id)} overboard`]),
        deck: `That is ${f1(cut.v)} of consensus rest-of-season value back on the wire. Whoever is first in waiver priority just got a gift.`,
      });
    }
  }
  const counts = {};
  recent.forEach((f) => f.sides.forEach((s) => (counts[s.rid] = (counts[s.rid] || 0) + 1)));
  for (const [rid, c] of Object.entries(counts)) {
    if (c < 4) continue;
    const net = D.managerMoves[rid]?.net;
    add({
      type: 'flurry', kicker: 'Waiver wire', rids: [Number(rid)], tone: 'neutral',
      score: 48 + 4 * c,
      headline: drama(`flurry${rid}`, [`${T(rid).name} is working the phones like the season depends on it`, `${T(rid).name} has lost all composure on the waiver wire`]),
      deck: `${c} moves in the last two days.${hasRos && net != null ? ` Over the season their moves have ${net >= 0 ? 'added' : 'cost'} ${f1(Math.abs(net))} of consensus value.` : ''}`,
    });
  }

  // the week in progress: who showed up and who didn't in the games already played
  if (D.live) {
    const thursday = D.live.teams.length <= 2;
    const when = thursday ? 'Thursday night' : `week ${D.live.week} so far`;
    const kicker = thursday ? 'Thursday night' : `Week ${D.live.week} so far`;
    const played = D.teams.flatMap((t) => (t.live?.played || []).map((p) => ({ ...p, rid: t.rid, t, name: nameOf(p.id) })));
    const stars = [...played].sort((a, b) => b.pts - a.pts);
    const duds = played.filter((p) => p.proj > 0).sort((a, b) => (a.pts - a.proj) - (b.pts - b.proj));
    const line = (p) => `${p.name} ${f1(p.pts)} for ${p.t.name}`;
    // the editor's own worst starter takes the spot whenever he came up short at all; otherwise the league's biggest miss
    const editorDud = editor && duds.find((p) => p.t.owner === editor.user && (p.pts < p.proj || p.pts < 5));
    const dud = editorDud || (duds[0] && duds[0].proj - duds[0].pts >= 3 ? duds[0] : null);
    if (dud) {
      const mine = dud === editorDud;
      const others = duds.filter((p) => p !== dud && p.proj - p.pts >= 3).slice(0, 2);
      add({
        type: 'dud', kicker, rids: [dud.rid], tone: 'bad',
        score: 70 + 4 * (dud.proj - dud.pts) + (mine ? 60 : 0),
        headline: PUNS[dud.name] || (mine ? `${editor.name} started ${dud.name}. ${surname(dud.name)} did not start back` : drama(`dud${dud.id}`, [`${dud.t.name} trusted ${dud.name}. ${surname(dud.name)} had other plans`, `Betrayal: ${dud.name} leaves ${dud.t.name} for dead`, `${dud.name} just ghosted ${dud.t.name} on the biggest stage`])),
        deck: `${mine ? editor.name : dud.t.name} looked at a full roster and decided ${dud.name} was the guy. He returned ${f1(dud.pts)} points on ${when} ` +
          `against a projection of ${f1(dud.proj)}, which is ${Math.round((100 * dud.pts) / dud.proj)}% of the job.` +
          (mine ? ' This message will self-destruct. The box score will not.' : '') +
          (others.length ? ` Also left in the cold: ${others.map(line).join(', ')}.` : ''),
      });
    }
    const star = stars[0];
    if (star && star.pts >= 15) {
      const rest = stars.slice(1, 3).filter((p) => p.pts >= 12);
      const vs = D.live.teams.length === 2 ? ` in ${nfl(D.live.teams[0])}-${nfl(D.live.teams[1])}` : '';
      add({
        type: 'star', kicker, rids: [star.rid], tone: 'good',
        score: 60 + star.pts + 1.5 * Math.max(0, star.pts - star.proj),
        headline: drama(`star${star.id}`, [`${star.name} goes nuclear for ${f1(star.pts)} and ${star.t.name} is already counting it`, `${star.name} drops ${f1(star.pts)} and ${star.t.name} is screaming from the rooftops`, `Unstoppable: ${star.name} hangs ${f1(star.pts)} for ${star.t.name}`]),
        deck: `${f1(Math.abs(star.pts - star.proj))} ${star.pts >= star.proj ? 'over' : 'under'} his projection${vs}${thursday ? ', banked before anyone else has kicked off' : ''}.` +
          (rest.length ? ` Also cashing in: ${rest.map(line).join(', ')}.` : ''),
      });
    }
  }

  // records and streaks
  for (const t of D.teams) {
    if (t.games >= 3 && t.losses === 0 && !t.ties) {
      add({ type: 'unbeaten', kicker: 'The standings', rids: [t.rid], tone: 'good', score: 50 + 5 * t.games,
        headline: drama(`unbeaten${t.rid}`, [`${t.name} is ${record(t)} and nobody has laid a glove on them`, `${record(t)}. ${t.name} is coming for everyone, and the league is running out of time`, `Fear the ${record(t)} machine: ${t.name} still hasn't lost`]),
        deck: `They'd be ${t.allPlayW.toFixed(0)}-${t.allPlayL.toFixed(0)} playing every team every week and score ${f1(t.pfPerGame)} a game, ${t.ranks.pfPerGame === 1 ? 'the most in the league' : `${ordinal(t.ranks.pfPerGame)}-best`}. The simulations put them in the playoffs ${pctS(t.playoffPct)} of the time.` });
    } else if (t.games >= 3 && t.wins === 0 && !t.ties) {
      add({ type: 'winless', kicker: 'The standings', rids: [t.rid], tone: 'bad', score: 46 + 4 * t.games,
        headline: drama(`winless${t.rid}`, [`${t.name} is ${record(t)} and the walls are closing in`, `Rock bottom: ${t.name} is still looking for win number one`]),
        deck: `${record(t)} with ${f1(t.pfPerGame)} points a game. Playoff odds: ${pctS(t.playoffPct)}.` });
    } else if (t.streak && Number(t.streak.slice(1)) >= 3) {
      const k = Number(t.streak.slice(1)), won = t.streak[0] === 'W';
      add({ type: 'streak', kicker: 'The standings', rids: [t.rid], tone: won ? 'good' : 'bad', score: 36 + 6 * k,
        headline: won
          ? drama(`streak${t.rid}`, [`${t.name} has won ${k} straight and smells blood`, `${k} straight: ${t.name} is on a heater and nobody can cool it off`])
          : drama(`streak${t.rid}`, [`${t.name} has dropped ${k} in a row. Somebody check on them`, `Free fall: ${t.name} has lost ${k} straight`, `${k} losses in a row and ${poss(t.name)} season is on life support`]),
        deck: `${won ? 'The run has' : 'The skid has'} them at ${record(t)} with ${pctS(t.playoffPct)} playoff odds and a power rank of ${t.powerRank}.` });
    }
  }

  // last week: upsets, blowouts, nail-biters, explosions
  const last = D.meta.lastScored;
  const prevRanks = D.history.length > 1 ? D.history[D.history.length - 2].ranks : null;
  const games = D.teams.flatMap((t) => t.weeks.filter((w) => w.week === last && w.result === 'W').map((w) => ({ W: t, L: T(w.opp), w })));
  for (const { W, L, w } of games) {
    const margin = w.pts - w.oppPts;
    const gap = prevRanks ? prevRanks[W.rid] - prevRanks[L.rid] : 0;
    if (gap >= 4) add({ type: 'upset', kicker: `Week ${last} recap`, rids: [W.rid, L.rid], tone: 'neutral', score: 44 + 3 * gap,
      headline: drama(`upset${W.rid}`, [`Shock and awe: ${W.name} stuns ${L.name}`, `${L.name} got ambushed by ${W.name} and will never be the same`, `Nobody saw it coming: ${W.name} takes down ${L.name}`]),
      deck: `The No. ${prevRanks[W.rid]} team in the power rankings beat No. ${prevRanks[L.rid]}, ${f1(w.pts)} to ${f1(w.oppPts)}.` });
    if (margin >= 40) add({ type: 'blowout', kicker: `Week ${last} recap`, rids: [W.rid, L.rid], tone: 'neutral', score: 30 + 0.5 * margin,
      headline: drama(`blowout${W.rid}`, [`${W.name} buries ${L.name} by ${f1(margin)}. There will be no funeral`, `Massacre: ${W.name} beats ${L.name} by ${f1(margin)}`, `${L.name} got erased by ${f1(margin)} points`]),
      deck: `${f1(w.pts)} to ${f1(w.oppPts)}. ${L.name} falls to ${record(L)}.` });
    if (margin < 3) add({ type: 'nailbiter', kicker: `Week ${last} recap`, rids: [W.rid, L.rid], tone: 'neutral', score: 44 + 5 * (3 - margin),
      headline: drama(`nail${W.rid}`, [`${W.name} survives ${L.name} by ${f1(margin)} with its heart in its throat`, `Heartbreak: ${L.name} falls to ${W.name} by ${f1(margin)}`, `${f1(margin)} points. That's how close ${L.name} came`]),
      deck: `${f1(w.pts)} to ${f1(w.oppPts)}. Every bench decision on the losing side is being relitigated.` });
  }
  const wk = D.weekly.find((x) => x.week === last);
  if (wk) {
    const vals = Object.values(wk.scores);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const [rid, pts] = Object.entries(wk.scores).sort((a, b) => b[1] - a[1])[0];
    const z = (pts - avg) / (D.meta.sd || 22);
    if (z >= 1.5) add({ type: 'explosion', kicker: `Week ${last} recap`, rids: [Number(rid)], tone: 'good', score: 30 + 10 * z,
      headline: drama(`boom${rid}`, [`${T(rid).name} drops ${f1(pts)} and the whole league felt it`, `Earthquake: ${T(rid).name} hangs ${f1(pts)} on the league`]),
      deck: `That is ${f1(pts - avg)} above the week ${last} average and the top score of the week.` });
  }

  // power movement
  const climber = [...D.teams].sort((a, b) => b.movement - a.movement)[0];
  if (climber && climber.movement >= 2) add({ type: 'climb', kicker: 'Power rankings', rids: [climber.rid], tone: 'good', score: 34 + 6 * climber.movement,
    headline: drama(`climb${climber.rid}`, [`${climber.name} rockets ${climber.movement} spots to No. ${climber.powerRank}`, `Look out above: ${climber.name} surges to No. ${climber.powerRank}`]),
    deck: `Power score ${f1(climber.score)}, playoff odds ${pctS(climber.playoffPct)}.` });
  const faller = [...D.teams].sort((a, b) => a.movement - b.movement)[0];
  if (faller && faller.movement <= -2) add({ type: 'fall', kicker: 'Power rankings', rids: [faller.rid], tone: 'bad', score: 34 + 6 * -faller.movement,
    headline: drama(`fall${faller.rid}`, [`${faller.name} plummets ${-faller.movement} spots to No. ${faller.powerRank}`, `Collapse: ${faller.name} tumbles to No. ${faller.powerRank}`]),
    deck: `Power score ${f1(faller.score)}, playoff odds ${pctS(faller.playoffPct)}.` });

  // luck and hidden strength
  const unlucky = [...D.teams].sort((a, b) => a.luck - b.luck)[0];
  if (unlucky && unlucky.games >= 3 && unlucky.luck <= -1.2) add({ type: 'unlucky', kicker: 'Nerd lab', rids: [unlucky.rid], tone: 'good', score: 38 + 10 * -unlucky.luck,
    headline: drama(`unlucky${unlucky.rid}`, [`${unlucky.name} is ${record(unlucky)} and the scoreboard is lying`, `The fantasy gods have chosen cruelty: ${unlucky.name} is ${record(unlucky)}`]),
    deck: `Their weekly scores would have gone ${unlucky.allPlayW.toFixed(0)}-${unlucky.allPlayL.toFixed(0)} against the whole league, worth ${f1(unlucky.expectedWins)} wins. They have ${unlucky.wins}.` });
  const lucky = [...D.teams].sort((a, b) => b.luck - a.luck)[0];
  if (lucky && lucky.games >= 3 && lucky.luck >= 1.2) add({ type: 'lucky', kicker: 'Nerd lab', rids: [lucky.rid], tone: 'bad', score: 34 + 9 * lucky.luck,
    headline: drama(`lucky${lucky.rid}`, [`${poss(lucky.name)} ${record(lucky)} is running on borrowed luck`, `${poss(lucky.name)} ${record(lucky)} is a house of cards, and the wind is picking up`]),
    deck: `All-play says they should have ${f1(lucky.expectedWins)} wins. The difference is the biggest in the league, and regression doesn't send a warning.` });
  if (hasRos) {
    const giant = D.teams.find((t) => t.ranks.rosProj <= 3 && t.winPct < 0.5 && t.games >= 3);
    if (giant) add({ type: 'giant', kicker: 'Rest of season', rids: [giant.rid], tone: 'good', score: 46,
      headline: drama(`giant${giant.rid}`, [`${giant.name} has a top-${giant.ranks.rosProj} roster and a ${record(giant)} record. The sleeping giant is waking up`, `Be afraid: ${giant.name} is ${record(giant)} with a top-${giant.ranks.rosProj} roster`]),
      deck: `The best lineup they can field projects for ${f1(giant.rosProj)} a week from here, ${giant.ranks.rosProj === 1 ? 'the most' : `${ordinal(giant.ranks.rosProj)}-most`} in the league. The rest of the league should hope the season runs out first.` });
  }

  // this week's marquee game
  const km = keyMatchup(D);
  if (km) add({ type: 'gotw', kicker: `Week ${km.p.week} preview`, rids: [km.p.a, km.p.b], tone: 'neutral',
    score: 38 + 45 * (km.p.stakes || 0) + 15 * km.closeness,
    headline: `${T(km.p.a).name} vs ${T(km.p.b).name}: ${[T(km.p.a).name, T(km.p.b).name].some((nm) => km.headline.startsWith(nm)) ? km.headline : km.headline.charAt(0).toLowerCase() + km.headline.slice(1)}`,
    deck: km.deck });

  // pick the lead, then up to 3 more with different types and not just the lead's team again
  out.sort((a, b) => b.score - a.score);
  const lead = out[0] || null;
  const more = [];
  const types = new Set(lead ? [lead.type] : []);
  const featured = new Set(lead ? [lead.rids[0]] : []);
  for (const s of out.slice(1)) {
    if (more.length >= 3) break;
    if (types.has(s.type) || featured.has(s.rids[0])) continue;
    types.add(s.type);
    featured.add(s.rids[0]);
    more.push(s);
  }
  return { lead, more, all: out };
}
