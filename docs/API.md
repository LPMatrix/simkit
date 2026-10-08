# SimKit HTTP API

Start the server with `npm run server` (default `http://localhost:8787`).

## Authentication

Every `/v1/*` route requires an API key, sent as `x-api-key: <key>` or `Authorization: Bearer <key>`. Keys come from `SIMKIT_API_KEYS` (default `simkit-dev`). Set `SIMKIT_NO_AUTH=1` for local development.

Realtime streams accept the key as a query parameter, because browser `EventSource` cannot send headers: `GET .../stream?apiKey=<key>`.

## Conventions

Below, `...` means `/v1/games/:gameId`.

Errors are JSON `{ "error": "message" }`:

| Status | Meaning |
|---|---|
| 400 | Invalid input, or an action was refused by a rule (see `reasons` in the message) |
| 401 | Missing or invalid API key |
| 404 | Unknown game, player, actor, location, job, item, action, NPC, business, mission, trade, schedule, or pack |
| 409 | Game already exists |
| 423 | World is paused for inspection (mutation blocked, reads pass) |
| 429 | Plan limit reached |

## Games

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness (no auth) |
| GET | `/v1/games` | List games |
| POST | `/v1/games` | Create a game from a JSON definition |
| POST | `/v1/games/from-config` | Create a game from YAML or JSON text: `{ "text": "..." }` |
| GET | `...` | Game detail: clock, world, jobs, items, NPCs, businesses, missions, versions |
| GET | `...snapshot` | Full state snapshot |

## Players and actions

| Method | Path | Purpose |
|---|---|---|
| POST | `.../players` | Create a player: `{ name, location?, startingCash? }` |
| GET | `.../players` | List players |
| GET | `.../players/:pid` | Player detail |
| GET | `.../actors/:aid` | Any actor: player or NPC (for the inspector) |
| POST | `.../players/:pid/actions` | Run any registered action: `{ action, ...inputs }`. `:pid` is a player id or an NPC id acting on its own; unknown ids return 404 |
| GET | `...actions` | List registered actions |
| GET | `.../systems` | List installed systems |
| POST | `.../players/:pid/talk` | Talk to an NPC: `{ npcId }` |
| POST | `.../players/:pid/buy` | `{ itemId, qty? }` |
| POST | `.../players/:pid/use` | `{ itemId }` |
| POST | `.../players/:pid/sell` | `{ itemId, qty? }` |
| POST | `.../players/:pid/transfer` | `{ to, amount, reason? }` |
| GET | `.../players/:pid/rank?metric=` | Rank on a leaderboard metric |
| GET | `.../players/:pid/explain?fromDay=&toDay=` | Money by category over a window; lines shaped by earlier triggers carry `why` labels |

Action ids for `/actions`: `enrol` (`target`: a course id), `work`, `travel` (`to`), `sleep` (`hours`), `eat` (`cost`, `energyGain`), `accept-job` (`jobId`), `quit-job`, `buy`, `use`, `sell`, `talk`, `transfer`, `trade-offer`, `trade-accept`, `trade-decline`, `trade-cancel`, `business-buy`, `business-collect`, `mission-accept`, `mission-claim`, `hire` (`target`: a business id, plus `id`, `wage`, `name?`, `role?`), `payroll` (`target`: a business id), `settle-obligation` (`scheduleId`). The camelCase forms `acceptJob` and `quitJob` are accepted as aliases.

## Entities

| Method | Path | Purpose |
|---|---|---|
| POST | `.../entities` | Define an entity: `{ kind, id, name?, attributes? }` |
| GET | `.../entities?kind=&employerId=` | List entities, optionally by kind; `employerId` lists a business's employees |

Actions that target an entity take it as `target` (its id), for example `{ "action": "enrol", "target": "cs101" }`. An unknown id or the wrong kind returns 404.

## Businesses, missions, trades

| Method | Path | Purpose |
|---|---|---|
| GET | `.../businesses` | List businesses |
| POST | `.../players/:pid/businesses/:bid/buy` | Buy a business |
| POST | `.../players/:pid/businesses/:bid/collect` | Collect accrued income |
| GET | `.../players/:pid/missions` | Missions with progress |
| POST | `.../players/:pid/missions/:mid/accept` | Accept a mission |
| POST | `.../players/:pid/missions/:mid/claim` | Claim a completed mission |
| GET | `.../trades?playerId=` | Pending trades |
| POST | `.../trades` | Propose: `{ from, to, offerCash?, offerItems?, askCash?, askItems? }` |
| POST | `.../trades/:tid/accept` | `{ by }` |
| POST | `.../trades/:tid/decline` | `{ by }` |
| POST | `.../trades/:tid/cancel` | `{ by }` |

## Schedules

| Method | Path | Purpose |
|---|---|---|
| GET | `.../schedules` | List schedules with next due dates |
| POST | `.../schedules` | Define: `{ id, payer, payee?, amount, everyDays, startsOn?, reason?, onMiss? }` (`onMiss`: `skip`, `retry`, or `default`) |
| POST | `.../schedules/:sid/cancel` | Cancel a schedule |

Schedules settle automatically once per game day through `settle-obligation`. Misses emit `OBLIGATION_MISSED` (plus `OBLIGATION_DEFAULTED` when a `default` policy cancels); both appear in replay as refused actions.

## Definitions

| Method | Path | Purpose |
|---|---|---|
| POST | `.../npcs` | Define an NPC |
| POST | `.../items` | Define an item |
| POST | `.../businesses` | Define a business |
| POST | `.../missions` | Define a mission |
| GET | `/v1/packs?kind=` | List installable packs |
| POST | `.../packs/:packId/install` | Install a pack |

## Insights and runtime

| Method | Path | Purpose |
|---|---|---|
| GET | `.../stats` | Totals and averages |
| GET | `.../analytics` | Series, wealth buckets, 7- and 30-day retention |
| GET | `.../economy` | Issuance, inflation, top jobs and assets, visits, activity |
| GET | `.../activation` | Progress from creation to a playable state |
| GET | `.../leaderboards?metric=wealth&limit=10` | `wealth`, `level`, `xp`, or `reputation` |
| GET | `.../log?limit=100` | Recent event log |
| GET | `.../replay?actorId=&fromDay=&toDay=` | Actions with their ledger entries and events |
| GET | `.../graph?actorId=&fromDay=&toDay=` | Causal graph: action and event nodes with labelled edges |
| GET | `.../stream?apiKey=` | Realtime events (SSE) |

## Simulation control

| Method | Path | Purpose |
|---|---|---|
| POST | `.../advance` | Advance time: `{ days }` (1–30) |
| POST | `.../pause` | Freeze mutation for inspection (reads still work) |
| POST | `.../resume` | Unfreeze a paused world |
| POST | `.../console/give-all` | `{ amount?, reason? }` |
| POST | `.../console/set-price` | `{ key, multiplier }`, where `transport` affects travel and `goods` affects items |
| POST | `.../console/trigger` | Fire an event: `{ eventId }` |
| POST | `.../console/reset-economy` | Clear all wallets |

## Worlds and plans

| Method | Path | Purpose |
|---|---|---|
| GET | `.../versions` | World versions and the current one |
| POST | `.../migrate` | Move to a world version: `{ target }` |
| GET | `.../usage` | Plan usage against limits |
| POST | `.../plan` | Set plan: `{ tier }` (`free`, `developer`, `pro`, `enterprise`) |

## Pages

| Path | Purpose |
|---|---|
| `/dashboard` | Simulation dashboard |
| `/play` | Playable Lagos Life example |
