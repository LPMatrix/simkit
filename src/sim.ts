import { GameClock } from "./time.js";
import { World } from "./world.js";
import { JobManager } from "./jobs.js";
import { EventEngine, type EventDefinition } from "./events.js";
import { Player, type PlayerJSON } from "./player.js";
import { SeededRng } from "./rng.js";
import { InMemoryStore, type Store } from "./store.js";
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
  eventRuntime: ReturnType<EventEngine["toJSON"]>;
  log: SimLogEvent[];
  priceModifiers: Record<string, number>;
  playerSeq: number;
}

export type SimEventHandler = (event: SimLogEvent) => void;

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
  store: Store;
  priceModifiers: Record<string, number> = {};

  private playersMap = new Map<string, Player>();
  private playerSeq = 0;
  private log: SimLogEvent[] = [];
  private seq = 0;
  private handlers = new Map<string, SimEventHandler[]>();

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
    return fired;
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
      eventRuntime: this.events.toJSON(),
      log: [...this.log],
      priceModifiers: { ...this.priceModifiers },
      playerSeq: this.playerSeq,
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
    sim.priceModifiers = { ...snapshot.priceModifiers };
    sim.log = [...snapshot.log];
    sim.seq = snapshot.log.length;
    sim.playerSeq = snapshot.playerSeq;
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
  return sim;
}
