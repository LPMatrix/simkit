import { GameClock } from "./time.js";
import { World } from "./world.js";
import { JobManager } from "./jobs.js";
import { EventEngine, type EventDefinition } from "./events.js";
import { Player, type PlayerJSON } from "./player.js";
import { SeededRng } from "./rng.js";
import { InMemoryStore, type Store } from "./store.js";
import { NpcManager } from "./npcs.js";
import { ItemCatalog, type ItemDef } from "./inventory.js";
import { BusinessManager, type BusinessDef } from "./businesses.js";
import { MissionManager, type MissionDef } from "./missions.js";
import { TradeLedger, type TradeOffer, type TradeTerms } from "./trades.js";
import { buildLeaderboard, LEADERBOARD_METRICS, type LeaderboardEntry, type LeaderboardMetric } from "./leaderboards.js";
import type { NpcDef } from "./npcs.js";
import type { CreatePlayerOptions, JobDef, LocationDef, SimConfig } from "./types.js";
import type { SimLogEvent } from "./events.js";
import { ActionRefused, invalidInput, type ActionDef, type CauseLink, type CauseRecord } from "./runtime/action.js";
import { BUILTIN_SYSTEMS, isSystem, type System } from "./systems.js";
import type { Pack } from "./packs/worlds.js";
import { EntityRegistry, type Entity, type EntityDef } from "./entities.js";
import { ScheduleManager, type Schedule, type ScheduleDef } from "./schedules.js";
import { createHash } from "node:crypto";
import { SIMULATION_VERSION, canonicalize } from "./version.js";
import type { Transaction } from "./wallet.js";

/** A replayed action: its causal record plus the ledger entries and events it produced. */
export interface CauseTrace extends CauseRecord {
  transactions: Transaction[];
  events: SimLogEvent[];
}

/** Who last changed a price modifier: the record modifier links point at. */
export interface PriceSource {
  day: number;
  /** e.g. "EVENT:fuel-crisis", "console", "system weather". */
  origin: string;
  /** Log seq of the entry that best explains the change, when there is one. */
  eventSeq?: number;
}

/** A node in the causal graph: a recorded action, or a log event it links to. */
export interface GraphNode {
  id: string;
  kind: "cause" | "event";
  actionId?: string;
  type?: string;
  day: number;
  label: string;
}

export interface CausalEdge {
  from: string;
  to: string;
  kind: string;
  label: string;
}

export interface SimSnapshot {
  gameId: string;
  currency: string;
  seed: number | string;
  rngState: number;
  clock: { day: number; minuteOfDay: number };
  players: PlayerJSON[];
  world: ReturnType<World["toJSON"]>;
  jobs: ReturnType<JobManager["toJSON"]>;
  events: EventDefinition[];
  npcs: ReturnType<NpcManager["toJSON"]>;
  items: ReturnType<ItemCatalog["toJSON"]>;
  businesses: ReturnType<BusinessManager["toJSON"]>;
  missions: ReturnType<MissionManager["toJSON"]>;
  trades: ReturnType<TradeLedger["toJSON"]>;
  eventRuntime: ReturnType<EventEngine["toJSON"]>;
  log: SimLogEvent[];
  priceModifiers: Record<string, number>;
  playerSeq: number;
  worldVersion: string;
  history: DayStat[];
  lastRecordedDay: number;
  causes?: CauseRecord[];
  causeSeq?: number;
  entities?: Entity[];
  schedules?: Schedule[];
  priceSources?: Record<string, PriceSource>;
  /** Runtime state of NPCs that have acted. Absent on old snapshots. */
  npcActors?: PlayerJSON[];
  /** Paused flag. Absent (treated as running) on old snapshots. */
  paused?: boolean;
}

export type SimEventHandler = (event: SimLogEvent) => void;

/** One row of economy history, recorded as game days pass. */
export interface DayStat {
  day: number;
  players: number;
  totalCurrency: number;
  avgWealth: number;
  avgLevel: number;
  /** Cumulative simulation log length — deltas are per-day event volume. */
  simEvents: number;
}

/**
 * Root simulation object.
 *
 * ```ts
 * const sim = new Sim({ gameId: "lagos-life", currency: "NGN", seed: 42 });
 * sim.world.define({ id: "yaba", travelCost: 500, travelTimeMinutes: 30 });
 * sim.jobs.define({ id: "danfo-driver", salary: 150000, workingHours: 8 });
 * const player = await sim.players.create({ name: "Mubaraq" });
 * await player.work();
 * ```
 */
export class Sim {
  gameId: string;
  currency: string;
  seed: number | string;
  rng: SeededRng;
  clock = new GameClock();
  world = new World();
  jobs = new JobManager();
  events = new EventEngine();
  npcs = new NpcManager();
  items = new ItemCatalog();
  /** Typed view over the entity registry: every business is a `business` entity. */
  businesses!: BusinessManager;
  missions = new MissionManager();
  trades = new TradeLedger();
  store: Store;
  priceModifiers: Record<string, number> = {};
  /** Current versioned-world tag (see WorldCatalog). Defaults to "v1". */
  worldVersion = "v1";
  /**
   * Frozen world: mutating API calls are rejected with 423 while set.
   * Reads, replay, and explain keep working — pause is for inspection.
   */
  paused = false;

  /** Freeze all mutation; reads and inspection stay available. */
  pause(): void {
    if (!this.paused) {
      this.paused = true;
      this.emit("WORLD_PAUSED", { day: this.clock.day });
    }
  }

  /** Unfreeze a paused world. */
  resume(): void {
    if (this.paused) {
      this.paused = false;
      this.emit("WORLD_RESUMED", { day: this.clock.day });
    }
  }

