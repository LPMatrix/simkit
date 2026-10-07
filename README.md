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
```
