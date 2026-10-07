# simkit

Simulation primitives for life / economy / city sim games.

> Build Nigerian life simulation games in days, not months.

## Install

```bash
npm install simkit
```

## Quick start

```ts
import { createSimulation } from "simkit";

const sim = createSimulation({
  gameId: "lagos-life",
  currency: "NGN",
  seed: 42,
  locations: ["yaba", "ikeja", "lekki", "surulere"],
  jobs: [{ id: "danfo-driver", salary: 150000, workingHours: 8 }],
  events: [{ id: "fuel-crisis", probability: 0.03 }],
});

const player = await sim.players.create({ name: "Mubaraq", location: "yaba" });
player.acceptJob("danfo-driver");
player.work();      // +8h game time, daily pay, -energy, +xp
player.eat();       // -₦, +energy
player.travel("lekki");
player.sleep();     // +8h, restore energy

sim.advanceDays(7);          // tick world events
sim.console.giveAll(10_000); // simulation console
sim.console.trigger("fuel-crisis");
console.log(sim.stats());
```

## Primitives (V1)

- **Player**: cash, energy, health, reputation, location, stats
- **Time**: independent `GameClock` (`Monday 08:00`); actions consume time
- **Economy**: `Wallet` with auditable `Transaction[]`
- **Jobs**: `accept / work / quit`, salary, requirements, energy cost
- **Locations**: world graph with travel cost + time
- **Events**: declarative, seeded, `probability / cooldown / once / condition / effect`
- **Progression**: skills, xp/levels, achievements
- **NPCs + relationships**: colocated `talk()` with seeded dialogue, scores and stranger→family levels
- **Items + inventory**: `buy / use / sell` with energy/health effects
- **Businesses**: buy once, collect per-day income
- **Missions**: earn/wealth/level/relationship/own goals with cash + XP rewards
- **Multiplayer**: atomic player-to-player `transfer()` with paired transactions,
  plus `offerTrade / acceptTrade / declineTrade` swaps of cash + items,
  validated at proposal and acceptance

```ts
const offer = sim.offerTrade(ada.id, bola.id, { offerCash: 5000, offerItems: { amala: 1 }, askCash: 8000 });
sim.acceptTrade(offer.id, bola.id); // atomic or nothing moves
```

```ts
sim.talk(player.id, "mama-put");          // { line, score, level }
player.buy("amala"); player.use("amala"); // inventory + effects
sim.transfer(ada.id, bola.id, 5000);      // P2P payment
sim.buyBusiness(player.id, "mama-put-buka");
sim.collectIncome(player.id, "mama-put-buka"); // per-day accrual
sim.acceptMission(player.id, "first-100k");
sim.claimMission(player.id, "first-100k");    // reward + XP
```

## Determinism

No `Math.random()` inside the sim — use `sim.rng`.
Same `seed` + same actions = same event sequence. `sim.snapshot()` /
`Sim.restore()` round-trip clock, players, world, jobs, RNG state, and event
counts for replay and debugging.

## Scripts

```bash
npm run build
npm test
npm run example
npm run server   # API + dashboard on http://localhost:8787
```

## Backend platform (Phase 2)

Zero-dependency Node HTTP API with API-key auth, multi-game registry,
JSON-file snapshot persistence (Postgres-ready `Store` interface), and
SSE realtime event streams.

```bash
npm run server
# env: PORT=8787 SIMKIT_API_KEYS=key1,key2 SIMKIT_DATA_DIR=./.simkit-data
# durable single-file store: SIMKIT_SQLITE_PATH=./simkit.db
# auth off for local dev: SIMKIT_NO_AUTH=1
```

```bash
curl -H "x-api-key: simkit-dev" http://localhost:8787/v1/games
curl -H "x-api-key: simkit-dev" -H "content-type: application/json" \
  -d '{"name":"Mubaraq","location":"yaba"}' \
  http://localhost:8787/v1/games/lagos-life/players
```

Key routes: `POST /v1/games`, `GET /v1/games/:id/stats`,
player `.../players` + `.../players/:pid/actions` (`work|travel|sleep|eat|accept-job|quit`),
`.../players/:pid/{talk,buy,use,sell,transfer}`,
`.../players/:pid/businesses/:bid/{buy,collect}`,
`.../players/:pid/missions[/:mid/{accept,claim}]`,
define `POST .../{npcs,items,businesses,missions}`,
`.../trades` (`POST` propose, `GET ?playerId=`, `.../:id/{accept,decline,cancel}`),
`POST .../advance`, `GET .../log`, `GET .../analytics`
(economy series, wealth buckets, 7d/30d retention), `GET .../stream` (SSE),
`POST .../console/{give-all,set-price,trigger,reset-economy}`,
`GET .../snapshot`.

Remote SDK mirrors the local ergonomics over HTTP:

```ts
import { SimClient } from "simkit";

const client = new SimClient({ baseUrl: "http://localhost:8787", apiKey: "simkit-dev", gameId: "lagos-life" });
const player = await client.createPlayer({ name: "Mubaraq" });
await client.acceptJob(player.id, "danfo-driver");
await client.work(player.id);
await client.advance(7);
```

## Dashboard (Phase 3)

`GET /dashboard` serves the simulation observability UI: game selector,
economy cards, economy time-series chart with 7d/30d retention and wealth
distribution, player table with work/sleep actions, world listing,
realtime event log (SSE), and console controls (advance day/week,
give-all, trigger event, set price, reset economy).

## Persistence

JSON snapshot dir by default (`SIMKIT_DATA_DIR`); single-file durable
SQLite with `SIMKIT_SQLITE_PATH=./simkit.db` (zero dependencies via
`node:sqlite`). Postgres remains the scale-out answer behind the `Store`
interface.

## Reference game (Phase 4)

`GET /play` serves **Lagos Life Mini**, the player-facing proof that a
complete game runs on the SDK: name entry, ₦ balance, location, day/time,
job, energy bar, and [Go to work] [Eat] [Travel] [Sleep] [Take job]
actions — every tap goes through the API → SDK.

## Marketplace packs

Installable worlds, jobs, and systems — no code required:

```ts
import { installPack, listPacks } from "simkit";

listPacks("world"); // world-lagos, world-ilorin, world-abuja
installPack(sim, "jobs-nigerian-core"); // 7 everyday careers
installPack(sim, "system-nysc");        // allowee + clearance wahala
installPack(sim, "system-university");  // fees, exams, strike risk
installPack(sim, "system-market");      // boom, crash, owambe season
installPack(sim, "characters-lagos");   // 3 NPCs, street food, buka business, first-₦100k mission
```

Over HTTP: `GET /v1/packs?kind=world`, `POST /v1/games/:id/packs/:packId/install`.

## Versioned worlds

Rule changes ship as world versions; existing players migrate safely:

```ts
catalog.define("lagos-life", { version: "v2", jobs: [{ id: "danfo-driver", salary: 200000 }] });
catalog.migrate(sim, "v2"); // salary applies to future work; history untouched
```

Removed jobs remap holders to a fallback (or they quit gracefully) via
`removedJobs` + `jobFallback`. HTTP: `GET .../versions`, `POST .../migrate {"target":"v2"}`.

## Plans & metering

Per-game usage against generous tiers (free → $29 developer → $99 pro →
enterprise custom): `GET .../usage`, `POST .../plan {"tier":"developer"}`.
Player creation and simulation events enforce caps with `429` + upgrade
guidance.
