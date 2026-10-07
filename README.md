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
`POST .../advance`, `GET .../log`, `GET .../stream` (SSE),
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
economy cards, player table with work/sleep actions, world listing,
realtime event log (SSE), and console controls (advance day/week,
give-all, trigger event, set price, reset economy).
