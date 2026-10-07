# simkit

Simulation backend for life, economy, and city sim games. Define a world, get player accounts, game time, money, jobs, NPCs, events, progression, persistence, leaderboards, and analytics — without building any of that infrastructure yourself.

> Build Nigerian life simulation games in days, not months.

## Quickstart

```bash
npm install simkit
```

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
player.work();      // +8h game time, daily pay, −energy, +XP
player.eat();       // −₦, +energy
player.travel("lekki");
player.sleep();     // +8h, restore energy

sim.advanceDays(7);            // tick world events
sim.console.giveAll(10_000);   // dev console: fund everyone
sim.console.trigger("fuel-crisis");
console.log(sim.stats());
```

## Two ways to run it

**Embedded** — the SDK runs in-process. Best for single-player games, prototypes, and tests. Zero infrastructure.

**Hosted** — run `npm run server` and talk to the same simulation over HTTP. Best for multiplayer games, live dashboards, and anything with more than one client.

```ts
import { SimClient } from "simkit";

const client = new SimClient({ baseUrl: "http://localhost:8787", apiKey: "simkit-dev", gameId: "lagos-life" });
const player = await client.createPlayer({ name: "Mubaraq" });
await client.acceptJob(player.id, "danfo-driver");
await client.work(player.id);
await client.advance(7);
```

## Systems

Everything below works identically embedded and hosted.

| System | What you get |
|---|---|
| Player | Cash, energy, health, reputation, location, inventory, stats |
| Time | Independent game clock (starts Monday 08:00). Every action consumes game time, never wall-clock time |
| Economy | Wallet where every credit/debit is an auditable transaction |
| Jobs | `accept / work / quit`, monthly salaries paid daily, skill requirements, energy costs |
| World | Location graph with travel cost and travel time |
| Events | Declarative random events: `probability / cooldown / once / condition / effect` |
| Progression | Skills, XP/levels, achievements |
| NPCs | Location-bound characters with seeded dialogue; talking builds stranger → family relationships |
| Items | Buyable, usable (energy/health effects), sellable inventory |
| Businesses | Buy once, collect per-day income |
| Missions | Earn / wealth / level / relationship / own-item goals with cash + XP rewards |
| Multiplayer | Instant P2P transfers plus proposed trades of cash + items, validated at proposal and acceptance |
| Leaderboards | Dense-ranked wealth, level, XP, and reputation boards, plus per-player rank |
| Observability | Point-in-time stats, economy time-series, wealth distribution, retention, inflation, issuance, visits, activity |

```ts
sim.talk(player.id, "mama-put");          // { line, score, level }
player.buy("amala"); player.use("amala");
sim.transfer(ada.id, bola.id, 5000);
const offer = sim.offerTrade(ada.id, bola.id, { offerCash: 5000, askCash: 8000 });
sim.acceptTrade(offer.id, bola.id);       // atomic — or nothing moves
sim.buyBusiness(player.id, "mama-put-buka");
sim.collectIncome(player.id, "mama-put-buka");
sim.acceptMission(player.id, "first-100k");
sim.claimMission(player.id, "first-100k");
sim.leaderboard("wealth", 10);
```

## Defining your world

Inline TypeScript (above), installable packs (below), or a single declarative file:

```yaml
# ilorin-life.yaml
gameId: ilorin-life
packs: [world-ilorin, jobs-nigerian-core, system-university]
jobs:
  - id: okada-rider
    salary: 90000
worldVersions:
  - version: v1
  - version: v2
    jobs: [{ id: okada-rider, salary: 110000 }]
```

```ts
import { loadGameConfigFile, createSimulationFromConfig } from "simkit";
const { sim } = createSimulationFromConfig(await loadGameConfigFile("ilorin-life.yaml"));
```

## Marketplace packs

Worlds, careers, systems, characters, and assets you install instead of building:

```ts
import { installPack, listPacks } from "simkit";

listPacks("world"); // world-lagos, world-ilorin, world-abuja
installPack(sim, "jobs-nigerian-core"); // danfo driver, software engineer, trader, doctor, banker, farmer, student
installPack(sim, "system-nysc");        // allowee day, clearance wahala
installPack(sim, "system-university");  // school fees, exams season, strike risk
installPack(sim, "system-market");      // market boom, price crash, owambe season
installPack(sim, "system-startup");     // founder life, demo day, seed-round dream
installPack(sim, "characters-lagos");   // 3 NPCs, street food, buka business, first-₦100k mission
installPack(sim, "assets-vehicles");    // okada → Benz
installPack(sim, "assets-fashion");     // agbada, ankara, sneakers
```

## Server

```bash
npm run server
```

Opens the API on `http://localhost:8787`, plus two web UIs:

