// Parsers for the three rest-of-season ranking sources.
// Each parser takes raw response text and returns
// [{ name, pos, team, rank, ...extras }] for offensive fantasy positions only.
// Written dependency-free (regex only) so it runs in Node and in a browser.

const KEEP = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

const TEAM_FIX = { JAC: 'JAX', WSH: 'WAS', LA: 'LAR', LVR: 'LV', OAK: 'LV', SD: 'LAC', STL: 'LAR', ARZ: 'ARI', HST: 'HOU', BLT: 'BAL', CLV: 'CLE', SL: 'LAR' };
export const fixTeam = (t) => {
  if (!t) return null;
  const u = String(t).trim().toUpperCase();
  return TEAM_FIX[u] || u;
};
const fixPos = (p) => {
  const u = String(p || '').trim().toUpperCase();
  if (u === 'DST' || u === 'D/ST' || u === 'DEF') return 'DEF';
  if (u === 'PK') return 'K';
  return u;
};
const decode = (s) =>
  String(s)
    .replace(/<!--.*?-->/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// The league's reception scoring, which picks the version of each ranking list: 'ppr' (1 point a catch) or 'half'.
export const SCORING = 'ppr';
const PPR = SCORING === 'ppr';

// ---- FantasyPros: `var ecrData = {...};` embedded in the page ----
export const FANTASYPROS_URL = `https://www.fantasypros.com/nfl/rankings/ros-${PPR ? 'ppr' : 'half-point-ppr'}-overall.php`;
export function parseFantasyPros(html) {
  const m = html.match(/var ecrData = (\{[\s\S]*?\});\s*\n/) || html.match(/var ecrData = (\{[\s\S]*?\});/);
  if (!m) throw new Error('FantasyPros: ecrData not found');
  const data = JSON.parse(m[1]);
  const out = [];
  for (const p of data.players || []) {
    const pos = fixPos(p.player_position_id);
    if (!KEEP.has(pos)) continue;
    out.push({
      name: p.player_name,
      pos,
      team: fixTeam(p.player_team_id),
      rank: Number(p.rank_ecr),
      best: Number(p.rank_min),
      worst: Number(p.rank_max),
      std: Number(p.rank_std),
      bye: Number(p.player_bye_week) || null,
    });
  }
  return { updated: data.last_updated || null, players: out };
}

// ---- DraftSharks: the page lazy-loads rows from /ros-rankings/load-rows ----
export const DRAFTSHARKS_URL =
  `https://www.draftsharks.com/ros-rankings/load-rows?offset=0&limit=600&fantasyPosition=&pprSuperflexSlug=${PPR ? 'ppr' : 'half-ppr'}&sort=-dsValue&researchDepth=rankings`;
export function parseDraftSharks(html) {
  const out = [];
  const rows = html.split(/<tr class="player-row"/).slice(1);
  for (const raw of rows) {
    const row = raw.split('</tr>')[0];
    const rank = (row.match(/rank-index">\s*<span>(\d+)<\/span>/) || [])[1];
    const first = (row.match(/first-name="([^"]*)"/) || [])[1];
    const last = (row.match(/last-name="([^"]*)"/) || [])[1];
    const pos = fixPos((row.match(/pos-roster-spot="([A-Z]+)"/) || [])[1]);
    const team = (row.match(/player-details-group__team-name">\s*([A-Z]+)\s*</) || [])[1];
    if (!rank || last == null || !KEEP.has(pos)) continue;
    const attr = (k) => {
      const mm = row.match(new RegExp('data-value="([^"]*)" data-attribute="' + k.replace(/\./g, '\\.') + '"'));
      return mm ? mm[1] : null;
    };
    const num = (v) => (v == null || v === '' || v === 'undefined' ? null : parseFloat(v));
    out.push({
      name: decode(`${first} ${last}`),
      pos,
      team: fixTeam(team),
      rank: Number(rank),
      dsValue: num(attr('dsValue')),
      weekly: num(attr('rosWeeklyPts')),
      floor: num(attr('rosWeeklyFloorPts')),
      ceiling: num(attr('rosWeeklyCeilingPts')),
      games: num(attr('games_played')),
      injuryRisk: num(attr('player.sipPlayerProfile.injury_prob')),
      sos: num(attr('strength_of_schedule')),
    });
  }
  // DraftSharks' overall list includes IDP players; re-rank within the kept positions.
  out.sort((a, b) => a.rank - b.rank);
  out.forEach((p, i) => (p.rank = i + 1));
  return { updated: null, players: out };
}

// ---- LeagueLogs: server-rendered <table> ----
// (LeagueLogs' plain ROS page is its full-PPR list)
export const LEAGUELOGS_URL = `https://leaguelogs.com/rankings/ros${PPR ? '' : '/half-ppr'}`;
export function parseLeagueLogs(html) {
  const out = [];
  const body = html.split(/<tbody[^>]*>/)[1];
  if (!body) throw new Error('LeagueLogs: table not found');
  const rows = body.split('</tbody>')[0].split(/<tr[\s>]/).slice(1);
  for (const raw of rows) {
    const cells = [...raw.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length < 8) continue;
    const name = decode((cells[1].match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || cells[1]);
    const pos = fixPos(decode(cells[2]));
    if (!KEEP.has(pos)) continue;
    out.push({
      name,
      pos,
      team: fixTeam(decode(cells[3])),
      rank: Number(decode(cells[0])),
      consensus: parseFloat(decode(cells[5])),
      best: Number(decode(cells[6])),
      worst: Number(decode(cells[7])),
    });
  }
  return { updated: null, players: out };
}
