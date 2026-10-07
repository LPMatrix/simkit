import { promises as fs } from "node:fs";
import { join } from "node:path";
import { Sim, type SimSnapshot } from "../src/index.js";
import { WorldCatalog } from "../src/worlds.js";
import { Meter } from "./metering.js";

/** Seed content for the default game so the API boots with a playable world. */
export function lagosSeed(): {
  gameId: string;
  currency: string;
  seed: number;
  startingCash: number;
  locations: { id: string; name: string; travelCost: number; travelTimeMinutes: number }[];
  jobs: { id: string; name: string; salary: number; location?: string; workingHours: number; energyCost: number; requirements?: Record<string, number> }[];
  events: { id: string; name: string; probability: number; cooldownDays?: number }[];
} {
  return {
    gameId: "lagos-life",
    currency: "NGN",
    seed: 42,
    startingCash: 50000,
    locations: [
      { id: "yaba", name: "Yaba", travelCost: 500, travelTimeMinutes: 30 },
      { id: "ikeja", name: "Ikeja", travelCost: 1000, travelTimeMinutes: 60 },
      { id: "lekki", name: "Lekki", travelCost: 2000, travelTimeMinutes: 90 },
      { id: "surulere", name: "Surulere", travelCost: 700, travelTimeMinutes: 40 },
      { id: "vi", name: "Victoria Island", travelCost: 2500, travelTimeMinutes: 100 },
    ],
    jobs: [
      { id: "software-developer", name: "Software Developer", salary: 350000, location: "yaba", workingHours: 8, energyCost: 25, requirements: { coding: 50 } },
      { id: "danfo-driver", name: "Danfo Driver", salary: 150000, workingHours: 10, energyCost: 35 },
      { id: "trader", name: "Trader", salary: 200000, workingHours: 9, energyCost: 30 },
      { id: "banker", name: "Banker", salary: 400000, workingHours: 9, energyCost: 28, requirements: { finance: 40 } },
    ],
    events: [
      { id: "fuel-crisis", name: "Fuel Price Increase", probability: 0.05 },
      { id: "rent-due", name: "Rent Due", probability: 0.03, cooldownDays: 25 },
      { id: "salary-day", name: "Salary Day", probability: 0.04 },
      { id: "traffic", name: "Lagos Traffic", probability: 0.08 },
    ],
  };
}

/** Multi-game registry with JSON-file snapshot persistence (Postgres later). */
export class GameRegistry {
  private games = new Map<string, Sim>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  /** Usage metering per game (plan tiers). */
  readonly meter = new Meter();
  /** Versioned world definitions per game. */
  readonly catalog = new WorldCatalog();

  constructor(private dataDir: string | null) {}

  private snapshotPath(gameId: string): string | null {
    if (!this.dataDir) return null;
    return join(this.dataDir, `${gameId}.json`);
  }

  async init(): Promise<void> {
    if (this.dataDir) await fs.mkdir(this.dataDir, { recursive: true });
    // Load persisted games, else boot default.
    if (this.dataDir) {
      const files = await fs.readdir(this.dataDir).catch(() => []);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(join(this.dataDir, f), "utf8");
          const snap = JSON.parse(raw) as SimSnapshot;
          const sim = Sim.restore(snap);
          this.games.set(sim.gameId, sim);
        } catch {
          // Corrupt snapshot: skip, re-seed below if registry ends up empty.
        }
      }
    }
    if (this.games.size === 0) {
      const seed = lagosSeed();
      const { createSimulation, installPack } = await import("../src/index.js");
      const sim = createSimulation(seed);
      installPack(sim, "characters-lagos");
      this.games.set(sim.gameId, sim);
      await this.persist(sim.gameId);
    }
    this.seedVersionDefs();
  }

  /**
   * Demo version history for lagos-life: v1 is the boot world,
   * v2 bumps danfo pay ₦150k → ₦200k and adds a minimum-wage event.
   */
  private seedVersionDefs(): void {
    if (this.catalog.list("lagos-life").length > 0) return;
    this.catalog.define("lagos-life", { version: "v1" });
    this.catalog.define("lagos-life", {
      version: "v2",
      jobs: [{ id: "danfo-driver", salary: 200000, workingHours: 10, energyCost: 35 }],
      events: [{ id: "minimum-wage", name: "Minimum Wage Review", probability: 0.02 }],
    });
  }

  list(): Sim[] {
    return [...this.games.values()];
  }

  get(gameId: string): Sim {
    const sim = this.games.get(gameId);
    if (!sim) {
      const err = new Error(`Unknown game: ${gameId}`) as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    return sim;
  }

  has(gameId: string): boolean {
    return this.games.has(gameId);
  }

  async create(opts: {
    gameId: string;
    currency?: string;
    seed?: number | string;
    startingCash?: number;
    locations?: (string | { id: string; name?: string; travelCost?: number; travelTimeMinutes?: number })[];
    jobs?: { id: string; name?: string; salary: number; location?: string; workingHours?: number; energyCost?: number; requirements?: Record<string, number> }[];
    events?: { id: string; name?: string; probability: number; once?: boolean; cooldownDays?: number }[];
  }): Promise<Sim> {
    if (this.games.has(opts.gameId)) {
      const err = new Error(`Game already exists: ${opts.gameId}`) as Error & { status?: number };
      err.status = 409;
      throw err;
    }
    const { createSimulation } = await import("../src/index.js");
    const sim = createSimulation({
      gameId: opts.gameId,
      currency: opts.currency ?? "NGN",
      seed: opts.seed,
      startingCash: opts.startingCash,
      locations: opts.locations as never,
      jobs: opts.jobs as never,
      events: opts.events as never,
    });
    this.games.set(sim.gameId, sim);
    await this.persist(sim.gameId);
    return sim;
  }

  /** Persist snapshot to disk (debounced fire-and-forget + awaitable). */
  async persist(gameId: string): Promise<void> {
    const path = this.snapshotPath(gameId);
    if (!path) return;
    const sim = this.games.get(gameId);
    if (!sim) return;
    const raw = JSON.stringify(sim.snapshot());
    await fs.writeFile(path, raw, "utf8");
  }

  schedulePersist(gameId: string): void {
    const existing = this.saveTimers.get(gameId);
    if (existing) return;
    const t = setTimeout(() => {
      this.saveTimers.delete(gameId);
      void this.persist(gameId);
    }, 200);
    // Don't keep the process alive just for a pending snapshot write.
    if (typeof t.unref === "function") t.unref();
    this.saveTimers.set(gameId, t);
  }
}
