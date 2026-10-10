# Current capabilities (P0 audit)

Audited 2026-10-09 against implementation and tests (`src/`, 23 test files,
~170 passing tests, `examples/`, `server/`). Baseline: v0.15.1,
SIMULATION_VERSION 2. Status values: **complete**, **partial**,
**primitive-only** (data model without behavior), **absent**.

## Capability matrix

### Runtime (core)

| Capability | Status | Evidence |
|---|---|---|
| Action execution with requirements | complete | `Sim.execute` (`src/sim.ts`): validate → all requirements collected → execute; `ActionRefused` carries every reason; `tests/runtime.test.ts` |
| Input validation vs refusal split | complete | `validate` throws before anything is recorded; requirements failures record a refused cause; both map to HTTP 400 |
| First-class action registry | complete | `defineAction` (duplicate ids throw), `listActions`, 23 built-in actions across 10 systems |
| Custom (developer-defined) actions | complete | `defineAction` + `requirements.*` helpers; `tests/runtime.test.ts` "developer-defined actions" |
| Targeted actions (`targetKind`) | complete | Runtime resolves `inputs.target` before validation; 404 on unknown/wrong-kind; `tests/entities-model.test.ts` |
| NPCs as actors | complete | `actorOf()` lazily creates participant state for NPC ids; same pipeline, own causal records; excluded from player listings/analytics/metering; `tests/npc-actors.test.ts` |
| Seeded RNG, no `Math.random` | complete | `SeededRng` (mulberry32); repo-wide grep finds no `Math.random`; `Date.now()` only in default seed, metering windows, sqlite metadata |
| Simulation time | complete | `GameClock`, Monday 08:00 start; actions consume time; `advanceDays`; intraday suspension flag for population runs (`suspendTime`) |
| Events (probability/cooldown/condition) | complete | `EventEngine.tick`; failing effects log `EVENT_EFFECT_FAILED` without stalling |
| Schedules (recurring obligations) | complete | `ScheduleManager` + `settle-obligation` action; skip/retry/default policies; `OBLIGATION_MISSED`/`DEFAULTED`; `tests/schedules.test.ts` |
| Wallet + auditable ledger | complete | Every credit/debit is a transaction with reason/day/cause; genesis funding for starting cash; `totalEarned` excludes genesis |
| Causal records + links | complete | Every attempt recorded (ok/refused) with log seq range; modifier and trade links; `tests/causality.test.ts` |
| Replay + causal graph | complete | `replay()` per actor/day window; `replayGraph()` with cause and event nodes |
| Explanations | complete | `explain()` per-category flows with `why` labels naming triggers |
| Snapshots + restore | complete | Whole-world JSON incl. causes, entities, schedules, price sources, NPC actors, paused flag; `??` defaults keep old saves loading |
| Golden fingerprints | complete | `SIMULATION_VERSION` + `tests/fingerprints.json`; v1→v2 bump proven to be exactly the `paused` field |
| Invariants | complete | `checkInvariants()`: conservation, no-negative-balances, ledger shape |
| Population runs | complete | `simulate()` + CLI; loop-days equal clock-days via time suspension; invariant violations flagged |
| Pause/resume | complete | `sim.pause()` persists; dispatcher rejects mutation with 423; reads pass |
| World versioning + migrations | complete | `WorldCatalog`, salary-bump demo, safe handling of removed jobs |

### Domain systems

| System | Status | Notes |
|---|---|---|
| Jobs | complete behavior | Definitions, eligibility, work/quit, wages via economy, energy via needs |
| Needs (sleep/eat) | complete behavior | Thresholds via requirements; no generic need abstraction (energy/health are player fields) |
| Inventory + items | complete behavior | Quantities, validated add/remove/use, buy/sell, 50% resale |
| Businesses | complete behavior | Entity-backed ownership, buy/collect, hire/payroll, employees with balances |
| Missions | complete behavior | earn/wealth/level/relationship/own goals, accept/claim-once, XP |
| Relationships | partial | Score levels + talk; no decay, no NPC-initiated social, no factions |
| Progression | partial | Skills/XP/levels/achievements; no skill decay, no prerequisites graph |
| Economy integration | complete | Consistent ledger, price modifiers applied at execution, issuance/destruction stats, inflation metric |
| Trading (P2P + offers) | complete | Atomic transfers, propose/accept/decline/cancel with revalidation |
| Leaderboards | complete | Dense-ranked wealth/level/XP/reputation + per-player rank |
| Locations/travel | complete behavior | Graph with cost/time, visit tracking |
| NPCs | partial | Defs + dialogue + actors; no autonomous behavior policies, no AI |
| Courses (entities) | complete behavior | Generic entity + `enrol` with capacity/fee/seats |
| Vehicles/clothing/assets | primitive-only | Exist as items in packs; no special behavior |
| Farming/crops | absent | No growth, watering, yield concepts |
| Factions/reputation | absent | Reputation is a scalar; no group membership |
| Crafting/production | absent | No recipes, inputs→outputs, durability |

