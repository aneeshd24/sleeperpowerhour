// The Power Hour ranking engine. Pure functions, no DOM: runs in the browser and in Node tests.
//
// Inputs are raw Sleeper API objects plus the consensus ROS map from /api/ros:
//   league, users, rosters, matchups {week: [...]}, transactions [...], players {id: {n,p,t,i}},
//   ros {id: {v, wk, ...}}, currentWeek
//
// Power score, in order of priority: where you sit in the real standings (40%), how much you score (28%), how hard
// the rest of your schedule is (17%), and your rest-of-season roster (15%). Each input is z-scored across the 12 teams;
// score = 50 + 22 * weighted z. One formula for everyone: input.weights exists only for scripts and tests.
export const WEIGHTS = {
  // standing (40%)
  standing: 0.31,  // place in the actual standings: wins (ties half), then points for, like Sleeper's table
  winPct: 0.09,    // the record itself, so a two-game gap counts for more than a tiebreak
  // scoring (28%)
  pfPerGame: 0.20, // points for per game
  allPlay: 0.04,   // all-play win % (record if you played everyone every week)
  form: 0.04,      // average of the last 3 weeks
  // schedule (17%)
  sos: 0.17,       // schedule wins: expected wins vs actual remaining opponents minus vs an average slate
  // roster (15%)
  rosProj: 0.13,   // projected weekly points of the best ROS starting lineup
  depth: 0.02,     // value of the best bench pieces
};
// the four parts shown on each ranking row (lastWeek is still accepted as a scoring input)
export const PARTS = {
  standing: ['standing', 'winPct'],
  scoring: ['pfPerGame', 'allPlay', 'form', 'lastWeek'],
  schedule: ['sos'],
  roster: ['rosProj', 'depth'],
};
const ROS_KEYS = ['rosProj', 'depth'];
const SOS_KEYS = ['sos'];

const FLEX_ELIGIBLE = {
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};
const FIXED = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const BENCH_POS = ['QB', 'RB', 'WR', 'TE'];
const OUT_STATUSES = new Set(['IR', 'Out', 'PUP', 'Sus', 'Suspended', 'NA', 'DNR', 'COV']);

const round = (x, d = 1) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const zscores = (arr) => {
  const m = mean(arr), s = std(arr) || 1;
  return arr.map((x) => (x - m) / s);
};
const rankDesc = (arr) => {
  const order = arr.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const r = new Array(arr.length);
  order.forEach(([, i], k) => (r[i] = k + 1));
  return r;
};
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// ---------- lineup optimisation ----------
// Greedy fill: fixed slots first, then flex slots. Optimal for standard Sleeper slot structures.
export function bestLineup(playerIds, slots, metric, posOf) {
  const pool = playerIds
    .map((id) => ({ id, pos: posOf(id), m: metric(id) }))
    .filter((p) => p.pos && p.m != null)
    .sort((a, b) => b.m - a.m);
  const used = new Set();
  const lineup = [];
  const take = (eligible) => {
    const p = pool.find((x) => !used.has(x.id) && eligible.includes(x.pos));
    if (p) used.add(p.id);
    return p || null;
  };
  for (const s of slots.filter((s) => FIXED.includes(s))) lineup.push({ slot: s, p: take([s]) });
  for (const s of slots.filter((s) => FLEX_ELIGIBLE[s])) lineup.push({ slot: s, p: take(FLEX_ELIGIBLE[s]) });
  const total = lineup.reduce((a, l) => a + (l.p ? l.p.m : 0), 0);
  const bench = pool.filter((p) => !used.has(p.id));
  return { lineup, total, bench };
}

