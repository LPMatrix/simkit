# Simulation system contract

What a system may assume, what it must provide, and where the boundaries
are. Verified against `src/sim.ts`, `src/runtime/*`, `src/systems.ts`,
and `src/events.ts`. This contract constrains P1–P2 work: do not add a
registry or plugin layer unless `world.use(system)` cannot meet a need
stated here.

## Identity and versioning

- A system has a unique string `id` plus optional `description`.
- Duplicate installation throws (`System already installed`); there is no
  reinstall-or-merge semantic. Hosts reinstall from scratch.
- Behavior-affecting runtime changes bump `SIMULATION_VERSION`
  (`src/version.ts`) with the reason recorded in `tests/fingerprints.json`.
- World content versions separately via `WorldCatalog` (`worldVersion`
  `v1`, `v2`, …). Runtime version ≠ world version; do not conflate them.

## Dependencies

- A system declares `dependencies: string[]` naming systems that must
  already be installed. Installation checks them first, before registering
  anything, and throws naming every missing id with install order guidance.
- There is no auto-install: the host installs in dependency order
  explicitly. Depending on built-in primitives (jobs, items, wallet) needs
  no declaration; depending on another third-party system does.

## Installation lifecycle

1. Host calls `sim.use(system)` (or lists it in `BUILTIN_SYSTEMS`).
2. The runtime registers `actions` (duplicate action ids throw),
   defines `schedules` anchored at the current game day, records the id,
   and emits `SYSTEM_INSTALLED`.
3. Installation never touches players or existing state.
4. On snapshot restore, only built-in systems return (the constructor
   reinstalls them). **Hosts must reinstall third-party systems after
   restore** — actions are code and are not persisted.

## Configuration

- Configuration is the `System` object itself plus whatever the system
  reads from world state (entities, jobs, items it defines at install).
- `define`-style upserts apply: redefining jobs/items/entities replaces
  definitions; schedules and actions reject duplicates. Systems must not
  depend on install order beyond their own definitions.
- Invalid configuration throws `invalidInput` (HTTP 400) with a message
  naming the field. Silent defaults for required fields are forbidden.

## Actions and events

- Systems contribute behavior exclusively through registered `ActionDef`s.
- Requirements run before effects; all failures are collected and
  reported; refused actions move nothing and are recorded.
- `validate` is for malformed input (unrecorded, HTTP 400).
  Unknown ids must throw `Unknown <kind>` so HTTP maps them to 404.
- Systems may emit log events with `sim.emit`. Event names should be
  namespaced by system where practical (`PRICE_UPDATED` carries
  `systemId`); generic `PLAYER_*` names are reserved for the core.
- Systems must not call `sim.execute` for another actor inside `execute`
  (no nested actions); orchestration belongs in game code, not systems.

## Tick behavior and ordering

- `tickDay` is the single choke point, reached from both `advanceDays`
  and midnight-crossing actions. Fixed order per day:
  1. random events fire,
  2. price changes from events are attributed,
  3. schedules settle (each at most once per elapsed period),
  4. system `onTick` hooks run, oldest-installed first.
- Hooks observe settled state. A throwing hook is logged as
  `SYSTEM_TICK_FAILED` with its `systemId` and skipped; it must not
  stall the tick or leave partial writes unreported — hooks that can
  fail midway must validate first.
- Hooks must be deterministic functions of `(sim state, seeded RNG)`.
  Wall-clock time, network, and unseeded randomness inside a hook void
  the determinism guarantee for that world.

## State ownership and mutation

- Each manager owns its data: jobs→`JobManager`, items→`ItemCatalog`,
  businesses→`BusinessManager` (a view over entities), schedules→
  `ScheduleManager`, entities→`EntityRegistry`, players→`playersMap`.
- Systems mutate only through these managers or through the acting
  player's own methods. Direct writes to another system's private state
  are forbidden; attribute maps (`entity.attributes.*`, `priceModifiers`)
  are the shared scratch space, and writes there should emit a log event.
- Money moves only through `Wallet.credit`/`debit` (always with a
  reason), which is what keeps conservation and `explain()` exact.
- Player energy/health change only via `adjustEnergy`/`adjustHealth`
  (clamped 0–100). No direct field writes outside `fromJSON`.

## Queries and reports

- `systems()` lists installed `{ id, description }`.
- `systemReport()` merges per-system `report({ sim, day })` output keyed
  by system id. Report functions must be pure reads; a throwing report
  propagates to the caller (dashboard included) — keep them cheap.
- No dashboard surface is required for a system to be complete, but any
  operator-facing state should be reachable through `report()`.

## Snapshot, restore, compatibility

- All system state must live in serializable manager/entity state so
  `snapshot()` captures it. Runtime-only state (timers, sockets,
  compiled closures) must never hold simulation truth.
- Restore uses `??` defaults so old saves load; every new persisted
  field needs a default and a legacy-restore test.
- Installed third-party system *ids* are not persisted. If P1 wants
  restore-time reinstallation, it must also solve version skew between
  the saved world and the reinstalled code.

## Determinism

- Seeded RNG only (`sim.rng`). No `Math.random`, no wall clock in
  decisions, no unseeded iteration that affects outcomes (`Map`
  insertion order is deterministic given identical operation order and
  is relied upon).
- `Date.now()` is allowed only in infrastructure metadata (metering
  windows, sqlite timestamps), never in simulated state.
- Starting cash defaults and id counters (`player_N`, `tx_N`,
  `cause_N`) are part of the deterministic surface: reset counters in
  tests that compare fingerprints.

## Error behavior

- Request errors (bad input, unknown ids): throw with `.status`
  (`invalidInput` → 400, `Unknown X` → 404 via the HTTP mapper).
- Rule failures: throw `ActionRefused` (400) with every reason; state
  is untouched and the refusal is recorded.
- Tick-time failures: log and continue (`EVENT_EFFECT_FAILED`,
  `SYSTEM_TICK_FAILED`, `OBLIGATION_MISSED`); never throw out of a tick.
- Programmer errors (duplicate definitions, bad wiring): throw plain
  `Error` (HTTP 500). These indicate bugs, not user input.

## Replay, explanation, invariants

- Every action attempt produces a cause record, including refusals.
- Ledger entries written inside an action carry its cause id via
  `stamp()`; entries written by event effects do not (known gap —
  replay is action-complete, not ledger-complete).
- Cross-action links (`modifier`, `trade`) attach in `execute` via
  `addLink`; replay and graph expose them, `explain` surfaces matching
  `why` labels.
- Systems that move money must use ledger reasons whose first segment
  is a stable category (`reason.split(":")[0]`), or their flows will
  not appear correctly in `explain()`.
- Population runs (`simulate()`) flag invariant violations per world
  instead of failing silently; violations fail the run report.
