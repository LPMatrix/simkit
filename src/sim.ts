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
import type { NpcDef } from "./npcs.js";
import type { CreatePlayerOptions, JobDef, LocationDef, SimConfig } from "./types.js";
import type { SimLogEvent } from "./events.js";

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
  businesses = new BusinessManager();
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

  constructor(config: SimConfig, store?: Store) {
    this.gameId = config.gameId;
    this.currency = config.currency ?? "NGN";
    this.seed = config.seed ?? Date.now();
    this.rng = new SeededRng(this.seed);
    this.store = store ?? new InMemoryStore();
    if (config.startingLocation) this.world.define(config.startingLocation);
    this.wirePlayerFactory(config);
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
      travelCost: (toId: string) => {
        const loc = this.world.get(toId);
        return { cost: loc.travelCost, minutes: loc.travelTimeMinutes };
      },
      assertLocation: (id: string) => {
        this.world.get(id);
      },
      assertJob: (id: string) => {
        this.jobs.get(id);
      },
      dailyPay: (jobId: string) => this.jobs.dailyPay(jobId),
      jobEnergyCost: (jobId: string) => this.jobs.get(jobId).energyCost,
      jobWorkingHours: (jobId: string) => this.jobs.get(jobId).workingHours,
      jobRequirements: (jobId: string) => this.jobs.get(jobId).requirements,
      getItem: (id: string) => this.items.get(id),
      log: (type, data, playerId) => {
        this.emit(type, data, playerId);
      },
    };
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

  private tickDay(_day: number): void {
    this.events.tick(this.eventCtx());
  }

  /** Advance N days, ticking events each day. */
  advanceDays(days: number): string[] {
    const fired: string[] = [];
    for (let i = 0; i < days; i++) {
      this.clock.advanceDays(1);
      fired.push(...this.events.tick(this.eventCtx()));
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

  // ---- social: NPCs, relationships ----
  /**
   * Talk to an NPC. Requires being in the same location.
   * Returns the (seeded, deterministic) dialogue line.
   */
  talk(playerId: string, npcId: string): { line: string; score: number; level: string } {
    const player = this.players.get(playerId);
    const npc = this.npcs.get(npcId);
    if (npc.location && npc.location !== player.locationId) {
      throw new Error(`${npc.name} is at ${npc.location} — travel there first`);
    }
    player.touch();
    const before = player.relationships.level(npcId);
    const line = this.rng.pick(npc.dialogue);
    this.clock.advanceMinutes(15);
    const score = player.relationships.adjust(npcId, 6);
    const level = player.relationships.level(npcId);
    this.emit("PLAYER_TALKED", { npcId, line, score }, playerId);
    if (level !== before) {
      player.adjustReputation(5);
      this.emit("RELATIONSHIP_LEVEL_UP", { npcId, level }, playerId);
    }
    return { line, score, level };
  }

  // ---- multiplayer: player-to-player transfers ----
  /** Atomic P2P payment. Creates paired debit/credit transactions. */
  transfer(fromId: string, toId: string, amount: number, reason = "transfer"): void {
    if (fromId === toId) throw new Error("Cannot transfer to yourself");
    if (!(amount > 0)) throw new Error("Transfer amount must be positive");
    const from = this.players.get(fromId);
    const to = this.players.get(toId);
    from.touch();
    to.touch();
    const day = this.clock.day;
    const time = this.clock.timeLabel;
    from.wallet.debit(amount, { reason: `${reason}:to:${toId}`, day, time });
    to.wallet.credit(amount, { reason: `${reason}:from:${fromId}`, day, time });
    this.emit("WALLET_DEBITED", { amount, reason }, fromId);
    this.emit("WALLET_CREDITED", { amount, reason }, toId);
    this.emit("PLAYER_TRANSFERRED", { from: fromId, to: toId, amount }, fromId);
  }

  // ---- multiplayer: trade offers (propose / accept / decline) ----
  /** Propose a cash+item swap. The offer side is validated now AND at acceptance. */
  offerTrade(fromId: string, toId: string, terms: TradeTerms): TradeOffer {
    const from = this.players.get(fromId);
    this.players.get(toId); // fail fast on unknown counterparty
    if ((terms.offerCash ?? 0) > from.wallet.balance) {
      throw new Error("You can't afford what you're offering");
    }
    for (const [id, qty] of Object.entries(terms.offerItems ?? {})) {
      if (from.inventory.count(id) < qty) throw new Error(`You don't have ${qty}x ${id}`);
    }
    const offer = this.trades.propose(fromId, toId, terms, this.clock.day);
    from.touch();
    this.emit("TRADE_PROPOSED", { tradeId: offer.id, to: toId }, fromId);
    return offer;
  }

  /** Counterparty accepts: all legs move atomically or nothing does. */
  acceptTrade(tradeId: string, byPlayerId: string): TradeOffer {
    const offer = this.trades.get(tradeId);
    if (offer.status !== "pending") throw new Error(`Trade is already ${offer.status}`);
    if (offer.to !== byPlayerId) throw new Error("Only the counterparty can accept");
    const from = this.players.get(offer.from);
    const to = this.players.get(offer.to);
    if (from.wallet.balance < offer.offerCash) {
      throw new Error(`${from.name} can no longer afford this trade`);
    }
    if (to.wallet.balance < offer.askCash) {
      throw new Error(`${to.name} can no longer afford this trade`);
    }
    for (const [id, qty] of Object.entries(offer.offerItems)) {
      if (from.inventory.count(id) < qty) throw new Error(`${from.name} no longer has ${qty}x ${id}`);
    }
    for (const [id, qty] of Object.entries(offer.askItems)) {
      if (to.inventory.count(id) < qty) throw new Error(`${to.name} no longer has ${qty}x ${id}`);
    }
    const stamp = { day: this.clock.day, time: this.clock.timeLabel };
    const moveCash = (a: typeof from, b: typeof to, amount: number): void => {
      if (amount <= 0) return;
      a.wallet.debit(amount, { reason: `trade:${tradeId}:to:${b.id}`, ...stamp });
      b.wallet.credit(amount, { reason: `trade:${tradeId}:from:${a.id}`, ...stamp });
    };
    moveCash(from, to, offer.offerCash);
    moveCash(to, from, offer.askCash);
    const moveItems = (a: typeof from, b: typeof to, items: Record<string, number>): void => {
      for (const [id, qty] of Object.entries(items)) {
        a.inventory.remove(id, qty);
        b.inventory.add(id, qty);
      }
    };
    moveItems(from, to, offer.offerItems);
    moveItems(to, from, offer.askItems);
    from.touch();
    to.touch();
    this.trades.markAccepted(tradeId);
    this.emit("TRADE_ACCEPTED", { tradeId, from: from.id, to: to.id }, to.id);
    return this.trades.get(tradeId);
  }

  declineTrade(tradeId: string, byPlayerId: string): TradeOffer {
    const offer = this.trades.decline(tradeId, byPlayerId);
    this.emit("TRADE_DECLINED", { tradeId }, byPlayerId);
    return offer;
  }

  cancelTrade(tradeId: string, byPlayerId: string): TradeOffer {
    const offer = this.trades.cancel(tradeId, byPlayerId);
    this.emit("TRADE_CANCELLED", { tradeId }, byPlayerId);
    return offer;
  }

  listTrades(playerId?: string): TradeOffer[] {
    return this.trades.pendingFor(playerId);
  }

  // ---- businesses ----
  buyBusiness(playerId: string, businessId: string): void {
    const player = this.players.get(playerId);
    const biz = this.businesses.get(businessId);
    if (biz.ownerId) throw new Error(`${biz.name} is already owned`);
    player.touch();
    player.wallet.debit(biz.cost, {
      reason: `business:${businessId}`,
      day: this.clock.day,
      time: this.clock.timeLabel,
    });
    biz.ownerId = playerId;
    biz.lastCollectedDay = this.clock.day;
    this.emit("BUSINESS_BOUGHT", { businessId, cost: biz.cost }, playerId);
  }

  /** Collect accrued daily income since last collection. */
  collectIncome(playerId: string, businessId: string): number {
    const player = this.players.get(playerId);
    const biz = this.businesses.get(businessId);
    if (biz.ownerId !== playerId) throw new Error(`You don't own ${biz.name}`);
    player.touch();
    const days = this.clock.day - biz.lastCollectedDay;
    if (days <= 0) throw new Error(`${biz.name} has nothing to collect yet — come back tomorrow`);
    const payout = biz.dailyIncome * days;
    biz.lastCollectedDay = this.clock.day;
    player.wallet.credit(payout, {
      reason: `business-income:${businessId}`,
      day: this.clock.day,
      time: this.clock.timeLabel,
    });
    this.emit("BUSINESS_INCOME", { businessId, days, payout }, playerId);
    return payout;
  }

  // ---- missions ----
  acceptMission(playerId: string, missionId: string): void {
    const player = this.players.get(playerId);
    this.missions.get(missionId);
    player.touch();
    const state = (player.missions[missionId] ??= { accepted: false, claimed: false });
    if (state.accepted) throw new Error("Mission already accepted");
    state.accepted = true;
    this.emit("MISSION_ACCEPTED", { missionId }, playerId);
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

  /** Claim a completed mission: cash reward + XP. */
  claimMission(playerId: string, missionId: string): number {
    const player = this.players.get(playerId);
    const mission = this.missions.get(missionId);
    player.touch();
    const state = player.missions[missionId];
    if (!state?.accepted) throw new Error("Mission not accepted yet");
    if (state.claimed) throw new Error("Mission reward already claimed");
    const { done } = this.missionProgress(playerId, missionId);
    if (!done) throw new Error("Mission goal not complete yet");
    state.claimed = true;
    player.wallet.credit(mission.reward, {
      reason: `mission:${missionId}`,
      day: this.clock.day,
      time: this.clock.timeLabel,
    });
    player.progression.addXp(mission.xp ?? 20);
    this.emit("MISSION_COMPLETED", { missionId, reward: mission.reward }, playerId);
    return mission.reward;
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
    sim.businesses = BusinessManager.fromJSON(snapshot.businesses ?? []);
    sim.missions = MissionManager.fromJSON(snapshot.missions ?? []);
    sim.trades = TradeLedger.fromJSON(snapshot.trades ?? []);
    sim.priceModifiers = { ...snapshot.priceModifiers };
    sim.log = [...snapshot.log];
    sim.seq = snapshot.log.length;
    sim.playerSeq = snapshot.playerSeq;
    sim.worldVersion = snapshot.worldVersion ?? "v1";
    sim.history = [...(snapshot.history ?? [])];
    sim.lastRecordedDay = snapshot.lastRecordedDay ?? snapshot.clock.day;
    sim.playersMap.clear();
    for (const pj of snapshot.players) {
      const p = Player.fromJSON(pj);
      sim.attachHooks(p);
      sim.playersMap.set(p.id, p);
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
  locations?: (string | LocationDef)[];
  jobs?: JobDef[];
  events?: EventDefinition[];
  npcs?: NpcDef[];
  items?: ItemDef[];
  businesses?: BusinessDef[];
  missions?: MissionDef[];
  store?: Store;
}): Sim {
  const sim = new Sim(
    {
      gameId: opts.gameId ?? "sim-game",
      currency: opts.currency ?? "NGN",
      seed: opts.seed,
      startingCash: opts.startingCash,
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
  return sim;
}
