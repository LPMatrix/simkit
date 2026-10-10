# Simulation framework roadmap

Prioritized systems and milestones. Status mirrors BACKLOG.md items 1–7
(all complete at v0.15.1); what follows is P3 and beyond, ranked by
cross-game reuse, developer effort saved, coupling risk, and prototype
evidence. Nothing here is committed — each needs its own spike before
implementation, per the plan's phasing rule.

## What exists (do not rebuild)

Ten built-in systems load through `use()`: jobs, needs, world, market,
social, economy, trades, business, missions, entities. Marketplace packs
(worlds, jobs, systems, characters, assets) and YAML configs compose
content. The spike suite (`experiments/spike.ts`, `npm run spike`) holds
75% supported-as-is (Lagos 100%, Startup 57%, University 77%).

## P3 candidates, ranked

### 1. Relationships and social standing
- **Why first:** the spike's social mechanics are thin (scores without
  decay, no NPC initiative, no groups), and every reference game needs
  them. Highest reuse-to-coupling ratio on the list.
- **Scope:** decay over time, relationship thresholds with events,
  NPC-initiated talk via actor support (already in the runtime),
  group/faction membership as entity relations.
- **Evidence needed:** social loop in two sketches without per-game hacks.

### 2. Skills and progression depth
- **Why:** requirements already read skill stats, but there is no decay,
  no prerequisites, no transcript. Every jobs-adjacent game reinvents this.
- **Scope:** decay, prerequisite graphs, credentials as inventory-like
  holdings. Keep the current `Progression` API compatible.
- **Evidence needed:** University sketch uses prerequisites with no workarounds.

### 3. Locations and travel depth
- **Why:** travel is cost/time on a graph; richer worlds want regions,
  transit schedules, and location capacity. Medium reuse, low coupling.
- **Scope:** regions, scheduled transit (runs on the schedule primitive),
  location state via entities. No coordinates — the runtime stays
  renderer-neutral by spec decision.

### 4. Businesses, markets, and trade depth
- **Why:** needs a real demand signal. The spike's market-demand gap is
  the largest remaining Startup workaround.
- **Scope:** demand-driven `dailyIncome` via an explicit market rule
  (not direct mutation), sell orders beyond direct trades, business
  treasuries so company money separates from owner wealth.
- **Risk:** the most coupling-prone item here; design the market rule as
  an isolated system with its own tests first.

### 5. Crafting and production
- **Why:** FarmSim cannot exist without growth/production primitives.
  Ranked below markets because it needs the demand signal from item 4
  to mean anything economically.
- **Scope:** recipes (inputs→outputs over time), growth stages as entity
  attributes, harvest as an action. Crop specifics stay game-side.

### 6. Missions and objectives depth
- **Why:** the current mission set (earn/wealth/level/relationship/own)
  covers tutorials, not quest chains.
- **Scope:** chains, branching on state, repeatable dailies via
  schedules. Low coupling; can ship independently.

### 7. NPC decision and behavior policies
- **Why:** explicitly out of scope until positioning changes (spec §9:
  no NPC AI platform). Autonomous needs-driven NPCs are the tame subset.
- **Scope:** policy functions selecting among existing actions for NPC
  actors, running in `onTick`. No LLM coupling in the runtime.

## Explicitly not on this roadmap

Renderer, physics, Godot/Unity/Unreal replacement, mandatory genre
mechanics, universal NPC intelligence, multiplayer networking without
validated need, content marketplace with purchases, framework-dictated
economy/narrative/culture. AI decisions, if ever explored, enter as
proposed actions validated by game rules — never as direct state writes.

## Milestone discipline (from the plan, restated)

- Vertical slices: each system ships with docs, diagnostics, and
  integration tests against at least two sketches before the next starts.
- Fix abstraction failures before expanding the catalog.
- No reuse-percentage-only verdicts: shared code requiring workarounds
  is scored as a miss, as the spike already does.