  private playersMap = new Map<string, Player>();
  private playerSeq = 0;
  private log: SimLogEvent[] = [];
  private seq = 0;
  private handlers = new Map<string, SimEventHandler[]>();
  /** Economy time-series (§7 observability). */
  history: DayStat[] = [];
  private lastRecordedDay = 1;
  /** Registered actions and their causal records (runtime pipeline). */
  private actions = new Map<string, ActionDef<unknown>>();
  /** Installed behavior bundles, oldest first. */
  private installedSystems = new Map<string, System>();
  private causes: CauseRecord[] = [];
  private causeSeq = 0;
  /** Cause id of the action currently executing, so ledger entries can be linked to it. */
  private activeCause: string | undefined;
  /** Links collected by the running action; attached to its cause record. */
  private pendingLinks: CauseLink[] = [];
  /** Last recorded writer per price modifier, for modifier attribution. */
  priceSources: Record<string, PriceSource> = {};
  /** Generic simulated things that are not players (courses, vehicles, ...). */
  entities = new EntityRegistry();
  /** Recurring obligations settled once per game day through the pipeline. */
  schedules = new ScheduleManager();
  /**
   * Freeze intraday clock movement (population-run harness mode). Action
   * energy, money, and state effects still apply; only time stops, so days
   * advance exclusively through advanceDays(). Default false: normal games
   * are unaffected.
   */
  suspendTime = false;

  constructor(config: SimConfig, store?: Store) {
    this.gameId = config.gameId;
    this.currency = config.currency ?? "NGN";
    this.seed = config.seed ?? Date.now();
    this.rng = new SeededRng(this.seed);
    this.store = store ?? new InMemoryStore();
    if (config.startingLocation) this.world.define(config.startingLocation);
    this.wirePlayerFactory(config);
    this.businesses = new BusinessManager(this.entities);
    for (const system of BUILTIN_SYSTEMS) this.use(system);
  }

  private defaultStartingCash = 0;
  private defaultLocation = "home";

  private wirePlayerFactory(config: SimConfig): void {
    this.defaultStartingCash = config.startingCash ?? 50000;
    this.defaultLocation = config.startingLocation ?? "home";
  }

