# SimKit

### Build the rules. SimKit runs the world.

SimKit is a TypeScript simulation runtime and domain SDK for developers building **systemic worlds**.

Define your world's entities, actions, rules, time, and systems. SimKit handles the machinery required to execute, persist, inspect, and replay the resulting simulation.

```text
Your Game
    ↓
Your Rules & Systems
    ↓
┌──────────────────────────────┐
│           SimKit             │
│                              │
│  Actions     Rules           │
│  State       Time            │
│  Events      RNG             │
│  Persistence Replay          │
│  Explanations                │
└──────────────────────────────┘
    ↓
Your Backend / Database
```



## Why SimKit?

Systemic games are difficult to build because the complexity isn't just in rendering the world. It's in making the world **behave consistently**.

A character gets a job. The job produces income. Income affects what they can afford. Transport costs eat into that income. Prices change. Events propagate. Relationships create obligations. Businesses employ people.

These systems interact continuously, which creates a large state-transition problem underneath the game. SimKit provides the runtime for it.

## Example

Instead of hand-writing state changes everywhere:

```ts
player.money -= 1500
player.energy -= 20
player.location = "Lekki"
player.experience += 5
```

You define an action once, with the requirements it needs and the effects it has:

```ts
world.defineAction({
  id: "buy-tools",
  requires: [
    requirements.hasCash(200),
    { id: "rested", check: ({ actor }) => (actor.energy >= 20 ? null : "Too tired to shop") },
  ],
  execute({ actor }) {
    actor.wallet.debit(200, actor.stamp("tools"));
    actor.progression.addStat("craft", 1);
  },
});

world.execute(alice.id, "buy-tools"); // throws ActionRefused, with every reason, if a requirement fails
```

SimKit checks the requirements first. If they fail, nothing moves and the refusal is recorded. If they pass, the effects run, and every ledger entry and event they produce is linked to that action.

```text
Action
  ↓
Requirements
  ↓
Effects
  ↓
State Transition
  ↓
Events + Ledger (linked to the action)
```



## Quickstart

```bash
npm install simkit
```

```ts
import { createSimulation, requirements } from "simkit";

const world = createSimulation({
  gameId: "harbour-town",
  seed: 42,
  currency: "USD",
  startingCash: 1000,
  locations: [
    { id: "docks", travelCost: 5, travelTimeMinutes: 20 },
    { id: "market", travelCost: 0, travelTimeMinutes: 10 },
  ],
  jobs: [{ id: "porter", salary: 3000, workingHours: 8, energyCost: 25 }],
  events: [{ id: "storm", probability: 0.05 }],
});

const alice = await world.players.create({ name: "Alice", location: "docks" });
alice.acceptJob("porter");
alice.work();              // time passes, energy drops, pay is credited
alice.travel("market");    // travel costs money and time

world.advanceDays(7);      // daily events tick

console.log(world.explain(alice.id));                 // where the money went, by category
console.log(world.replay({ actorId: alice.id }));     // every action, with its ledger entries
```



## Concepts

**Actions.** Every state change is an action with requirements and effects. Built-in actions cover movement, work, purchases, trades, and missions. You can define your own with `defineAction`. Refused actions move nothing and are recorded with every reason.

**Time.** The world has its own clock. Actions consume game time, and `advanceDays` moves the world forward. Nothing depends on wall-clock time.

**State.** Players, businesses, NPCs, items, and jobs are plain data behind a small API. Any other kind of thing (a course, a vehicle) is an entity: an action can target it with `targetKind`, and the runtime resolves and validates it before any rule runs. Money lives in an auditable ledger, where each entry records its reason, time, and the action that caused it.

**Systems.** Behavior installs as systems with `world.use()`: actions enter the pipeline, schedules start ticking, and an `onTick` hook runs once per game day after events and settlements. The ten built-in systems (jobs, needs, world, market, social, economy, trades, business, missions, entities) load through this same path. A throwing hook is logged as `SYSTEM_TICK_FAILED` and skipped — one bad system never stalls the world.

**Events.** Declarative world events with probability, cooldown, conditions, and effects. Effects can change prices (`priceModifiers`) that actions apply at execution time. If an effect fails, the tick continues and an `EVENT_EFFECT_FAILED` entry is logged.

**Randomness.** All randomness goes through a seeded RNG (`world.rng`). Given the same seed and the same sequence of actions, you get the same results. `tests/fingerprints.json` pins reference-world hashes: a changed hash fails the build unless `SIMULATION_VERSION` is bumped and the reason recorded.

**Persistence.** `world.snapshot()` and `Sim.restore()` round-trip the whole world, including causal records. The server stores snapshots in SQLite or JSON files. Postgres is the planned scale-out path behind the `Store` interface.

## Explanations and replay

```ts
world.explain(alice.id, { fromDay: 1, toDay: 7 });
// { balance, net, lines: [{ category: "salary", credits, debits, net, why? }, ...] }

world.replay({ actorId: alice.id, fromDay: 1, toDay: 7 });
// [{ actionId, outcome, transactions, events, links, ... }, ...]

world.replayGraph({ actorId: alice.id });
// { nodes: [...actions + referenced events], edges: [{ from, to, kind, label }] }
```

Replay returns the recorded actions and what each one produced. It does not reconstruct arbitrary past state.

