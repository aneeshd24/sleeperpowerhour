# The Power Hour

Power rankings, a live waiver-wire feed and data-nerd stats for **jits and diddles**, a 10-team full-PPR Sleeper league.

## Connect your league

Already connected to jits and diddles (`1389360536516329472`). To point it at another league:

1. Find your league ID: open your league on sleeper.com; it's the long number in the URL (`sleeper.com/leagues/<league ID>/...`).
2. Either put it in `api/league.js` (`const LEAGUE_ID = '...'`) or, in Vercel, add an environment variable `SLEEPER_LEAGUE_ID` with that number (Project, Settings, Environment Variables), then redeploy.
3. Optional personal touches, all in `app.js` and off by default: `EDITOR` (the site's author), `CHAMPION` (last season's winner gets a trophy), `MONEY_WEEK`, `SHAKEUP`, `MESSAGE_VIDEO`, `CLIP`. Manager headshots go in `MEMBERS` in `lib/members.js` with photos in `assets/heads/`.

The page reads Sleeper only through the site's own `/api/league` and `/api/ros`, once each morning. Rankings use the full-PPR lists; for a half-PPR league set `SCORING = 'half'` in `lib/sources.js`.

- **Rankings**: a 0–100 power score per team from standing (40%), scoring (28%), schedule left (17%) and rest-of-season roster (15%). Tap a team for the reasons behind its rank, a position-group radar, its best ROS lineup, weekly scoring and simulated playoff seeds.
- **Wire**: every add, drop and trade, newest first. Each move is graded by the consensus ROS value gained or lost. Also shows the best available free agents and a trade ledger.
- **This week**: projected scores and win odds for every matchup.
- **Nerd lab**: rank flow, luck index, points for vs against, weekly finishes heatmap, position-group ranks, playoff odds, lineup efficiency, biggest games, players the experts disagree on, and waiver/trade ROI.

## How it stays up to date

| Data | Where it comes from | How fresh |
| --- | --- | --- |
| Rosters, scores, matchups, transactions | Sleeper API, via `/api/league` | Once each morning (6am Central), cached on the CDN for everyone |
| ROS rankings (FantasyPros, DraftSharks, LeagueLogs) | `api/ros.js`, a Vercel serverless function | Pulled once per day (first visitor each day, Central time), then cached at Vercel's edge |

No cron job: the page requests `/api/ros?d=YYYY-MM-DD`, so each new day is a new cache key. If one ranking source fails, the others are still used and that response is only cached for an hour so it retries soon.

## Deploy to Vercel

1. Create a new GitHub repo and push this folder to it.
2. In Vercel, choose **Add New → Project**, import the repo, and keep every setting at its default (Framework preset: **Other**, no build command, no output directory).
3. Deploy. The site is at `https://<project>.vercel.app`; share that link with the league.

Nothing needs installing: there are no npm dependencies. The serverless function runs on Vercel's default Node runtime (18+).

To preview locally: `npx vercel dev`, then open http://localhost:3000. Add `?demo=1` to the URL to see a saved snapshot of the league (Oct 27, 2026) without calling any APIs.

## Turn on fan picks (one-time)

Fan votes on the This week page need somewhere shared to live. Everything else works without it; until it's connected the voting box just doesn't appear.

1. In the Vercel dashboard, open the project and go to **Storage**.
2. Choose **Create Database**, pick **Upstash for Redis** (the free plan is plenty), and connect it to this project for all environments.
3. Redeploy (Deployments, then the three dots on the latest one, then **Redeploy**) so the function picks up the new `KV_REST_API_URL` and `KV_REST_API_TOKEN` variables.

Optional: add an environment variable `VOTE_SALT` with any random string; it's mixed into the hashed IP addresses used for the per-network vote cap.

How it works: each phone keeps a random voter id, so voting again from the same phone switches the pick instead of adding one. One network can cast at most 3 votes per matchup (so a few friends on the same Wi-Fi still can), voting closes as soon as the week's first points are scored, and tallies stay visible to everyone. It's built for fun among friends, not to stop a determined cheater.

## Tuning

| What | Where |
| --- | --- |
| League ID | `LEAGUE_ID` in `api/league.js`, or the `SLEEPER_LEAGUE_ID` environment variable |
| Time zone (news clock) | `TZ` in `lib/newsclock.js` |
| Power-score weights | `WEIGHTS` in `lib/engine.js` |
| Source weights (LeagueLogs counts half by default) | `SOURCE_WEIGHTS` in `lib/consensus.js` |
| Rank-to-value curve | `VALUE_DECAY` in `lib/consensus.js` |
| Tier labels and explanation wording | `tierFor` and `explain` in `lib/engine.js` |
| Name mismatches between sites and Sleeper | `NICKNAMES` in `lib/consensus.js` |

Check `/api/ros` in the browser to see how many players each source matched (`sources.*.matched`).

## Files

```
index.html, styles.css, app.js   the site
lib/engine.js                    power score, explanations, playoff simulation, transaction grading
lib/consensus.js                 matches ranking rows to Sleeper IDs and blends the three sources
lib/sources.js                   parsers for each ranking site
lib/charts.js                    dependency-free SVG charts
api/ros.js                       daily rankings endpoint (Vercel function)
demo/demo.json                   saved snapshot of this league for ?demo=1
```

## If a ranking site changes its page

The parsers read specific page structures: FantasyPros' embedded `ecrData`, DraftSharks' `/ros-rankings/load-rows` table rows, and LeagueLogs' rankings table. If a site redesigns, that source shows as offline on the Rankings page and the other two carry the score until the parser in `lib/sources.js` is updated.

Rankings data belongs to FantasyPros, DraftSharks and LeagueLogs; league data comes from the Sleeper API. This is a personal, non-commercial league site.
