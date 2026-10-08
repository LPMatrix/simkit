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

**State.** Players, businesses, NPCs, items, and jobs are plain data behind a small API. Money lives in an auditable ledger, where each entry records its reason, time, and the action that caused it.

**Events.** Declarative world events with probability, cooldown, conditions, and effects. Effects can change prices (`priceModifiers`) that actions apply at execution time. If an effect fails, the tick continues and an `EVENT_EFFECT_FAILED` entry is logged.

**Randomness.** All randomness goes through a seeded RNG (`world.rng`). Given the same seed and the same sequence of actions, you get the same results. This is covered by tests; there are no golden fingerprints yet.

**Persistence.** `world.snapshot()` and `Sim.restore()` round-trip the whole world, including causal records. The server stores snapshots in SQLite or JSON files. Postgres is the planned scale-out path behind the `Store` interface.

## Explanations and replay

```ts
world.explain(alice.id, { fromDay: 1, toDay: 7 });
// { balance, net, lines: [{ category: "salary", credits, debits, net }, ...] }

world.replay({ actorId: alice.id, fromDay: 1, toDay: 7 });
// [{ actionId, outcome, transactions, events, ... }, ...]
```

Replay returns the recorded actions and what each one produced. It does not reconstruct arbitrary past state, and it doesn't yet model causal chains across actions, such as a fuel price rise leading to debt. Those are on the roadmap.

## Domain systems

SimKit ships these as building blocks. They are generic, not tied to one setting:

| System | What it provides |
|---|---|
| Economy | Wallets with auditable transactions, market modifiers, issuance and destruction stats |
| Jobs | Hiring, work shifts, pay on a schedule, skill requirements, energy costs |
| Locations | Location graph with travel cost and time, visit tracking |
| Needs | Energy and health, restored by sleep, food, and items |
| Relationships | NPCs with locations, dialogue drawn from the seeded RNG, relationship levels |
| Businesses | Ownership, daily income, collection |
| Assets | Items with prices, effects, buying, selling, and trading |
| Progression | Skills, XP and levels, achievements |
| Missions | Goals (earn, wealth, level, relationship, ownership) with rewards |
| Multiplayer | Direct transfers and trade offers that settle atomically |
| Worlds | Declarative config (YAML or JSON), installable packs, versioned rules with migrations |

Lagos Life, Ilorin Life, and the other packs are examples of how these systems are configured. They are not the framework's scope. See `examples/`.

## Tools

- **Server**: `npm run server` starts an HTTP API with API-key auth, realtime event streams, and a dashboard at `/dashboard`.
- **Dashboard**: game state, economy charts, leaderboards, the event log, and world controls (advance time, fund players, trigger events, set prices).
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

- recurring obligations (rent, payroll) are expressed as events, not as schedules
- there is no generic entity type beyond players, businesses, and NPCs
- events can only reach a player by id, and their effect context is restricted

## Roadmap

- [x] Actions and rules pipeline with refusals and causal records
- [x] Deterministic, seeded simulation
- [x] Replay and explanations (per actor, per day window)
- [ ] First-class entity and actor model
- [ ] Recurring schedules (obligations, payroll)
- [ ] Composable simulation systems
- [ ] Causal chains across actions
- [ ] Population simulation
- [ ] Simulation testing
- [ ] Simulation Control Room (pause, inspect, and step the world)
- [ ] More domain packs
- [ ] Engine and backend integrations

## Development

```bash
npm run build      # compile to dist/
npm test           # test suite
npm run spike      # the three-domain experiment
npm run server     # API, dashboard, and playable example
```

```text
src/          runtime, domain systems, packs, remote client
server/       HTTP API, dashboard, persistence
examples/     worked examples and config files
experiments/  cross-domain experiments
tests/        test suites
docs/         API reference
```

## Philosophy

Games shouldn't have to reinvent the machinery that makes their worlds behave.

Define the world. Define the rules. Let SimKit run it.

## License

MIT. See [LICENSE](LICENSE).