### Tooling and platform

| Capability | Status | Notes |
|---|---|---|
| Composable systems (`world.use`) | complete | Actions, schedules, `onTick`, reports; built-ins load through the same path; duplicate installs throw |
| System tick hooks | complete | Run after events+settlements on both advance paths; throwing hooks logged (`SYSTEM_TICK_FAILED`) not fatal |
| System reports | partial | `systemReport()` merges; no dashboard surface yet |
| Dashboard (Control Room) | complete | Inspector (find actor, explain, replay/graph), pause UI, console, charts; player table capped at 500 rows |
| Playable reference (`/play`) | complete | Lagos Life Mini through the API |
| Marketplace packs | complete (install) | 10 packs; purchase/billing absent by spec decision |
| YAML/JSON config | complete | Validated parsing, packs + versions + schedules; `SIMKIT_CONFIG` boot, `from-config` endpoint |
| CLI (`simulate`) | complete | Population runs with progress + JSON output; bin wiring verified |
| HTTP API + SSE + auth | complete | ~50 routes, API-key auth, 401/404/400/409/413/423/429 mapping |
| SQLite / JSON persistence | complete | Whole-sim snapshots; Postgres behind `Store` interface (not implemented) |
| Usage metering + plans | complete | Per-game tiers enforced with 429 |
| Docs (README, API.md) | complete | Shippable; roadmap checkboxes current through item 7 |

## Verified guarantees

1. **Refusals move nothing.** Requirements run before effects; verified by tests asserting balances/inventory unchanged plus a refused cause record.
2. **Tick order is fixed:** events → price attribution → schedule settlement → system hooks, on both `advanceDays` and midnight-crossing actions (`tickDay` is the single choke point).
3. **Failing effects/hooks never stall the world.** Event effects log `EVENT_EFFECT_FAILED`; system hooks log `SYSTEM_TICK_FAILED`; broken schedules log `OBLIGATION_MISSED` and advance.
4. **Determinism is per code version.** Same seed + same actions ⇒ same state (fingerprinted). Seeds are NOT stable across versions; that is what `SIMULATION_VERSION` exists to mark.
5. **Snapshots are backward compatible.** Every post-v1 field restores with `??` defaults; proven by legacy-restore tests.
6. **Money is conserved.** Genesis funding makes issued − destroyed = total balance exact; enforced by `checkInvariants()`.

## All state mutation paths (complete enumeration)

1. Action `execute()` bodies (tracked: cause record + stamped ledger entries).
2. `players.create` genesis funding (tracked: `genesis` ledger entry).
3. Event effect callbacks (tracked in log as `EVENT:<id>` + ledger entries, but **without** cause ids — see gap 1).
4. Schedule settlement (tracked: runs through `settle-obligation` action).
5. System `onTick` hooks (tracked only if the hook emits/logs; raw attribute writes are **untracked** — see gap 2).
6. Console actions (tracked: log entries + ledger where money moves).
7. Direct property writes in tests/experiments (e.g. spike mutates `dailyIncome`; not part of the SDK surface).

**Gap 1:** ledger entries written by event effects carry no cause id, so `replay()` (which joins on causes) omits them. Replay is action-complete, not ledger-complete.
**Gap 2:** system hooks may mutate entity attributes directly with no record. The weather test system does this for prices (mitigated: price diffs are attributed). Arbitrary attribute writes are invisible.

## API limitations and breaking-change risks

- `errStatus` maps errors by message regex: new error messages silently become HTTP 500 until the regex grows. `ActionRefused`/`invalidInput` carry `.status`; extend that convention instead.
- `sim.use()` discriminates packs vs systems by shape (`isSystem`); a pack-shaped object with an `actions` array would misroute. Low risk, documented here.
- `inputs: { ...inputs }` in cause records is a shallow copy; nested input objects are shared references.
- `replay()` joins ledger entries from player + NPC wallets only; entity balances (employee pay) are not ledger entries and never appear in replay.
- `explain()` categories derive from reason prefixes (`reason.split(":")[0]`); games must keep reason conventions stable.
- `GET /players` defaults to the full list; `?limit=` exists but clients must opt in.
- NPC actor ids share a namespace with player ids (`player_N`); players win collisions by design, not by validation.
- Third-party systems must be reinstalled by host code after snapshot restore (actions are code, not state).
- `SIMULATION_VERSION` covers behavior-affecting changes; purely additive fields (like `paused`) still move the hash and require the bump ritual.

## Baselines

- Examples: `examples/lagos-life-mini.ts`, `examples/lagos-life.yaml`, `examples/ilorin-life.yaml` (all runnable).
- Experiments: `experiments/spike.ts` — Lagos 100%, Startup 57%, University 77% supported-as-is; overall 75%.
- Tests: 23 files, ~170 passing; golden file pins 2 reference hashes with reasons.
- Release: `@sirmatrix/simkit@0.15.0` on npm (local 0.15.1 pending publish decision).
