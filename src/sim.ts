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
import { ActionRefused, invalidInput, type ActionDef, type CauseRecord } from "./runtime/action.js";
import { CORE_ACTIONS } from "./runtime/core-actions.js";
import { ENTITY_ACTIONS } from "./runtime/entity-actions.js";
import { EntityRegistry, type Entity, type EntityDef } from "./entities.js";
import { ScheduleManager, type Schedule, type ScheduleDef } from "./schedules.js";
import { SIM_ACTIONS } from "./runtime/sim-actions.js";
import type { Transaction } from "./wallet.js";

/** A replayed action: its causal record plus the ledger entries and events it produced. */
export interface CauseTrace extends CauseRecord {
  transactions: Transaction[];
  events: SimLogEvent[];
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
  /** Runtime state of NPCs that have acted. Absent on old snapshots. */
  npcActors?: PlayerJSON[];
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
  private causes: CauseRecord[] = [];
  private causeSeq = 0;
  /** Cause id of the action currently executing, so ledger entries can be linked to it. */
  private activeCause: string | undefined;
  /** Generic simulated things that are not players (courses, vehicles, ...). */
  entities = new EntityRegistry();
  /** Recurring obligations settled once per game day through the pipeline. */
  schedules = new ScheduleManager();

  constructor(config: SimConfig, store?: Store) {
    this.gameId = config.gameId;
    this.currency = config.currency ?? "NGN";
    this.seed = config.seed ?? Date.now();
    this.rng = new SeededRng(this.seed);
    this.store = store ?? new InMemoryStore();
    if (config.startingLocation) this.world.define(config.startingLocation);
    this.wirePlayerFactory(config);
    this.businesses = new BusinessManager(this.entities);
    for (const action of [...CORE_ACTIONS, ...SIM_ACTIONS, ...ENTITY_ACTIONS]) this.defineAction(action);
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
      this.playerSeq += 1;
      const id = `player_${this.playerSeq}`;
      const locationId = opts.location ?? this.defaultLocation;
      if (!this.world.has(locationId)) this.world.define(locationId);
      const player = new Player(
        id,
        opts.name,
        locationId,
        opts.startingCash ?? this.defaultStartingCash,
      );
      this.attachHooks(player);
      this.playersMap.set(id, player);
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
      this.causes.push({ ...base, outcome: "refused", reasons: failures, seqFrom, seqTo: this.seq });
      throw new ActionRefused(actionId, failures);
    }

    const previous = this.activeCause;
    this.activeCause = causeId;
    try {
      const result = def.execute({ sim: this, actor, inputs, target, causeId });
      this.emit("ACTION_EXECUTED", { actionId, causeId }, actorId);
      this.causes.push({ ...base, outcome: "ok", reasons: [], seqFrom, seqTo: this.seq });
      return result as R;
    } finally {
      this.activeCause = previous;
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
    const ledger = [...this.playersMap.values()].flatMap((p) => p.wallet.history);
    return this.causes
      .filter((c) => (!actorId || c.actorId === actorId) && c.day >= fromDay && c.day <= toDay)
      .map((c) => ({
        ...c,
        transactions: ledger.filter((t) => t.meta?.causeId === c.id),
        events: this.log.filter((e) => e.seq > c.seqFrom && e.seq <= c.seqTo),
      }));
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
    lines: { category: string; credits: number; debits: number; net: number }[];
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
    const lines = [...byCategory.entries()]
      .map(([category, r]) => ({ category, ...r, net: r.credits - r.debits }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    const net = lines.reduce((s, l) => s + l.net, 0);
    return { playerId, fromDay, toDay, balance: player.wallet.balance, net, lines };
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

  private tickDay(day: number): void {
    this.events.tick(this.eventCtx());
    this.settleSchedules(day);
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
      fired.push(...this.events.tick(this.eventCtx()));
      this.settleSchedules(this.clock.day);
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
      this.emit("CONSOLE_SET_PRICE", { key, multiplier });
    },
    trigger: (id: string): void => this.triggerEvent(id),
    resetEconomy: (): void => {
      for (const p of this.playersMap.values()) p.wallet.reset();
      this.emit("CONSOLE_RESET_ECONOMY", {});
    },
  };

  // ---- marketplace packs (see packs/) ----
  /**
   * Install a marketplace pack (world, jobs, or system) into this Sim.
   * Packs only add/upsert definitions — they never touch players.
   */
  use(pack: {
    locations?: (string | LocationDef)[];
    jobs?: JobDef[];
    events?: EventDefinition[];
    npcs?: NpcDef[];
    items?: ItemDef[];
    businesses?: BusinessDef[];
    missions?: MissionDef[];
  }): void {
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
    this.emit("PACK_INSTALLED", {});
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
      history: [...this.history],
      lastRecordedDay: this.lastRecordedDay,
      causes: [...this.causes],
      entities: this.entities.toJSON(),
      schedules: this.schedules.toJSON(),
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
    sim.log = [...snapshot.log];
    sim.seq = snapshot.log.length;
    sim.playerSeq = snapshot.playerSeq;
    sim.worldVersion = snapshot.worldVersion ?? "v1";
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