Actions that were shaped by earlier triggers carry links: travel under raised transport prices points at the event (or console call, or system) that set them, and a trade acceptance points at its proposal. `explain` attaches those labels to the affected money lines, so a travel line can say why it cost more. `replayGraph` returns the same links as traversable edges.

## Domain systems

SimKit ships these as building blocks. They are generic, not tied to one setting:


| System        | What it provides                                                                      |
| ------------- | ------------------------------------------------------------------------------------- |
| Economy       | Wallets with auditable transactions, market modifiers, issuance and destruction stats |
| Jobs          | Hiring, work shifts, pay on a schedule, skill requirements, energy costs              |
| Locations     | Location graph with travel cost and time, visit tracking                              |
| Needs         | Energy and health, restored by sleep, food, and items                                 |
| Relationships | NPCs with locations, dialogue drawn from the seeded RNG, relationship levels          |
| Businesses    | Ownership, daily income, collection, hiring employees, payroll                        |
| Assets        | Items with prices, effects, buying, selling, and trading                              |
| Progression   | Skills, XP and levels, achievements                                                   |
| Missions      | Goals (earn, wealth, level, relationship, ownership) with rewards                     |
| Multiplayer   | Direct transfers and trade offers that settle atomically                              |
| Worlds        | Declarative config (YAML or JSON), installable packs, versioned rules with migrations |


Lagos Life, Ilorin Life, and the other packs are examples of how these systems are configured. They are not the framework's scope. See `examples/`.

## Tools

- **Server**: `npm run server` starts an HTTP API with API-key auth, realtime event streams, and a dashboard at `/dashboard`.
- **Dashboard**: game state, economy charts, leaderboards, the event log, world controls (advance time, fund players, trigger events, set prices), pause/resume, and an inspector — pick any player or NPC, see their money explained, and browse their actions with causal links.
- **Client**: `SimClient` mirrors the local API over HTTP, so the same game code can run embedded or hosted.
- **Simulation console**: `world.console` for dev-time control (give money, set prices, trigger events, advance time).

See [docs/API.md](docs/API.md) for the endpoint reference.

## Use it embedded or hosted

**Embedded.** The SDK runs in your process. Good for single-player games, prototypes, and tests.

**Hosted.** Run the server and talk to the same world over HTTP. Good for multiplayer games, live dashboards, and anything with more than one client.

```ts
import { SimClient } from "simkit";

const client = new SimClient({ baseUrl: "http://localhost:8787", apiKey: "simkit-dev", gameId: "harbour-town" });
const alice = await client.createPlayer({ name: "Alice" });
await client.acceptJob(alice.id, "porter");
await client.work(alice.id);
await client.advance(7);
```



## Not what SimKit is

SimKit is not a generic game backend. Use your existing infrastructure for authentication, databases, networking, multiplayer, hosting, and payments. SimKit covers the layer those systems don't: **the semantics and execution of the simulated world.**

## Status

SimKit is pre-1.0 and evolving in public. The runtime is being tested against different simulation domains to find which abstractions hold. The `experiments/` directory runs three sketches (life, startup, and university worlds) against the public API. Current gaps, found there and tracked below:

- obligations (rent, bills, tuition) are schedules; company payroll stays a manual action
- generic entities (courses, employees, businesses) can be targeted by actions, and NPCs can act through the same pipeline as players — but only players hold accounts
- events can only reach a player by id, and their effect context is restricted



## Roadmap

- [x] Simulation Control Room (pause, inspect, and step the world)
- [ ] More domain packs
- [ ] Engine and backend integrations



## Development

```bash
npm run build      # compile to dist/
npm test           # test suite
npm run spike      # the three-domain experiment
npm run server     # API, dashboard, and playable example
npm run simulate -- --config ./examples/lagos-life.yaml --population 100 --days 30 --seeds 3
```

```text
src/          runtime, domain systems, packs, remote client
server/       HTTP API, dashboard, persistence
examples/     worked examples and config files
experiments/  cross-domain experiments
tests/        test suites (including golden fingerprints in tests/fingerprints.json)
docs/         API reference
```

`sim.checkInvariants()` verifies money conservation (starting cash is funded as a `genesis` ledger entry, so issued − destroyed always equals total balance), no negative balances, and ledger entry shape. Worlds created before genesis accounting predate the conservation check.

## Population runs

`simulate()` runs headless worlds for balancing: N agents follow a daily routine for D days across several seeds, and the report aggregates wealth, employment, bankruptcy, obligations, and invariant violations.

```ts
import { simulate } from "simkit";

const report = await simulate({
  world: cfg, // a GameConfigFile, or (seed) => Sim factory
  population: 1000,
  days: 365,
  seeds: [1, 2, 3],
  // behavior, employ: "auto" | "none"
});
```

```bash
npx simkit simulate --config ./examples/lagos-life.yaml --population 1000 --days 365 --seeds 10
```

Each loop iteration is exactly one clock day: intraday time is suspended during the run (energy, money, and state effects still apply) so sequential agents don't advance the shared clock faster than the loop. Days advance explicitly, and every settlement, event, and hook fires exactly once per day. The default routine works, sleeps, and eats; pass `behavior` to test your own policies. Runs that violate invariants are flagged in the report instead of failing silently.

## Philosophy

Games shouldn't have to reinvent the machinery that makes their worlds behave.

Define the world. Define the rules. Let SimKit run it.

## License

MIT. See [LICENSE](LICENSE).