  // ---- events ----
  on(type: string, handler: SimEventHandler): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    return () => {
      const arr = this.handlers.get(type) ?? [];
      this.handlers.set(
        type,
        arr.filter((h) => h !== handler),
      );
    };
  }

  emit(type: string, data?: Record<string, unknown>, playerId?: string): SimLogEvent {
    const event: SimLogEvent = {
      seq: ++this.seq,
      type,
      day: this.clock.day,
      time: this.clock.timeLabel,
      playerId,
      data,
    };
    this.log.push(event);
    for (const h of this.handlers.get(type) ?? []) h(event);
    for (const h of this.handlers.get("*") ?? []) h(event);
    return event;
  }

  get eventLog(): readonly SimLogEvent[] {
    return this.log;
  }

  // ---- players ----
  players = {
    create: async (opts: CreatePlayerOptions): Promise<Player> => {
      const startingCash = opts.startingCash ?? this.defaultStartingCash;
      if (!(startingCash >= 0)) throw invalidInput("startingCash must be >= 0");
      this.playerSeq += 1;
      const id = `player_${this.playerSeq}`;
      const locationId = opts.location ?? this.defaultLocation;
      if (!this.world.has(locationId)) this.world.define(locationId);
      const player = new Player(id, opts.name, locationId, 0);
      this.attachHooks(player);
      this.playersMap.set(id, player);
      // Starting cash is funded as a genesis ledger entry, so money
      // conservation (issued − destroyed = total balance) holds exactly.
      if (startingCash > 0) player.wallet.credit(startingCash, player.stamp("genesis"));
      await this.store.savePlayer(player.toJSON());
      this.emit("PLAYER_CREATED", { name: opts.name }, id);
      return player;
    },

    get: (id: string): Player => {
      const p = this.playersMap.get(id);
      if (!p) throw new Error(`Unknown player: ${id}`);
      return p;
    },

    list: (): Player[] => [...this.playersMap.values()],
    save: async (id: string): Promise<void> => {
      const p = this.players.get(id);
      await this.store.savePlayer(p.toJSON());
    },

    load: async (id: string): Promise<Player> => {
      const json = await this.store.loadPlayer(id);
      if (!json) throw new Error(`No saved player: ${id}`);
      const player = Player.fromJSON(json);
      this.attachHooks(player);
      this.playersMap.set(id, player);
      return player;
    },
  };

  /**
   * NPC actors: runtime state for NPCs that act. An NPC definition (name,
   * home location, dialogue) is static config; the first time an NPC id is
   * used as an actor, a participant state is created for it — same shape and
   * pipeline as a player — and kept here, separate from player accounts.
   * NPC actors are excluded from player listings, analytics, leaderboards,
   * and usage metering, which all read `playersMap`.
   */
  private npcActors = new Map<string, Player>();

  /**
   * Attach a causal link to the action currently executing. Runtime plumbing
   * for actions; a no-op outside an execution.
   */
  addLink(link: CauseLink): void {
    this.pendingLinks.push(link);
  }

  /**
   * Resolve any actor: an account-holding player first, otherwise the NPC's
   * runtime state (created lazily from its definition). Unknown ids throw
   * `Unknown actor` (HTTP 404). Player ids win on collision.
   */
  actorOf(id: string): Player {
    const player = this.playersMap.get(id);
    if (player) return player;
    const npc = this.npcActors.get(id);
    if (npc) return npc;
    const def = this.npcs.has(id) ? this.npcs.get(id) : undefined;
    if (!def) throw new Error(`Unknown actor: ${id}`);
    const actor = new Player(id, def.name, def.location ?? this.defaultLocation, 0);
    this.attachHooks(actor);
    this.npcActors.set(id, actor);
    return actor;
  }

  /** True for account-holding players, as opposed to NPC actors. */
  isPlayer(id: string): boolean {
    return this.playersMap.has(id);
  }

  /** Look up an actor without creating NPC state. Undefined when unknown. */
  actorIfPresent(id: string): Player | undefined {
    return this.playersMap.get(id) ?? this.npcActors.get(id);
  }

  private attachHooks(player: Player): void {
    player.hooks = {
      day: () => this.clock.day,
      time: () => this.clock.timeLabel,
      advanceMinutes: (m: number) => {
        // Suspended in population runs: actions keep their energy and money
        // effects, but intraday time does not move, so N agents acting in
        // sequence don't advance N days per loop-day. Advance days explicitly.
        if (this.suspendTime) return;
        const before = this.clock.day;
        this.clock.advanceMinutes(m);
        // Tick daily events for each day boundary crossed.
        for (let d = before; d < this.clock.day; d++) this.tickDay(d + 1);
        if (this.clock.day !== before) this.maybeRecordDays();
      },
      execute: (actionId, inputs) => this.execute(player.id, actionId, inputs ?? {}),
      cause: () => this.activeCause,
    };
  }

  // ---- actions (runtime pipeline) ----
  /** Register an action. Built-in actions are installed automatically. */
  defineAction<R>(def: ActionDef<R>): void {
    if (!def.id) throw new Error("Action must have an id");
    if (this.actions.has(def.id)) throw new Error(`Action already defined: ${def.id}`);
    this.actions.set(def.id, def as ActionDef<unknown>);
  }

  listActions(): { id: string; description?: string }[] {
    return [...this.actions.values()].map((a) => ({ id: a.id, description: a.description }));
  }

  /**
   * Run an action for an actor (a player, or an NPC acting on its own):
   * check requirements, execute effects, and record a cause. Refused actions
   * move nothing and throw `ActionRefused` (HTTP 400).
   */
  execute<R = unknown>(actorId: string, actionId: string, inputs: Record<string, unknown> = {}): R {
    const def = this.actions.get(actionId);
    if (!def) throw new Error(`Unknown action: ${actionId}`);
    const actor = this.actorOf(actorId);
    // Resolve the target first. Unknown or wrong-kind ids are request errors (404).
    let target: Entity | undefined;
    if (def.targetKind) {
      const targetId = inputs.target;
      if (typeof targetId !== "string" || targetId === "") {
        throw invalidInput("target (string) is required");
      }
      target = this.entities.get(targetId, def.targetKind);
    }
    // Malformed input or unknown ids throw here, before anything is recorded.
    def.validate?.({ sim: this, actor, inputs, target });
    const causeId = `cause_${++this.causeSeq}`;
    const seqFrom = this.seq;
    const base = {
      id: causeId,
      actionId,
      actorId,
      day: this.clock.day,
      time: this.clock.timeLabel,
      inputs: { ...inputs },
    };

    const failures = (def.requires ?? [])
      .map((r) => r.check({ sim: this, actor, inputs, target }))
      .filter((reason): reason is string => reason != null);
    if (failures.length > 0) {
      this.emit("ACTION_REFUSED", { actionId, reasons: failures, causeId }, actorId);
      this.causes.push({ ...base, outcome: "refused", reasons: failures, seqFrom, seqTo: this.seq, links: [] });
      throw new ActionRefused(actionId, failures);
    }

    const previous = this.activeCause;
    const outerLinks = this.pendingLinks;
    this.activeCause = causeId;
    this.pendingLinks = [];
    try {
      const result = def.execute({ sim: this, actor, inputs, target, causeId });
      this.emit("ACTION_EXECUTED", { actionId, causeId }, actorId);
      this.causes.push({ ...base, outcome: "ok", reasons: [], seqFrom, seqTo: this.seq, links: this.pendingLinks });
      return result as R;
    } finally {
      this.activeCause = previous;
      this.pendingLinks = outerLinks;
    }
  }

  /** Causal records, oldest first. */
  causalRecords(): readonly CauseRecord[] {
    return this.causes;
  }

  /**
   * Replay what happened: every action in the window, with the ledger entries
   * and log events it produced. Filter by actor and/or game day (inclusive).
   */
  replay(opts: { actorId?: string; fromDay?: number; toDay?: number } = {}): CauseTrace[] {
    const { actorId, fromDay = 1, toDay = Number.MAX_SAFE_INTEGER } = opts;
    const ledger = [...this.playersMap.values(), ...this.npcActors.values()].flatMap((p) => p.wallet.history);
    return this.causes
      .filter((c) => (!actorId || c.actorId === actorId) && c.day >= fromDay && c.day <= toDay)
      .map((c) => ({
        ...c,
        transactions: ledger.filter((t) => t.meta?.causeId === c.id),
        events: this.log.filter((e) => e.seq > c.seqFrom && e.seq <= c.seqTo),
      }));
  }

  /**
   * The causal graph for a window: recorded actions plus the log events their
   * links point at, with edges between them. Event nodes are id'd
   * `event:<seq>` for log lookup.
   */
  replayGraph(opts: { actorId?: string; fromDay?: number; toDay?: number } = {}): {
    nodes: GraphNode[];
    edges: CausalEdge[];
  } {
    const traces = this.replay(opts);
    const nodes: GraphNode[] = traces.map((t) => ({
      id: t.id,
      kind: "cause" as const,
      actionId: t.actionId,
      day: t.day,
      label: `${t.actionId} (${t.outcome})`,
    }));
    const seenEvents = new Set<number>();
    const edges: CausalEdge[] = [];
    for (const t of traces) {
      for (const link of t.links ?? []) {
        if (link.causeId) {
          edges.push({ from: link.causeId, to: t.id, kind: link.kind, label: link.label });
        } else if (link.eventSeq != null) {
          const eventId = `event:${link.eventSeq}`;
          if (!seenEvents.has(link.eventSeq)) {
            seenEvents.add(link.eventSeq);
            const entry = this.log.find((e) => e.seq === link.eventSeq);
            nodes.push({
              id: eventId,
              kind: "event" as const,
              type: entry?.type,
              day: entry?.day ?? t.day,
              label: entry?.type ?? eventId,
            });
          }
          edges.push({ from: eventId, to: t.id, kind: link.kind, label: link.label });
        }
      }
    }
    return { nodes, edges };
  }

  /**
   * Explain a player's money: net flow per category (salary, food, travel, ...)
   * over an optional day window. Categories come from ledger reasons.
   */
  explain(playerId: string, opts: { fromDay?: number; toDay?: number } = {}): {
    playerId: string;
    fromDay: number;
    toDay: number | null;
    balance: number;
    net: number;
    lines: { category: string; credits: number; debits: number; net: number; why?: string[] }[];
  } {
    const player = this.actorOf(playerId);
    const fromDay = opts.fromDay ?? 1;
    const toDay = opts.toDay ?? null;
    const txs = player.wallet.history.filter(
      (t) => t.day >= fromDay && (toDay == null || t.day <= toDay),
    );
    const byCategory = new Map<string, { credits: number; debits: number }>();
    for (const t of txs) {
      const category = (t.reason ?? "other").split(":")[0];
      const row = byCategory.get(category) ?? { credits: 0, debits: 0 };
      if (t.type === "credit") row.credits += t.amount;
      else row.debits += t.amount;
      byCategory.set(category, row);
    }
    // Modifier links from this actor's causes in the window, grouped by category.
    const whys = new Map<string, string[]>();
    for (const c of this.causes) {
      if (c.actorId !== playerId || c.day < fromDay || (toDay != null && c.day > toDay)) continue;
      for (const link of c.links ?? []) {
        if (link.kind !== "modifier" || !link.category) continue;
        const list = whys.get(link.category) ?? [];
        if (!list.includes(link.label)) list.push(link.label);
        whys.set(link.category, list);
      }
    }
    const lines = [...byCategory.entries()]
      .map(([category, r]) => ({
        category,
        ...r,
        net: r.credits - r.debits,
        ...(whys.has(category) ? { why: whys.get(category) as string[] } : {}),
      }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    const net = lines.reduce((s, l) => s + l.net, 0);
    return { playerId, fromDay, toDay, balance: player.wallet.balance, net, lines };
  }

  /**
   * Golden fingerprint: sha256 over the canonical snapshot. Same code version,
   * seed, and action sequence always produce the same hash. The fingerprint
   * test pins reference worlds to theirs; a changed hash means simulation
   * behavior moved and must be explained with a SIMULATION_VERSION bump.
   */
  fingerprint(): string {
    return createHash("sha256").update(canonicalize(this.snapshot())).digest("hex");
  }

  /** The simulation version this build produces fingerprints for. */
  get simulationVersion(): number {
    return SIMULATION_VERSION;
  }

  /**
   * Structural invariants over live state. Worlds created with genesis
   * accounting satisfy money conservation exactly; older saves predate it.
   */
  checkInvariants(): { id: string; ok: boolean; detail?: string }[] {
    const wallets = [...this.playersMap.values(), ...this.npcActors.values()].map((p) => p.wallet);
    const issued = wallets.flatMap((w) => w.history).filter((t) => t.type === "credit").reduce((s, t) => s + t.amount, 0);
    const destroyed = wallets.flatMap((w) => w.history).filter((t) => t.type === "debit").reduce((s, t) => s + t.amount, 0);
    const balances = wallets.reduce((s, w) => s + w.balance, 0);
    const results: { id: string; ok: boolean; detail?: string }[] = [
      {
        id: "money-conservation",
        ok: balances === issued - destroyed,
        detail: `balances=${balances} issued=${issued} destroyed=${destroyed}`,
      },
      {
        id: "no-negative-balances",
        ok: wallets.every((w) => w.balance >= 0),
        detail: `min=${wallets.length ? Math.min(...wallets.map((w) => w.balance)) : 0}`,
      },
    ];
    const bad = wallets
      .flatMap((w) => w.history)
      .find(
        (t) =>
          (t.type !== "credit" && t.type !== "debit") ||
          typeof t.amount !== "number" ||
          !Number.isFinite(t.amount) ||
          t.amount < 0 ||
          typeof t.reason !== "string" ||
          t.reason === "" ||
          !Number.isInteger(t.day) ||
          t.day < 1,
      );
    results.push({
      id: "ledger-complete",
      ok: !bad,
      detail: bad ? `first bad entry: ${JSON.stringify(bad)}` : "all entries shaped",
    });
    return results;
  }

  // ---- simulation stepping ----
  private eventCtx(playerId?: string) {
    return {
      rng: this.rng,
      day: this.clock.day,
      time: this.clock.timeLabel,
      emit: (type: string, data?: Record<string, unknown>, pid?: string) =>
        this.emit(type, data, pid ?? playerId),
      getPlayer: (id: string) => this.players.get(id),
      priceModifiers: this.priceModifiers,
    };
  }

  /** Process one game day: events, then settlements, then system hooks. Returns fired event ids. */
  private tickDay(day: number): string[] {
    const beforeEvents = { ...this.priceModifiers };
    const seqBefore = this.seq;
    const fired = this.events.tick(this.eventCtx());
    this.notePriceChanges({ modifiers: beforeEvents, seq: seqBefore }, this.describeEventSources(fired, seqBefore));
    this.settleSchedules(day);
    // System hooks run last, observing the day's settled state. A throwing
    // hook is logged and skipped: one bad system must not stall the world.
    for (const s of this.installedSystems.values()) {
      if (!s.onTick) continue;
      const before = { ...this.priceModifiers };
      try {
        s.onTick({ sim: this, day });
      } catch (err) {
        this.emit(
          "SYSTEM_TICK_FAILED",
          { systemId: s.id, error: err instanceof Error ? err.message : String(err) },
        );
      }
      this.notePriceChanges({ modifiers: before, seq: this.seq }, {
        origin: `system ${s.id}`,
        emitEvent: true,
      });
    }
    return fired;
  }

  /**
   * Attribute modifier changes since `before` to a source. Returns true when
   * anything changed. With `emitEvent`, the change is also logged so the
   * source has a log entry to point at.
   */
  private notePriceChanges(
    before: { modifiers: Record<string, number>; seq: number },
    source: { origin: string; eventSeq?: number; emitEvent?: boolean },
  ): boolean {
    let changed = false;
    const keys = new Set([...Object.keys(before.modifiers), ...Object.keys(this.priceModifiers)]);
    for (const key of keys) {
      if (before.modifiers[key] !== this.priceModifiers[key]) {
        changed = true;
        let eventSeq = source.eventSeq;
        if (source.emitEvent) {
          eventSeq = this.emit("PRICE_UPDATED", { key, value: this.priceModifiers[key], origin: source.origin }).seq;
        }
        this.priceSources[key] = { day: this.clock.day, origin: source.origin, eventSeq };
      }
    }
    return changed;
  }

  /** Source description for modifiers changed by a tick's fired events. */
  private describeEventSources(
    fired: string[],
    seqBefore: number,
  ): { origin: string; eventSeq?: number; emitEvent?: boolean } {
    if (fired.length === 1) {
      const entry = this.log.find((e) => e.seq > seqBefore && e.type === `EVENT:${fired[0]}`);
      return { origin: `EVENT:${fired[0]}`, eventSeq: entry?.seq };
    }
    return { origin: `events fired: ${fired.join(", ") || "none"}` };
  }

  /** Human label for a modifier link, e.g. "transport ×1.25 (EVENT:fuel-crisis, day 4)". */
  modifierLabel(key: string): string {
    const mult = this.priceModifiers[key] ?? 1;
    const shown = `×${Math.round(mult * 100) / 100}`;
    const src = this.priceSources[key];
    if (!src) return `${key} ${shown} (source unknown)`;
    return `${key} ${shown} (${src.origin}, day ${src.day})`;
  }

  /**
   * Settle every schedule due on `day` through the `settle-obligation`
   * action, so payments (and misses) get requirements, ledger entries, and
   * causal records. Never throws: a broken schedule is logged as missed and
   * moved past, so one bad definition cannot stall the world.
   */
  private settleSchedules(day: number): void {
    for (const s of this.schedules.dueOn(day)) {
      try {
        this.execute(s.payer, "settle-obligation", { scheduleId: s.id });
        this.advanceSchedule(s, day);
      } catch (err) {
        if (err instanceof ActionRefused) {
          this.emit(
            "OBLIGATION_MISSED",
            { scheduleId: s.id, payer: s.payer, amount: s.amount, reason: err.reasons[0] ?? "refused" },
            s.payer,
          );
          if (s.onMiss === "retry") continue;
          if (s.onMiss === "default") {
            s.active = false;
            this.emit(
              "OBLIGATION_DEFAULTED",
              { scheduleId: s.id, payer: s.payer, amount: s.amount },
              s.payer,
            );
            continue;
          }
          this.advanceSchedule(s, day); // skip
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this.emit(
            "OBLIGATION_MISSED",
            { scheduleId: s.id, payer: s.payer, amount: s.amount, error: message },
            s.payer,
          );
          this.advanceSchedule(s, day);
        }
      }
    }
  }

  private advanceSchedule(s: Schedule, day: number): void {
    do {
      s.nextDue += s.everyDays;
    } while (s.nextDue <= day);
  }

  /** Advance N days, ticking events each day. */
  advanceDays(days: number): string[] {
    const fired: string[] = [];
    for (let i = 0; i < days; i++) {
      this.clock.advanceDays(1);
      fired.push(...this.tickDay(this.clock.day));
    }
    this.maybeRecordDays();
    return fired;
  }

  private recordDay(day: number): void {
    const s = this.stats();
    this.history.push({
      day,
      players: s.totalPlayers,
      totalCurrency: s.totalCurrency,
      avgWealth: s.avgWealth,
      avgLevel: s.avgLevel,
      simEvents: this.log.length,
    });
    if (this.history.length > 730) this.history.splice(0, this.history.length - 730);
  }

  /** Backfill one row per elapsed game day (state is current — trends, not audits). */
  private maybeRecordDays(): void {
    while (this.lastRecordedDay < this.clock.day) {
      this.lastRecordedDay += 1;
      this.recordDay(this.lastRecordedDay);
    }
  }

  /** Dashboard-grade analytics: series, wealth distribution, retention. */
  analytics(): {
    series: DayStat[];
    wealthBuckets: { label: string; count: number }[];
    retention: { total: number; active7d: number; active30d: number };
    eventCounts: Record<string, number>;
  } {
    const players = [...this.playersMap.values()];
    const today = this.clock.day;
    const bands: { label: string; max: number }[] = [
      { label: "< ₦10k", max: 10000 },
      { label: "₦10k–50k", max: 50000 },
      { label: "₦50–200k", max: 200000 },
      { label: "₦200k–1m", max: 1000000 },
      { label: "> ₦1m", max: Number.MAX_SAFE_INTEGER },
    ];
    const wealthBuckets = bands.map((b) => ({ label: b.label, count: 0 }));
    for (const p of players) {
      const idx = bands.findIndex((b) => p.wallet.balance < b.max);
      wealthBuckets[idx === -1 ? wealthBuckets.length - 1 : idx].count += 1;
    }
    return {
      series: [...this.history],
      wealthBuckets,
      retention: {
        total: players.length,
        active7d: players.filter((p) => today - p.lastActiveDay < 7).length,
        active30d: players.filter((p) => today - p.lastActiveDay < 30).length,
      },
      eventCounts: Object.fromEntries(this.events.triggerCounts),
    };
  }

  // ---- leaderboards ----
  leaderboard(metric: LeaderboardMetric = "wealth", limit = 10): LeaderboardEntry[] {
    if (!LEADERBOARD_METRICS.includes(metric)) {
      throw new Error(`Unknown leaderboard metric: ${metric}`);
    }
    return buildLeaderboard([...this.playersMap.values()], metric, limit);
  }

  /** Dense rank of one player (1 = best), or null when unranked. */
  rankOf(playerId: string, metric: LeaderboardMetric = "wealth"): { rank: number; total: number } | null {
    const board = this.leaderboard(metric, Number.MAX_SAFE_INTEGER);
    const entry = board.find((e) => e.playerId === playerId);
    return entry ? { rank: entry.rank, total: board.length } : null;
  }

  // ---- economy observability (§7-8) ----
  economics(): {
    issued: number;
    destroyed: number;
    net: number;
    inflationPct: number;
    topJobs: { id: string; name: string; dailyPay: number }[];
    topAssets: { id: string; name: string; price: number }[];
    locations: { id: string; name: string; residents: number; visits: number }[];
    activities: { type: string; count: number }[];
  } {
    const players = [...this.playersMap.values()];
    let issued = 0;
    let destroyed = 0;
    for (const p of players) {
      for (const tx of p.wallet.history) {
        if (tx.type === "credit") issued += tx.amount;
        else destroyed += tx.amount;
      }
    }
    const mods = Object.values(this.priceModifiers);
    const inflationPct =
      mods.length === 0 ? 0 : Math.round(((mods.reduce((s, m) => s + m, 0) / mods.length - 1) * 100) * 10) / 10;

    const topJobs = this.jobs
      .list()
      .map((j) => ({ id: j.id, name: j.name, dailyPay: this.jobs.dailyPay(j.id) }))
      .sort((a, b) => b.dailyPay - a.dailyPay)
      .slice(0, 5);

    const topAssets = [
      ...this.items.list().map((i) => ({ id: i.id, name: i.name, price: i.price })),
      ...this.businesses.list().map((b) => ({ id: b.id, name: b.name, price: b.cost })),
    ]
      .sort((a, b) => b.price - a.price)
      .slice(0, 5);

    const locations = this.world.list().map((loc) => ({
      id: loc.id,
      name: loc.name,
      residents: players.filter((p) => p.locationId === loc.id).length,
      visits: players.reduce((s, p) => s + (p.visits[loc.id] ?? 0), 0),
    })).sort((a, b) => b.visits - a.visits);

    const activityCounts = new Map<string, number>();
    for (const e of this.log) {
      if (!e.type.startsWith("PLAYER_")) continue;
      activityCounts.set(e.type, (activityCounts.get(e.type) ?? 0) + 1);
    }
    const activities = [...activityCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return { issued, destroyed, net: issued - destroyed, inflationPct, topJobs, topAssets, locations, activities };
  }

  // ---- activation funnel (§22 North Star: games reaching playable state) ----
  /**
   * Where this game sits on the road to playable: created → first player →
   * first job → first paycheck → first trade. Derived from the event log,
   * so it works for every game with zero extra state.
   */
  activation(): { playable: boolean; milestones: { id: string; label: string; reached: boolean; day: number | null }[] } {
    const firstDayOf = (type: string): number | null => {
      const e = this.log.find((l) => l.type === type);
      return e ? e.day : null;
    };
    const firstTradeDay = (): number | null => {
      const e = this.log.find((l) => l.type === "PLAYER_TRANSFERRED" || l.type === "TRADE_ACCEPTED");
      return e ? e.day : null;
    };
    const milestones = [
      { id: "created", label: "Game created", reached: true, day: 1 },
      { id: "first-player", label: "First player", reached: false, day: firstDayOf("PLAYER_CREATED") },
      { id: "first-job", label: "First job accepted", reached: false, day: firstDayOf("JOB_ACCEPTED") },
      { id: "first-paycheck", label: "First paycheck earned", reached: false, day: firstDayOf("PLAYER_WORKED") },
      { id: "first-trade", label: "First player trade", reached: false, day: firstTradeDay() },
    ];
    for (const m of milestones) {
      if (m.day != null) {
        m.reached = true;
      }
    }
    const playable = milestones.find((m) => m.id === "first-paycheck")?.reached ?? false;
    return { playable, milestones };
  }

  /** Manually trigger an event (simulation console). */
  triggerEvent(id: string): void {
    this.events.trigger(id, this.eventCtx());
  }

  // ---- simulation console ----
  console = {
    advanceDay: (): string[] => this.advanceDays(1),
    advanceWeek: (): string[] => this.advanceDays(7),
    giveAll: (amount: number, reason = "console:give"): void => {
      for (const p of this.playersMap.values()) {
        p.wallet.credit(amount, {
          reason,
          day: this.clock.day,
          time: this.clock.timeLabel,
        });
      }
      this.emit("CONSOLE_GIVE_ALL", { amount, reason });
    },
    setPrice: (key: string, multiplier: number): void => {
      this.priceModifiers[key] = multiplier;
      const event = this.emit("CONSOLE_SET_PRICE", { key, multiplier });
      this.priceSources[key] = {
        day: this.clock.day,
        origin: "console",
        eventSeq: event.seq,
      };
    },
    trigger: (id: string): void => this.triggerEvent(id),
    resetEconomy: (): void => {
      for (const p of this.playersMap.values()) p.wallet.reset();
      this.emit("CONSOLE_RESET_ECONOMY", {});
    },
  };

  // ---- marketplace packs and composable systems ----
  /**
   * Install a marketplace pack (world data) or a composable system
   * (actions, schedules, per-day hooks, reports) into this Sim.
   * Neither touches players.
   */
  use(def: Pack | System): void {
    if (isSystem(def)) {
      this.installSystem(def);
      return;
    }
    const pack = def as Pack;
    const hasData =
      pack.locations !== undefined ||
      pack.jobs !== undefined ||
      pack.events !== undefined ||
      pack.npcs !== undefined ||
      pack.items !== undefined ||
      pack.businesses !== undefined ||
      pack.missions !== undefined;
    if (!pack.id || !hasData) throw invalidInput("use() needs a pack or a system");
    for (const loc of pack.locations ?? []) this.world.define(loc);
    for (const job of pack.jobs ?? []) this.jobs.define(job);
    for (const ev of pack.events ?? []) {
      try {
        this.events.define(ev);
      } catch {
        // Already installed: skip.
      }
    }
    for (const npc of pack.npcs ?? []) this.npcs.define(npc);
    for (const item of pack.items ?? []) this.items.define(item);
    for (const biz of pack.businesses ?? []) this.businesses.define(biz);
    for (const mission of pack.missions ?? []) this.missions.define(mission);
    this.emit("PACK_INSTALLED", { packId: pack.id });
  }

  /** Install a behavior bundle. Built-ins load through this same method. */
  installSystem(system: System): void {
    if (!system.id || typeof system.id !== "string") throw invalidInput("System must have an id");
    if (this.installedSystems.has(system.id)) throw invalidInput(`System already installed: ${system.id}`);
    for (const action of system.actions ?? []) this.defineAction(action);
    for (const schedule of system.schedules ?? []) this.schedules.define(schedule, this.clock.day);
    this.installedSystems.set(system.id, system);
    this.emit("SYSTEM_INSTALLED", { systemId: system.id });
  }

  /** Installed systems, oldest first. */
  systems(): { id: string; description?: string }[] {
    return [...this.installedSystems.values()].map((s) => ({ id: s.id, description: s.description }));
  }

  /** One report per installed system that provides one. Report errors propagate to the caller. */
  systemReport(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const s of this.installedSystems.values()) {
      if (s.report) out[s.id] = s.report({ sim: this, day: this.clock.day });
    }
    return out;
  }

  // ---- social, multiplayer, businesses, missions ----
  // Each method below runs a registered action (src/runtime/sim-actions.ts), so
  // it gets requirement checks, refusal records, and causal links. The methods
  // keep the public Sim API stable.

  /** Talk to an NPC in the same location. Returns the seeded dialogue line. */
  talk(playerId: string, npcId: string): { line: string; score: number; level: string } {
    return this.execute<{ line: string; score: number; level: string }>(playerId, "talk", { npcId });
  }

  /** Atomic player-to-player payment. */
  transfer(fromId: string, toId: string, amount: number, reason = "transfer"): void {
    this.execute(fromId, "transfer", { to: toId, amount, reason });
  }

  /** Propose a cash+item swap. Affordability is checked now and again at acceptance. */
  offerTrade(fromId: string, toId: string, terms: TradeTerms): TradeOffer {
    return this.execute<TradeOffer>(fromId, "trade-offer", { to: toId, ...terms });
  }

  /** Counterparty accepts: all legs move atomically or nothing does. */
  acceptTrade(tradeId: string, byPlayerId: string): TradeOffer {
    return this.execute<TradeOffer>(byPlayerId, "trade-accept", { tradeId });
  }

  declineTrade(tradeId: string, byPlayerId: string): TradeOffer {
    return this.execute<TradeOffer>(byPlayerId, "trade-decline", { tradeId });
  }

  cancelTrade(tradeId: string, byPlayerId: string): TradeOffer {
    return this.execute<TradeOffer>(byPlayerId, "trade-cancel", { tradeId });
  }

  listTrades(playerId?: string): TradeOffer[] {
    return this.trades.pendingFor(playerId);
  }

  /** Buy an unowned business. */
  buyBusiness(playerId: string, businessId: string): void {
    this.execute(playerId, "business-buy", { businessId });
  }

  /** Collect accrued daily income since the last collection. */
  collectIncome(playerId: string, businessId: string): number {
    return this.execute<number>(playerId, "business-collect", { businessId });
  }

  acceptMission(playerId: string, missionId: string): void {
    this.execute(playerId, "mission-accept", { missionId });
  }

  missionProgress(playerId: string, missionId: string): { current: number; target: number; done: boolean } {
    const player = this.players.get(playerId);
    const mission = this.missions.get(missionId);
    const g = mission.goal;
    let current = 0;
    let target = 1;
    switch (g.type) {
      case "earn":
        current = player.wallet.totalEarned();
        target = g.target;
        break;
      case "wealth":
        current = player.wallet.balance;
        target = g.target;
        break;
      case "level":
        current = player.progression.level;
        target = g.target;
        break;
      case "relationship":
        current = player.relationships.score(g.npc);
        target = g.target;
        break;
      case "own":
        current = player.inventory.count(g.item);
        target = g.count;
        break;
    }
    return { current, target, done: current >= target };
  }

  /** Claim a completed mission: cash reward + XP, once. */
  claimMission(playerId: string, missionId: string): number {
    return this.execute<number>(playerId, "mission-claim", { missionId });
  }

  // ---- observability (dashboard primitives) ----
  stats(): {
    totalPlayers: number;
    totalCurrency: number;
    avgWealth: number;
    avgLevel: number;
    activeJobs: Record<string, number>;
    eventCounts: Record<string, number>;
  } {
    const players = [...this.playersMap.values()];
    const totalCurrency = players.reduce((s, p) => s + p.wallet.balance, 0);
    const avgWealth = players.length ? totalCurrency / players.length : 0;
    const avgLevel = players.length
      ? players.reduce((s, p) => s + p.progression.level, 0) / players.length
      : 0;
    const activeJobs: Record<string, number> = {};
    for (const p of players) {
      if (p.jobId) activeJobs[p.jobId] = (activeJobs[p.jobId] ?? 0) + 1;
    }
    return {
      totalPlayers: players.length,
      totalCurrency,
      avgWealth,
      avgLevel,
      activeJobs,
      eventCounts: Object.fromEntries(this.events.triggerCounts),
    };
  }

  // ---- persistence + deterministic replay ----
  snapshot(): SimSnapshot {
    return {
      gameId: this.gameId,
      currency: this.currency,
      seed: this.seed,
      rngState: this.rng.getState(),
      clock: this.clock.toJSON(),
      players: [...this.playersMap.values()].map((p) => p.toJSON()),
      npcActors: [...this.npcActors.values()].map((p) => p.toJSON()),
      world: this.world.toJSON(),
      jobs: this.jobs.toJSON(),
      events: this.events.list(),
      npcs: this.npcs.toJSON(),
      items: this.items.toJSON(),
      businesses: this.businesses.toJSON(),
      missions: this.missions.toJSON(),
      trades: this.trades.toJSON(),
      eventRuntime: this.events.toJSON(),
      log: [...this.log],
      priceModifiers: { ...this.priceModifiers },
      playerSeq: this.playerSeq,
      worldVersion: this.worldVersion,
      paused: this.paused,
      history: [...this.history],
      lastRecordedDay: this.lastRecordedDay,
      causes: [...this.causes],
      entities: this.entities.toJSON(),
      schedules: this.schedules.toJSON(),
      priceSources: Object.fromEntries(
        Object.entries(this.priceSources).map(([k, v]) => [k, { ...v }]),
      ),
      causeSeq: this.causeSeq,
    };
  }

  static restore(snapshot: SimSnapshot, store?: Store): Sim {
    const sim = new Sim(
      { gameId: snapshot.gameId, currency: snapshot.currency, seed: snapshot.seed },
      store,
    );
    sim.rng.setState(snapshot.rngState);
    sim.clock = GameClock.fromJSON(snapshot.clock);
    sim.world = World.fromJSON(snapshot.world);
    sim.jobs = JobManager.fromJSON(snapshot.jobs);
    sim.npcs = NpcManager.fromJSON(snapshot.npcs ?? []);
    sim.items = ItemCatalog.fromJSON(snapshot.items ?? []);
    // Entities before the business manager: it is a view over this registry.
    sim.entities = EntityRegistry.fromJSON(snapshot.entities);
    sim.schedules = ScheduleManager.fromJSON(snapshot.schedules);
    sim.businesses = new BusinessManager(sim.entities);
    // Legacy snapshots carry a businesses array without entities: import it.
    // New snapshots already contain the same businesses as entities, so this is a no-op for them.
    sim.businesses.importLegacy(snapshot.businesses ?? []);
    sim.missions = MissionManager.fromJSON(snapshot.missions ?? []);
    sim.trades = TradeLedger.fromJSON(snapshot.trades ?? []);
    sim.priceModifiers = { ...snapshot.priceModifiers };
    sim.priceSources = Object.fromEntries(
      Object.entries(snapshot.priceSources ?? {}).map(([k, v]) => [k, { ...v }]),
    );
    sim.log = [...snapshot.log];
    sim.seq = snapshot.log.length;
    sim.playerSeq = snapshot.playerSeq;
    sim.worldVersion = snapshot.worldVersion ?? "v1";
    sim.paused = snapshot.paused ?? false;
    sim.causes = [...(snapshot.causes ?? [])];
    sim.causeSeq = snapshot.causeSeq ?? sim.causes.length;
    sim.history = [...(snapshot.history ?? [])];
    sim.lastRecordedDay = snapshot.lastRecordedDay ?? snapshot.clock.day;
    sim.playersMap.clear();
    for (const pj of snapshot.players) {
      const p = Player.fromJSON(pj);
      sim.attachHooks(p);
      sim.playersMap.set(p.id, p);
    }
    sim.npcActors.clear();
    for (const aj of snapshot.npcActors ?? []) {
      const actor = Player.fromJSON(aj);
      sim.attachHooks(actor);
      sim.npcActors.set(actor.id, actor);
    }
    for (const def of snapshot.events) sim.events.define(def);
    sim.events.restoreCounts(snapshot.eventRuntime);
    return sim;
  }

  /** Replay the exact log sequence (audit/debug): returns logged types in order. */
  replayLog(): string[] {
    return this.log.map((e) => `day${e.day} ${e.time} ${e.type}`);
  }
}

/** Declarative world setup: `createSimulation({ currency, locations, jobs })`. */
export function createSimulation(opts: {
  gameId?: string;
  currency?: string;
  seed?: number | string;
  startingCash?: number;
  startingLocation?: string;
  locations?: (string | LocationDef)[];
  jobs?: JobDef[];
  events?: EventDefinition[];
  npcs?: NpcDef[];
  items?: ItemDef[];
  businesses?: BusinessDef[];
  missions?: MissionDef[];
  entities?: EntityDef[];
  schedules?: ScheduleDef[];
  store?: Store;
}): Sim {
  const sim = new Sim(
    {
      gameId: opts.gameId ?? "sim-game",
      currency: opts.currency ?? "NGN",
      seed: opts.seed,
      startingCash: opts.startingCash,
      startingLocation: opts.startingLocation,
    },
    opts.store,
  );
  for (const loc of opts.locations ?? []) sim.world.define(loc);
  for (const job of opts.jobs ?? []) sim.jobs.define(job);
  for (const ev of opts.events ?? []) sim.events.define(ev);
  for (const npc of opts.npcs ?? []) sim.npcs.define(npc);
  for (const item of opts.items ?? []) sim.items.define(item);
  for (const biz of opts.businesses ?? []) sim.businesses.define(biz);
  for (const mission of opts.missions ?? []) sim.missions.define(mission);
  for (const entity of opts.entities ?? []) sim.entities.define(entity);
  for (const schedule of opts.schedules ?? []) sim.schedules.define(schedule);
  return sim;
}
