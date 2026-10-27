// The news clock, shared by the page and the API functions so both agree on which Sleeper snapshot is current.
// Central time; "week minutes" count from Sunday midnight.
//
// Sleeper is read on a fixed schedule only: once per morning (the key rolls over at 6am, so last night's games are
// final) plus one late pull after Sunday night football and one after Monday night football (the final call). The API
// redirects any other key to the current one and keeps each snapshot in the store (lib/snapstore.js), so deploys, odd
// query strings and CDN purges never cause extra pulls.
export const TZ = 'America/Chicago';

export const NEWS_CLOCK = {
  hold: [12 * 60, 22 * 60 + 45], // Sunday noon to 10:45pm: games in progress, news on hold
  holdNote: "Games in progress: news will be updated at the conclusion of tonight's matchup.",
  late: 22 * 60 + 45, // Sunday 10:45pm: the late pull
  final: 1440 + 22 * 60 + 45, // Monday 10:45pm: the final pull, once Monday night football is over
  through: 2 * 1440 + 6 * 60, // the night edition runs until Tuesday 6am
  window: [4 * 1440 + 19 * 60 + 15, 2 * 1440 + 6 * 60], // the game window: Thursday 7:15pm kickoff to Tuesday 6am
};

// One-off moves of a Sunday's late pull, by that Sunday's Central date (minutes after midnight). The usual 10:45pm
// stands otherwise; drop entries once they're past.
export const LATE_OVERRIDES = {};

// One-off moves of a Monday's final pull, by that Monday's Central date (minutes after midnight), for a Monday night
// game that runs long. Drop entries once they're past.
export const FINAL_OVERRIDES = {};

// One-off second final pull, by that Monday's Central date (minutes after midnight): from then until Tuesday 6am the
// key is "<morning key>-final2", a fresh snapshot, for when the 10:45pm pull went out before Monday night was over.
// Drop entries once they're past.
export const FINAL_REPULL = {};

export function weekMinute(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) * 1440 + Number(p.hour) * 60 + Number(p.minute);
}

const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const centralDate = (d = new Date()) => ymd(d);
// the Central date, rolling over at 6am
export const morningKey = (d = new Date()) => ymd(new Date(d - 6 * 36e5));
// this week's late-pull minute: the usual one, or an override for this week's Sunday
function lateFor(d) {
  const sunday = ymd(new Date(d - weekMinute(d) * 60000)); // back to Sunday midnight, Central
  return LATE_OVERRIDES[sunday] ?? NEWS_CLOCK.late;
}
// this week's final-pull minute (from Sunday midnight): the usual Monday 10:45pm, or an override for this Monday
function finalFor(d) {
  const monday = ymd(new Date(d - (weekMinute(d) - 1440) * 60000)); // back to Monday midnight, Central
  return FINAL_OVERRIDES[monday] != null ? 1440 + FINAL_OVERRIDES[monday] : NEWS_CLOCK.final;
}
// the league snapshot: the morning one, plus a "-late" copy from Sunday's late pull until Monday 6am, and a "-final"
// copy from Monday's final pull until Tuesday 6am
export function leagueKey(d = new Date()) {
  const m = weekMinute(d);
  if (m >= lateFor(d) && m < 1440 + 6 * 60) return `${morningKey(d)}-late`;
  if (m >= finalFor(d) && m < 2 * 1440 + 6 * 60) {
    const monday = ymd(new Date(d - (m - 1440) * 60000)), again = FINAL_REPULL[monday];
    return `${morningKey(d)}-final${again != null && m >= 1440 + again ? '2' : ''}`;
  }
  return morningKey(d);
}
// the final call: from Monday's final pull until Thursday's kickoff, a week whose games are all done counts as final
// even before Sleeper has scored it
export function isFinalCall(d = new Date()) { const m = weekMinute(d); return m >= finalFor(d) && m < NEWS_CLOCK.window[0]; }
// the news hold ends at the late pull, wherever it falls this week
export function isOnHold(d = new Date()) { const m = weekMinute(d); return m >= NEWS_CLOCK.hold[0] && m < Math.min(NEWS_CLOCK.hold[1], lateFor(d)); }
export function isNightDesk(d = new Date()) { const m = weekMinute(d); return m >= lateFor(d) && m < NEWS_CLOCK.through; }
export function inGameWindow(d = new Date()) { const m = weekMinute(d); return m >= NEWS_CLOCK.window[0] || m < NEWS_CLOCK.window[1]; }