- `/dashboard` — players, economy charts, leaderboards, realtime event log, and world controls (advance time, fund players, trigger events, set prices)
- `/play` — Lagos Life Mini, a complete playable game running on the SDK

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `SIMKIT_API_KEYS` | `simkit-dev` | Comma-separated API keys (`x-api-key` header or `Bearer`) |
| `SIMKIT_NO_AUTH` | — | Set to `1` to disable auth for local dev |
| `SIMKIT_DATA_DIR` | `./.simkit-data` | JSON snapshot directory |
| `SIMKIT_SQLITE_PATH` | — | e.g. `./simkit.db` — durable single-file store instead |
| `SIMKIT_CONFIG` | — | e.g. `./examples/ilorin-life.yaml` — boot an extra game from file |

Persistence is whole-sim snapshots (JSON rows in SQLite, or one JSON file per game). Postgres remains the scale-out answer behind the `Store` interface.

### API reference

All `/v1/*` routes (except `/health`) require the API key. Below, `...` means `/v1/games/:gameId`.

```bash
curl -H "x-api-key: simkit-dev" http://localhost:8787/v1/games
```

**Games:** `GET /v1/games` · `POST /v1/games` · `POST /v1/games/from-config` · `GET /v1/games/:id` · `GET /health`

**Insights:** `GET .../stats` · `.../analytics` (series, wealth buckets, retention) · `.../economy` (issuance, inflation, top jobs/assets, visits, activities) · `.../activation` (road to playable) · `.../leaderboards?metric=wealth&limit=10` · `GET .../log?limit=100` · `GET .../stream` (realtime SSE) · `GET .../snapshot`

**Players:** `POST .../players` · `GET .../players` · `GET .../players/:pid` · `POST .../players/:pid/actions` (`work`, `travel`, `sleep`, `eat`, `accept-job`, `quit-job`) · `.../talk` · `.../buy` · `.../use` · `.../sell` · `.../transfer` · `GET .../players/:pid/rank`

**Businesses & missions:** `GET .../businesses` · `POST .../players/:pid/businesses/:bid/buy` · `.../collect` · `GET .../players/:pid/missions` · `POST .../players/:pid/missions/:mid/accept` · `.../claim`

**Trades:** `GET .../trades?playerId=` · `POST .../trades` · `POST .../trades/:tid/{accept,decline,cancel}`

**World building:** `GET /v1/packs?kind=` · `POST .../packs/:packId/install` · `POST .../{npcs,items,businesses,missions}` · `GET .../versions` · `POST .../migrate {"target":"v2"}`

**Console:** `POST .../console/{give-all,set-price,trigger,reset-economy}` · `POST .../advance {"days":7}`

**Plans:** `GET .../usage` · `POST .../plan {"tier":"developer"}` — free → $29 developer → $99 pro → enterprise custom. Player and event quotas return `429` with upgrade guidance.

## Production notes

**Deterministic.** No `Math.random()` inside the sim — everything flows through a seeded RNG. Same seed plus same actions replays the exact event sequence. `sim.snapshot()` / `Sim.restore()` round-trip clock, players, world, RNG state, and event counts for debugging and replay.

**Versioned worlds.** Rule changes ship as world versions and migrate live games: changed definitions upsert, holders of removed jobs move to a fallback (or quit gracefully), history untouched.

```ts
catalog.define("lagos-life", { version: "v2", jobs: [{ id: "danfo-driver", salary: 200000 }] });
catalog.migrate(sim, "v2");
```

**Event-sourced.** Every meaningful state change is an entry in the event log — the basis for analytics, activation tracking, auditability, and multiplayer.

## Development

```bash
npm run build   # compile the SDK to dist/
npm test        # full suite (vitest)
npm run example # run the Lagos Life Mini demo in your terminal
npm run server  # API + dashboard + playable game
```

```
src/        SDK: simulation engine, entities, packs, remote client
server/     API server, dashboard, playable game, persistence
examples/   lagos-life-mini.ts, ilorin-life.yaml
tests/      core, entities, server, and feature suites
```

## License

MIT — see [LICENSE](LICENSE).