// ---------- main ----------
export function computeLeague(input) {
  const { league, users, rosters, matchups, transactions = [], players = {}, ros = {}, byes = {}, currentWeek } = input;
  const settings = league.settings || {};
  const slots = (league.roster_positions || []).filter((s) => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
  const lastScored = input.lastScored ?? settings.last_scored_leg ?? Math.max(0, (currentWeek || 1) - 1);
  const regEnd = (settings.playoff_week_start || 15) - 1;
  const playoffTeams = settings.playoff_teams || 6;
  const hasRos = Object.keys(ros).length > 0;

  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const posOf = (id) => ros[id]?.pos || players[id]?.p || (id && /^[A-Z]{2,3}$/.test(id) ? 'DEF' : null);
  const nameOf = (id) => players[id]?.n || (ros[id] && ros[id].n) || (/^[A-Z]{2,3}$/.test(id) ? `${id} D/ST` : `Player ${id}`);
  const statusOf = (id) => players[id]?.i || null;
  const valueOf = (id) => ros[id]?.v ?? 0;
  // ---- player projections, bye-aware ----
  const NFL_WEEKS = 18;
  const upcoming = lastScored + 1;
  const nflTeamOf = (id) => players[id]?.t || (/^[A-Z]{2,3}$/.test(id) ? id : null);
  const byeOf = (id) => byes[nflTeamOf(id)] || null;
  // DraftSharks' projected games left, as a share of the games a healthy player has left (byes excluded)
  const health = (id) => {
    const g = ros[id]?.g;
    if (g == null) return 1;
    const b = byeOf(id);
    return Math.min(1, g / Math.max(1, NFL_WEEKS - upcoming + 1 - (b && b >= upcoming ? 1 : 0)));
  };
  const perGame = (id) => (ros[id]?.wk ?? 0) * health(id);
  // this week: ruled out or on a bye scores nothing
  const thisWeekProj = (id) => (OUT_STATUSES.has(statusOf(id)) || byeOf(id) === upcoming ? 0 : ros[id]?.wk ?? 0);
  // any later week: zero on that week's bye, otherwise the injury-discounted weekly average
  const weekProj = (id, w) => (w === upcoming ? thisWeekProj(id) : byeOf(id) === w ? 0 : perGame(id));
  // The week in progress (e.g. after Thursday night): an NFL team has played once any rostered player of theirs has
  // a non-zero score this week. Their players' points are final for the week and locked in or out of lineups.
  const liveRows = matchups[upcoming] || [];
  const livePts = Object.assign({}, ...liveRows.map((m) => m.players_points || {}));
  const playedTeams = new Set(Object.entries(livePts).filter(([, v]) => v).map(([id]) => nflTeamOf(id)).filter(Boolean));
  const hasPlayed = (id) => playedTeams.has(nflTeamOf(id));
  // this week as it stands: actual points once a player's game is done, the projection until then
  const liveProj = (id) => (hasPlayed(id) ? livePts[id] ?? 0 : thisWeekProj(id));
  // rest-of-season average per week: a bye still to come costs its share of the remaining regular season
  const regLeft = Math.max(0, regEnd - upcoming + 1);
  const effWeekly = (id) => {
    const b = byeOf(id);
    return perGame(id) * (regLeft && b >= upcoming && b <= regEnd ? (regLeft - 1) / regLeft : 1);
  };
  // weeks to project: the rest of the regular season plus the playoff rounds
  const playoffStart = regEnd + 1;
  const rounds = { 4: 2, 6: 3, 8: 3 }[playoffTeams] || 0;
  const simWeeks = [];
  for (let w = upcoming; w <= (rounds ? playoffStart + rounds - 1 : regEnd); w++) simWeeks.push(w);
  // everything the matchup breakdown shows about one player
  const playerInfo = (id) => {
    if (!id || id === '0') return null;
    const r = ros[id] || {};
    return {
      id, name: nameOf(id), pos: posOf(id), team: nflTeamOf(id),
      status: statusOf(id), out: OUT_STATUSES.has(statusOf(id)), bye: byeOf(id) === upcoming, proj: liveProj(id), floor: r.fl ?? null, ceil: r.cl ?? null,
      played: hasPlayed(id), pre: thisWeekProj(id),
    };
  };

  // ---- teams ----
  const teams = rosters.map((r) => {
    const u = userById[r.owner_id] || {};
    const s = r.settings || {};
    return {
      rid: r.roster_id,
      ownerId: r.owner_id,
      owner: u.display_name || 'Unclaimed',
      name: (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`,
      avatar: u.avatar || null,
      // the team picture set in Sleeper's team settings (a full sleepercdn URL), when the manager uploaded one
      teamPhoto: (u.metadata && /^https:\/\/sleepercdn\.com\//.test(u.metadata.avatar || '') && u.metadata.avatar) || null,
      players: r.players || [],
      starters: r.starters || [],
      reserve: r.reserve || [],
      wins: s.wins || 0,
      losses: s.losses || 0,
      ties: s.ties || 0,
      pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      pa: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
      maxPf: (s.ppts || 0) + (s.ppts_decimal || 0) / 100,
      moves: s.total_moves || 0,
      weeks: [], // per scored week
    };
  });
  const T = Object.fromEntries(teams.map((t) => [t.rid, t]));
  const n = teams.length;

  // ---- weekly results ----
  const weekly = []; // [{week, scores:{rid:pts}}]
  const topPerformances = [];
  for (let w = 1; w <= lastScored; w++) {
    const wk = matchups[w] || [];
    if (!wk.length) continue;
    const byMatch = {};
    wk.forEach((m) => (byMatch[m.matchup_id] ||= []).push(m));
    const scores = Object.fromEntries(wk.map((m) => [m.roster_id, m.custom_points ?? m.points ?? 0]));
    const vals = Object.values(scores);
    for (const m of wk) {
      const t = T[m.roster_id];
      if (!t) continue;
      const pts = scores[m.roster_id];
      const opp = (byMatch[m.matchup_id] || []).find((x) => x.roster_id !== m.roster_id);
      const oppPts = opp ? scores[opp.roster_id] : null;
      const allPlayW = vals.filter((v) => v < pts).length + 0.5 * (vals.filter((v) => v === pts).length - 1);
      const pp = m.players_points || {};
      const startersSet = new Set(m.starters || []);
      const benchPts = Object.entries(pp).filter(([id]) => !startersSet.has(id)).reduce((a, [, v]) => a + v, 0);
      // weekly optimal lineup from actual points
      let optimal = null;
      if (Object.keys(pp).length && Object.keys(players).length) optimal = bestLineup(m.players || [], slots, (id) => pp[id] ?? 0, posOf).total;
      t.weeks.push({
        week: w, pts, opp: opp ? opp.roster_id : null, oppPts,
        result: oppPts == null ? null : pts > oppPts ? 'W' : pts < oppPts ? 'L' : 'T',
        allPlayW, allPlayL: n - 1 - allPlayW,
        rank: vals.filter((v) => v > pts).length + 1,
        benchPts: round(benchPts, 2), optimal: round(optimal, 2),
      });
      (m.starters || []).forEach((id, i) => {
        const sp = (m.starters_points || [])[i];
        if (sp != null) topPerformances.push({ week: w, rid: m.roster_id, id, pts: sp });
      });
    }
    weekly.push({ week: w, scores });
  }
  topPerformances.sort((a, b) => b.pts - a.pts);

  // ---- season aggregates ----
  for (const t of teams) {
    const g = t.weeks.length || 1;
    const pts = t.weeks.map((w) => w.pts);
    t.games = t.weeks.length;
    t.pfPerGame = t.weeks.length ? mean(pts) : t.pf / g;
    t.allPlayW = t.weeks.reduce((a, w) => a + w.allPlayW, 0);
    t.allPlayL = t.weeks.reduce((a, w) => a + w.allPlayL, 0);
    t.allPlayPct = t.allPlayW / Math.max(1, t.allPlayW + t.allPlayL);
    t.expectedWins = t.allPlayPct * t.games;
    t.luck = t.wins + 0.5 * t.ties - t.expectedWins;
    t.winPct = (t.wins + 0.5 * t.ties) / Math.max(1, t.games);
    t.form = mean(pts.slice(-3));
    t.consistency = std(pts);
    t.best = t.weeks.reduce((b, w) => (!b || w.pts > b.pts ? w : b), null);
    t.worst = t.weeks.reduce((b, w) => (!b || w.pts < b.pts ? w : b), null);
    t.benchPerWeek = mean(t.weeks.map((w) => w.benchPts || 0));
    const opt = t.weeks.filter((w) => w.optimal != null);
    t.efficiency = opt.length ? opt.reduce((a, w) => a + w.pts, 0) / opt.reduce((a, w) => a + w.optimal, 0)
      : t.maxPf ? t.pf / t.maxPf : null;
    t.leftOnBench = opt.length ? mean(opt.map((w) => w.optimal - w.pts)) : t.maxPf ? (t.maxPf - t.pf) / g : null;
    // streak
    let sr = null, sc = 0;
    for (let i = t.weeks.length - 1; i >= 0; i--) {
      const r = t.weeks[i].result;
      if (!r || (sr && r !== sr)) break;
      sr = r; sc++;
    }
    t.streak = sr ? `${sr}${sc}` : '';
  }

  // ---- ROS roster strength ----
  for (const t of teams) {
    const ids = t.players;
    const ros1 = bestLineup(ids, slots, effWeekly, posOf);
    t.rosLineup = ros1.lineup.map((l) => l.p && { slot: l.slot, id: l.p.id, pts: round(l.p.m) });
    // the best lineup available each week (that week's byes out), and their regular-season average
    t.weekProj = Object.fromEntries(simWeeks.map((w) => [w, bestLineup(ids, slots, (id) => weekProj(id, w), posOf).total]));
    const regWeeks = simWeeks.filter((w) => w <= regEnd);
    t.rosProj = regWeeks.length ? mean(regWeeks.map((w) => t.weekProj[w])) : ros1.total;
    const benchVals = ros1.bench.filter((p) => BENCH_POS.includes(p.pos)).map((p) => valueOf(p.id)).sort((a, b) => b - a);
    t.depth = benchVals.slice(0, 4).reduce((a, v) => a + v, 0);
    t.rosterValue = ids.reduce((a, id) => a + valueOf(id), 0);
    // by position group (starting-lineup weekly points incl. flex usage)
    t.posGroups = {};
    for (const pos of FIXED) t.posGroups[pos] = 0;
    for (const l of ros1.lineup) if (l.p) t.posGroups[l.p.pos] = (t.posGroups[l.p.pos] || 0) + l.p.m;
    t.topAssets = [...ids].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 4).map((id) => ({ id, v: valueOf(id) }));
    t.injured = ids.filter((id) => OUT_STATUSES.has(statusOf(id)) && valueOf(id) >= 20).map((id) => ({ id, status: statusOf(id), v: valueOf(id) }));
    t.thisWeekProj = t.weekProj[upcoming] ?? bestLineup(ids, slots, thisWeekProj, posOf).total;
    // week in progress: starters whose game is done are banked; the open slots get the best lineup of players yet to play
    const set = liveRows.find((m) => m.roster_id === t.rid)?.starters || [];
    if (playedTeams.size && set.length === slots.length) {
      const locked = set.map((id, i) => (id && id !== '0' && hasPlayed(id) ? i : -1)).filter((i) => i >= 0);
      const open = slots.filter((_, i) => !locked.includes(i));
      const rest = bestLineup(ids.filter((id) => !hasPlayed(id)), open, thisWeekProj, posOf);
      t.live = {
        banked: round(locked.reduce((a, i) => a + (livePts[set[i]] ?? 0), 0), 2),
        rest: rest.total,
        left: open.length / slots.length,
        played: locked.map((i) => ({ id: set[i], slot: slots[i], pts: livePts[set[i]] ?? 0, proj: thisWeekProj(set[i]) })),
      };
    }
  }

  // position-group league ranks
  const posRanks = {};
  for (const pos of FIXED) {
    const r = rankDesc(teams.map((t) => t.posGroups[pos]));
    teams.forEach((t, i) => ((t.posRanks ||= {})[pos] = r[i]));
    posRanks[pos] = r;
  }

  // ---- team strength projections and the remaining schedule ----
  const avgPf = mean(teams.map((t) => t.pfPerGame).filter(Boolean));
  const avgProj = mean(teams.map((t) => t.rosProj).filter(Boolean)) || 1;
  const scale = hasRos && avgPf ? avgPf / avgProj : 1;
  const pooledSd = Math.max(15, mean(teams.map((t) => t.consistency).filter(Boolean)) || 22);
  teams.forEach((t) => {
    t.projMean = hasRos ? 0.65 * t.rosProj * scale + 0.35 * (t.pfPerGame || avgPf) : t.pfPerGame || avgPf;
    // strength in a specific week: that week's best lineup (byes out) blended the same way
    t.muWeek = Object.fromEntries(simWeeks.map((w) => [w, hasRos ? 0.65 * t.weekProj[w] * scale + 0.35 * (t.pfPerGame || avgPf) : t.projMean]));
    t.projSd = pooledSd;
    t.sdWeek = {};
    if (t.live) {
      // points already scored count in full; only the slots still to play carry projection and uncertainty
      const restMu = hasRos ? 0.65 * t.live.rest * scale + 0.35 * (t.pfPerGame || avgPf) * t.live.left : (t.pfPerGame || avgPf) * t.live.left;
      t.muWeek[upcoming] = t.live.banked + restMu;
      t.sdWeek[upcoming] = pooledSd * Math.sqrt(t.live.left);
    }
  });
  const remaining = [];
  for (let w = lastScored + 1; w <= regEnd; w++) {
    const wk = matchups[w] || [];
    const byMatch = {};
    wk.forEach((m) => (byMatch[m.matchup_id] ||= []).push(m.roster_id));
    remaining.push({ week: w, pairs: Object.values(byMatch).filter((p) => p.length === 2) });
  }

  // remaining schedule strength, priced in wins: P(win) against the actual opponent in that week minus P(win)
  // against an average opponent that week, summed over the games left. Week-specific, so drawing a team in its
  // bye-heavy week counts as the easier game it is.
  const pWin = (a, b) => normCdf((a - b) / Math.sqrt(2 * pooledSd ** 2));
  const mu = (t, w) => t.muWeek[w] ?? t.projMean;
  for (const t of teams) {
    const games = remaining.map((wk) => { const p = wk.pairs.find((x) => x.includes(t.rid)); return p && { week: wk.week, o: T[p[0] === t.rid ? p[1] : p[0]] }; }).filter(Boolean);
    t.schedule = games.map(({ week, o }) => ({ week, rid: o.rid, proj: round(mu(o, week)), pWin: pWin(mu(t, week), mu(o, week)) }));
    t.sosOpp = games.length ? mean(games.map(({ week, o }) => mu(o, week))) : null;
    t.schedWins = games.reduce((a, { week, o }) => {
      const avgOpp = mean(teams.filter((x) => x.rid !== t.rid).map((x) => mu(x, week)));
      return a + pWin(mu(t, week), mu(o, week)) - pWin(mu(t, week), avgOpp);
    }, 0);
  }

  // ---- power score ----
  const W = input.weights && Object.keys(input.weights).length ? input.weights : WEIGHTS;
  const metricsFor = (throughWeek) => {
    // the standings as of that week: wins (ties half), then points for, the tiebreaker
    const table = teams.map((t) => { const ws = t.weeks.filter((w) => w.week <= throughWeek); return { rid: t.rid, w: ws.filter((w) => w.result === 'W').length + 0.5 * ws.filter((w) => w.result === 'T').length, pf: ws.reduce((a, w) => a + w.pts, 0) }; })
      .sort((a, b) => b.w - a.w || b.pf - a.pf);
    const seed = Object.fromEntries(table.map((x, i) => [x.rid, i + 1]));
    return teams.map((t) => {
      const ws = t.weeks.filter((w) => w.week <= throughWeek);
      const g = ws.length || 1;
      const apw = ws.reduce((a, w) => a + w.allPlayW, 0);
      const apl = ws.reduce((a, w) => a + w.allPlayL, 0);
      const wins = ws.filter((w) => w.result === 'W').length + 0.5 * ws.filter((w) => w.result === 'T').length;
      return {
        rosProj: t.rosProj,
        depth: t.depth,
        sos: t.schedWins,
        allPlay: apw / Math.max(1, apw + apl),
        pfPerGame: mean(ws.map((w) => w.pts)) || 0,
        winPct: wins / g,
        form: mean(ws.slice(-3).map((w) => w.pts)) || 0,
        standing: n + 1 - seed[t.rid],
        lastWeek: ws.length ? ws[ws.length - 1].pts : 0,
      };
    });
  };
  const scoreFrom = (ms) => {
    const keys = Object.keys(W).filter((k) => W[k] > 0 && (hasRos || !ROS_KEYS.includes(k)));
    const wsum = keys.reduce((a, k) => a + W[k], 0);
    const z = Object.fromEntries(keys.map((k) => [k, zscores(ms.map((m) => m[k]))]));
    return ms.map((_, i) => {
      const comp = keys.reduce((a, k) => a + W[k] * z[k][i], 0) / wsum;
      const rosKeys = keys.filter((k) => ROS_KEYS.includes(k));
      const resKeys = keys.filter((k) => !ROS_KEYS.includes(k) && !SOS_KEYS.includes(k));
      const sub = (ks) => {
        const w = ks.reduce((a, k) => a + W[k], 0);
        return w ? 50 + 18 * (ks.reduce((a, k) => a + W[k] * z[k][i], 0) / w) : null;
      };
      return {
        score: Math.max(1, Math.min(99, 50 + 22 * comp)),
        rosScore: rosKeys.length ? Math.max(1, Math.min(99, sub(rosKeys))) : null,
        sosScore: remaining.length && keys.includes('sos') ? Math.max(1, Math.min(99, sub(SOS_KEYS))) : null,
        resultsScore: Math.max(1, Math.min(99, sub(resKeys))),
        parts: Object.fromEntries(Object.entries(PARTS).map(([g, ks]) => {
          const v = sub(keys.filter((k) => ks.includes(k)));
          return [g, v == null || (g === 'schedule' && !remaining.length) ? null : Math.max(1, Math.min(99, v))];
        })),
        z: Object.fromEntries(keys.map((k) => [k, z[k][i]])),
      };
    });
  };

  const nowMetrics = metricsFor(lastScored);
  const now = scoreFrom(nowMetrics);
  const nowRanks = rankDesc(now.map((s) => s.score));
  teams.forEach((t, i) => {
    Object.assign(t, now[i]);
    t.powerRank = nowRanks[i];
    t.seed = n + 1 - nowMetrics[i].standing; // place in the real standings
  });

  // rank history (ROS and schedule components held at today's value; results re-computed through each week)
  const history = [];
  for (let w = 1; w <= lastScored; w++) {
    const s = scoreFrom(metricsFor(w));
    const r = rankDesc(s.map((x) => x.score));
    history.push({ week: w, ranks: Object.fromEntries(teams.map((t, i) => [t.rid, r[i]])), scores: Object.fromEntries(teams.map((t, i) => [t.rid, round(s[i].score)])) });
  }
  teams.forEach((t) => {
    t.rankHistory = history.map((h) => h.ranks[t.rid]);
    const prev = history.length > 1 ? history[history.length - 2].ranks[t.rid] : t.powerRank;
    t.movement = prev - t.powerRank; // + = moved up
  });

  // ---- league-level ranks used in explanations ----
  const rk = (key) => {
    const r = rankDesc(teams.map((t) => t[key] ?? -Infinity));
    teams.forEach((t, i) => ((t.ranks ||= {})[key] = r[i]));
  };
  ['rosProj', 'depth', 'pfPerGame', 'allPlayPct', 'form', 'luck', 'efficiency', 'rosterValue', 'thisWeekProj', 'schedWins'].forEach(rk);
  const paRank = rankDesc(teams.map((t) => t.pa));
  teams.forEach((t, i) => (t.ranks.pa = paRank[i]));

  // ---- projections: playoff odds ----
  const bracket = rounds && upcoming <= regEnd + 1 ? { start: playoffStart, size: playoffTeams } : null;
  const odds = simulate(teams, remaining, playoffTeams, input.sims || 10000, input.seed || 7, bracket);
  teams.forEach((t) => Object.assign(t, odds[t.rid]));

  // this week's matchups with win probabilities
  const thisWeek = remaining.length && remaining[0].week === lastScored + 1 ? remaining[0] : null;
  const previews = thisWeek
    ? thisWeek.pairs.map(([a, b]) => {
        const ta = T[a], tb = T[b];
        const pre = (t) => (hasRos ? 0.7 * t.thisWeekProj * scale + 0.3 * t.pfPerGame : t.projMean);
        const ma = ta.live ? ta.muWeek[thisWeek.week] : pre(ta);
        const mb = tb.live ? tb.muWeek[thisWeek.week] : pre(tb);
        const sdA = ta.sdWeek[thisWeek.week] ?? pooledSd, sdB = tb.sdWeek[thisWeek.week] ?? pooledSd;
        const sd = Math.sqrt(sdA ** 2 + sdB ** 2);
        const p = sd > 0 ? normCdf((ma - mb) / sd) : ma > mb ? 1 : ma < mb ? 0 : 0.5;
        // stakes = combined playoff-odds swing between winning and losing this game
        const swing = (t) => (t.playoffIfWin != null && t.playoffIfLoss != null ? t.playoffIfWin - t.playoffIfLoss : 0);
        // the lineups managers have actually set in Sleeper for this week, in slot order ('0' = empty slot)
        const set = (rid) => (matchups[thisWeek.week] || []).find((m) => m.roster_id === rid)?.starters || [];
        return { week: thisWeek.week, a, b, projA: round(ma), projB: round(mb), winA: p, liveA: ta.live?.banked ?? null, liveB: tb.live?.banked ?? null, stakes: swing(ta) + swing(tb), startersA: set(a), startersB: set(b) };
      })
    : [];

  // ---- explanations ----
  teams.forEach((t) => (t.why = explain(t, teams, { nameOf, hasRos, playoffTeams, posOf })));
  teams.forEach((t) => (t.tier = tierFor(t, n)));

  // top available free agents by consensus
  const rostered = new Set(teams.flatMap((t) => t.players));
  const freeAgents = Object.entries(ros)
    .filter(([id, r]) => !rostered.has(id) && r.v > 0 && !OUT_STATUSES.has(statusOf(id)))
    .sort((a, b) => b[1].v - a[1].v)
    .slice(0, 25)
    .map(([id, r]) => ({ id, v: r.v, pos: r.pos, wk: r.wk, rk: r.rk, prk: r.prk }));

  // replacement level: what an open roster spot is worth, i.e. the average of the three best free agents
  const replacement = round(mean(freeAgents.slice(0, 3).map((f) => f.v)) || 0);

  // ---- transactions feed ----
  const feed = buildFeed(transactions, { valueOf, nameOf, posOf, T, replacement });
  const managerMoves = {};
  for (const item of feed) {
    for (const side of item.sides) {
      const m = (managerMoves[side.rid] ||= { rid: side.rid, moves: 0, net: 0, tradeNet: 0, waiverNet: 0 });
      m.moves++;
      m.net += side.net;
      if (item.type === 'trade') m.tradeNet += side.net; else m.waiverNet += side.net;
    }
  }

  // divisive players on rosters (biggest ranking disagreement between sources)
  const divisive = [...rostered]
    .filter((id) => ros[id] && BENCH_POS.includes(ros[id].pos) && Object.keys(ros[id].r || {}).length >= 2 && ros[id].v >= 8)
    .map((id) => ({ id, spread: ros[id].spread, r: ros[id].r, v: ros[id].v, rid: teams.find((t) => t.players.includes(id))?.rid }))
    .sort((a, b) => b.spread - a.spread)
    .slice(0, 8);

  const ranked = [...teams].sort((a, b) => a.powerRank - b.powerRank);
  return {
    teams: ranked, byRid: T, weekly, history, previews, feed, managerMoves, freeAgents, divisive,
    topPerformances: topPerformances.slice(0, 10),
    live: playedTeams.size ? { week: upcoming, teams: [...playedTeams].sort() } : null,
    meta: { weights: W, lastScored, regEnd, playoffTeams, currentWeek, hasRos, slots, scale: round(scale, 3), sd: round(pooledSd), replacement, hasByes: Object.keys(byes).length > 0, futures: !!bracket },
    helpers: { nameOf, posOf, valueOf, effWeekly, thisWeekProj, liveProj, hasPlayed, player: playerInfo },
  };
}

// ---------- Monte Carlo ----------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normCdf(x) {
  // Abramowitz-Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
// The hot loop of the page load (10,000 seasons, about 100 scores each), so it works on team indexes and typed arrays:
// no objects or array sorts per season. It draws the same random numbers in the same order as the plain version it
// replaced, so the odds are identical to the last decimal.
function simulate(teams, remaining, playoffTeams, sims, seed, bracket) {
  const rand = mulberry32(seed);
  const gauss = () => {
    let u = 0, v = 0;
    while (!u) u = rand();
    while (!v) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const n = teams.length;
  const ids = teams.map((t) => t.rid);
  const at = new Map(ids.map((id, i) => [id, i]));
  // every week a game can be played in (the rest of the regular season, then the playoff rounds), with each team's
  // mean and spread that week laid out by team index
  const weeks = remaining.map((wk) => wk.week);
  if (bracket) for (let r = 0; r < 3; r++) weeks.push(bracket.start + r);
  const slot = new Map(weeks.map((w, k) => [w, k]));
  const MU = new Float64Array(weeks.length * n), SD = new Float64Array(weeks.length * n);
  weeks.forEach((w, k) => teams.forEach((t, i) => {
    MU[k * n + i] = (t.muWeek || {})[w] ?? t.projMean;
    SD[k * n + i] = (t.sdWeek || {})[w] ?? t.projSd;
  }));
  const score = (i, k) => MU[k * n + i] + SD[k * n + i] * gauss();
  const play = (a, b, k) => (score(a, k) >= score(b, k) ? a : b);
  const games = remaining.map((wk) => Int32Array.from(wk.pairs.flatMap(([a, b]) => [at.get(a), at.get(b)])));
  const baseW = Float64Array.from(teams, (t) => t.wins + 0.5 * t.ties), basePf = Float64Array.from(teams, (t) => t.pf);
  const w = new Float64Array(n), pf = new Float64Array(n), wonNext = new Uint8Array(n), order = new Int32Array(n);
  const playoffs = new Float64Array(n), top2 = new Float64Array(n), first = new Float64Array(n), last = new Float64Array(n), wins = new Float64Array(n);
  const seeds = new Float64Array(n * n), nextW = new Float64Array(n), inIfW = new Float64Array(n), inIfL = new Float64Array(n), final = new Float64Array(n), champ = new Float64Array(n);
  // standings order, best first: wins, then points for; a stable insertion sort, so exact ties keep roster order
  const after = (x, y) => w[y] - w[x] || pf[y] - pf[x]; // > 0 when y ranks ahead of x
  for (let s = 0; s < sims; s++) {
    w.set(baseW); pf.set(basePf); wonNext.fill(0);
    for (let k = 0; k < games.length; k++) {
      const g = games[k];
      for (let j = 0; j < g.length; j += 2) {
        const a = g[j], b = g[j + 1];
        const pa = score(a, k);
        const pb = score(b, k);
        pf[a] += pa; pf[b] += pb;
        if (pa > pb) w[a]++; else if (pb > pa) w[b]++; else { w[a] += 0.5; w[b] += 0.5; }
        if (k === 0) { wonNext[a] = pa > pb ? 1 : 0; wonNext[b] = pb > pa ? 1 : 0; }
      }
    }
    for (let i = 0; i < n; i++) {
      let j = i;
      while (j > 0 && after(order[j - 1], i) > 0) { order[j] = order[j - 1]; j--; }
      order[j] = i;
    }
    // playoffs, one week per round on Sleeper's fixed bracket (top seeds get byes, no reseeding)
    if (bracket) {
      const o = order, P = slot.get(bracket.start);
      let f0, f1;
      if (bracket.size === 4) { f0 = play(o[0], o[3], P); f1 = play(o[1], o[2], P); }
      else if (bracket.size === 6) { f0 = play(o[0], play(o[3], o[4], P), P + 1); f1 = play(o[1], play(o[2], o[5], P), P + 1); }
      else { f0 = play(play(o[0], o[7], P), play(o[3], o[4], P), P + 1); f1 = play(play(o[1], o[6], P), play(o[2], o[5], P), P + 1); }
      final[f0]++; final[f1]++;
      champ[play(f0, f1, P + (bracket.size === 4 ? 1 : 2))]++;
    }
    for (let r = 0; r < n; r++) {
      const i = order[r];
      seeds[i * n + r]++;
      wins[i] += w[i];
      if (wonNext[i]) nextW[i]++;
      if (r < playoffTeams) { playoffs[i]++; if (wonNext[i]) inIfW[i]++; else inIfL[i]++; }
      if (r < 2) top2[i]++;
      if (r === 0) first[i]++;
      if (r === n - 1) last[i]++;
    }
  }
  const res = {};
  ids.forEach((id, i) => {
    res[id] = {
      playoffPct: playoffs[i] / sims,
      byePct: top2[i] / sims,
      firstPct: first[i] / sims,
      lastPct: last[i] / sims,
      projWins: wins[i] / sims,
      seedDist: Array.from(seeds.subarray(i * n, i * n + n), (c) => c / sims),
      champPct: bracket ? champ[i] / sims : null,
      finalPct: bracket ? final[i] / sims : null,
      // playoff odds conditional on winning or losing the next game: the stakes of this week
      playoffIfWin: nextW[i] ? inIfW[i] / nextW[i] : null,
      playoffIfLoss: sims - nextW[i] ? inIfL[i] / (sims - nextW[i]) : null,
    };
  });
  return res;
}

// ---------- narrative ----------
const POS_LABEL = { QB: 'QB', RB: 'RB room', WR: 'WR corps', TE: 'TE', K: 'kicker', DEF: 'defense' };
function explain(t, teams, { nameOf, hasRos, playoffTeams }) {
  const n = teams.length;
  const out = [];
  const r = t.ranks;
  const tone = (rank) => (rank <= 3 ? 'good' : rank >= n - 2 ? 'bad' : 'neutral');

  if (hasRos) {
    out.push({
      tone: tone(r.rosProj),
      title: `${ordinal(r.rosProj)} in rest-of-season lineup strength`,
      text: `Their best lineup averages ${t.rosProj.toFixed(1)} pts/wk over the rest of the regular season, byes included, using consensus ROS projections${r.rosProj <= 3 ? ' — one of the scariest starting XIs in the league' : r.rosProj >= n - 2 ? ' — the cupboard is thin from here' : ''}.`,
    });
    const pos = ['QB', 'RB', 'WR', 'TE'];
    const best = pos.reduce((b, p) => (t.posRanks[p] < t.posRanks[b] ? p : b), pos[0]);
    const worst = pos.reduce((b, p) => (t.posRanks[p] > t.posRanks[b] ? p : b), pos[0]);
    if (t.posRanks[best] <= 3 || t.posRanks[worst] >= n - 2) {
      out.push({
        tone: 'neutral',
        title: `Built around the ${POS_LABEL[best]}${t.posRanks[worst] >= n - 3 ? `, exposed at ${POS_LABEL[worst]}` : ''}`,
        text: `${POS_LABEL[best][0].toUpperCase() + POS_LABEL[best].slice(1)} ranks ${ordinal(t.posRanks[best])} of ${n}` +
          (t.posRanks[worst] >= n - 3 ? `, while the ${POS_LABEL[worst]} ranks ${ordinal(t.posRanks[worst])}.` : '.') +
          (t.topAssets[0] ? ` Top asset: ${nameOf(t.topAssets[0].id)}.` : ''),
      });
    }
  }

  if (t.games) {
    const lk = t.luck;
    if (Math.abs(lk) >= 0.9) {
      out.push({
        tone: lk > 0 ? 'neutral' : 'good',
        title: lk > 0 ? `Record is running hot (+${lk.toFixed(1)} luck)` : `Better than the record says (${lk.toFixed(1)} luck)`,
        text: `They're ${t.wins}-${t.losses}, but their weekly scores would have gone ${t.allPlayW.toFixed(0)}-${t.allPlayL.toFixed(0)} against the whole league — about ${t.expectedWins.toFixed(1)} expected wins.` +
          (lk > 0 ? ' Expect some regression.' : ' Better days should be ahead.'),
      });
    } else {
      out.push({
        tone: tone(r.allPlayPct),
        title: `${t.wins}-${t.losses} and earned it`,
        text: `All-play record of ${t.allPlayW.toFixed(0)}-${t.allPlayL.toFixed(0)} (${ordinal(r.allPlayPct)}) lines up with the real record. ${t.pfPerGame.toFixed(1)} pts/game ranks ${ordinal(r.pfPerGame)}.`,
      });
    }
    const delta = t.form - t.pfPerGame;
    if (t.games >= 4 && Math.abs(delta) >= 8) {
      out.push({
        tone: delta > 0 ? 'good' : 'bad',
        title: delta > 0 ? 'Heating up' : 'Cooling off',
        text: `Averaging ${t.form.toFixed(1)} over the last 3 weeks vs ${t.pfPerGame.toFixed(1)} on the season${t.streak && t.streak.length > 1 && Number(t.streak.slice(1)) >= 2 ? ` (${t.streak[0] === 'W' ? 'won' : 'lost'} ${t.streak.slice(1)} straight)` : ''}.`,
      });
    }
    if (t.leftOnBench != null && (r.efficiency <= 2 || r.efficiency >= n - 1)) {
      out.push({
        tone: r.efficiency <= 2 ? 'good' : 'bad',
        title: r.efficiency <= 2 ? 'Lineup sniper' : 'Points rotting on the bench',
        text: `Started ${(t.efficiency * 100).toFixed(1)}% of their optimal lineup (${ordinal(r.efficiency)}), leaving ${t.leftOnBench.toFixed(1)} pts/wk on the pine.`,
      });
    }
    if (r.pa === 1) out.push({ tone: 'neutral', title: 'Toughest schedule so far', text: `Opponents have dropped ${t.pa.toFixed(1)} on them, the most in the league.` });
  }

  if (t.schedule && t.schedule.length && (r.schedWins <= 2 || r.schedWins >= n - 1)) {
    const easy = r.schedWins <= 2;
    out.push({
      tone: easy ? 'good' : 'bad',
      title: easy ? `${r.schedWins === 1 ? 'Easiest' : `${ordinal(r.schedWins)}-easiest`} remaining schedule` : `${r.schedWins === n ? 'Toughest' : `${ordinal(n + 1 - r.schedWins)}-toughest`} remaining schedule`,
      text: `Their ${t.schedule.length} remaining opponents project for ${t.sosOpp.toFixed(1)} pts/wk on average. Against that slate they'd expect ${Math.abs(t.schedWins).toFixed(2)} ${easy ? 'more' : 'fewer'} wins than against an average one.`,
    });
  }

  if (t.injured.length) {
    out.push({
      tone: 'bad',
      title: 'Injury drag',
      text: `${t.injured.map((x) => `${nameOf(x.id)} (${x.status})`).join(', ')} ${t.injured.length > 1 ? 'are' : 'is'} sidelined right now.`,
    });
  }

  out.push({
    tone: t.playoffPct >= 0.75 ? 'good' : t.playoffPct <= 0.25 ? 'bad' : 'neutral',
    title: `${Math.round(t.playoffPct * 100)}% playoff odds`,
    text: `Simulating the rest of the regular season 10,000 times: ${t.projWins.toFixed(1)} projected wins, top-${playoffTeams} in ${Math.round(t.playoffPct * 100)}% of runs, a bye in ${Math.round(t.byePct * 100)}%.`,
  });
  return out;
}

function tierFor(t, n) {
  const s = t.score;
  if (t.powerRank === 1) return { key: 'elite', label: 'Team to Beat' };
  if (t.powerRank === n) return { key: 'stinks', label: 'This Guy Stinks' }; // last place, always, whatever the score
  if (s >= 62) return { key: 'elite', label: 'Contender' };
  if (s >= 52) return { key: 'good', label: 'Playoff Push' };
  if (s >= 43) return { key: 'mid', label: 'Bubble' };
  return { key: 'low', label: 'Rebuild Mode' };
}

// ---------- transactions ----------
function buildFeed(transactions, { valueOf, nameOf, posOf, T, replacement = 0 }) {
  const items = [];
  for (const tx of transactions) {
    if (tx.status !== 'complete') continue;
    const sides = {};
    const side = (rid) => (sides[rid] ||= { rid, adds: [], drops: [], picks: [], faabIn: 0, faabOut: 0, net: 0 });
    for (const [pid, rid] of Object.entries(tx.adds || {})) side(rid).adds.push({ id: pid, v: valueOf(pid), pos: posOf(pid) });
    for (const [pid, rid] of Object.entries(tx.drops || {})) side(rid).drops.push({ id: pid, v: valueOf(pid), pos: posOf(pid) });
    for (const p of tx.draft_picks || []) {
      side(p.owner_id).picks.push({ ...p, dir: 'in' });
      side(p.previous_owner_id).picks.push({ ...p, dir: 'out' });
    }
    for (const b of tx.waiver_budget || []) { side(b.receiver).faabIn += b.amount; side(b.sender).faabOut += b.amount; }
    (tx.roster_ids || []).forEach((rid) => side(rid));
    const list = Object.values(sides).filter((s) => T[s.rid]);
    // Trades are priced on value over replacement: in a 2-for-1 the side getting one player frees a roster
    // spot it can fill from waivers, so each extra body received is worth its value minus replacement.
    // Waiver moves stay as raw value in minus value out, since the pickup itself is the replacement.
    const spot = tx.type === 'trade' ? replacement : 0;
    for (const s of list) {
      s.spots = s.adds.length - s.drops.length;
      s.net = round(s.adds.reduce((a, p) => a + p.v, 0) - s.drops.reduce((a, p) => a + p.v, 0) - spot * s.spots);
    }
    if (!list.length) continue;
    const bid = tx.settings && tx.settings.waiver_bid;
    items.push({
      id: tx.transaction_id,
      ts: tx.status_updated || tx.created,
      week: tx.leg,
      type: tx.type,
      bid: bid ?? null,
      sides: list,
    });
  }
  items.sort((a, b) => b.ts - a.ts);
  return items;
}
