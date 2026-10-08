import { Wallet } from "./wallet.js";
import { Progression, type ProgressionJSON } from "./progression.js";
import { Inventory, type InventoryJSON } from "./inventory.js";
import { Relationships } from "./relationships.js";
import type { MissionState } from "./missions.js";

export interface PlayerJSON {
  id: string;
  name: string;
  locationId: string;
  energy: number;
  health: number;
  reputation: number;
  jobId: string | null;
  wallet: { balance: number; history: Wallet["history"] };
  progression: ProgressionJSON;
  inventory: InventoryJSON;
  relationships: Record<string, number>;
  missions: Record<string, MissionState>;
  lastActiveDay: number;
  visits: Record<string, number>;
  /** Course entities this player is enrolled in. */
  enrolments?: Record<string, boolean>;
}

/** Services the Sim provides to each player. Wired by Sim; not serialized. */
export interface PlayerHooks {
  day: () => number;
  time: () => string;
  advanceMinutes: (minutes: number) => void;
  /** Run a registered action for this player through the sim's pipeline. */
  execute: (actionId: string, inputs?: Record<string, unknown>) => unknown;
  /** Cause id of the action currently executing, if any. */
  cause: () => string | undefined;
}

function clamp(n: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * A simulated participant: cash, energy, health, reputation, location, inventory.
 *
 * Methods that change state (travel, sleep, eat, work, buy, sell, use, job
 * changes) run as actions through the sim's pipeline, so they get requirement
 * checks, refusals, and causal records. The methods here are thin wrappers.
 */
export class Player {
  id: string;
  name: string;
  locationId: string;
  energy = 100;
  health = 100;
  reputation = 0;
  jobId: string | null = null;
  wallet: Wallet;
  progression = new Progression();
  inventory = new Inventory();
  relationships = new Relationships();
  missions: Record<string, MissionState> = {};
  lastActiveDay = 1;
  /** Travel arrivals per location — drives "most visited" stats. */
  visits: Record<string, number> = {};
  /** Course entities this player is enrolled in. */
  enrolments: Record<string, boolean> = {};

  /** Wired by Sim; not serialized. */
  hooks!: PlayerHooks;

  constructor(id: string, name: string, locationId: string, startingCash = 0) {
    this.id = id;
    this.name = name;
    this.locationId = locationId;
    this.wallet = new Wallet(startingCash);
  }

  /** Ledger metadata: reason, game time, and the cause id of any running action. */
  stamp(reason?: string): { reason?: string; day: number; time: string; causeId?: string } {
    return { reason, day: this.hooks.day(), time: this.hooks.time(), causeId: this.hooks.cause() };
  }

  /** Mark the player active today (drives retention analytics). */
  touch(): void {
    this.lastActiveDay = this.hooks.day();
  }

  adjustEnergy(delta: number): void {
    this.energy = clamp(this.energy + delta);
  }

  adjustHealth(delta: number): void {
    this.health = clamp(this.health + delta);
  }

  adjustReputation(delta: number): void {
    this.reputation += delta;
  }

  // ---- actions (see src/runtime/core-actions.ts) ----

  /** Travel to a location. Costs money and time. */
  travel(toId: string): void {
    this.hooks.execute("travel", { to: toId });
  }

  /** Sleep for `hours`: time passes, energy and health recover. */
  sleep(hours = 8): void {
    this.hooks.execute("sleep", { hours });
  }

  /** Eat a meal. */
  eat(cost = 1500, energyGain = 25): void {
    this.hooks.execute("eat", { cost, energyGain });
  }

  /** Take a job you qualify for. */
  acceptJob(jobId: string): void {
    this.hooks.execute("accept-job", { jobId });
  }

  /** Leave your current job. No-op when unemployed. */
  quitJob(): void {
    this.hooks.execute("quit-job");
  }

  /** Work one shift: consumes time + energy, pays daily wage, grants XP. */
  work(): number {
    return this.hooks.execute("work") as number;
  }

  /** Buy items at catalog price. */
  buy(itemId: string, qty = 1): void {
    this.hooks.execute("buy", { itemId, qty });
  }

  /** Use one unit of an item. */
  use(itemId: string): void {
    this.hooks.execute("use", { itemId });
  }

  /** Sell items back at 50% of catalog price (rounded down). Returns the amount received. */
  sell(itemId: string, qty = 1): number {
    return this.hooks.execute("sell", { itemId, qty }) as number;
  }

  // ---- serialization ----

  toJSON(): PlayerJSON {
    return {
      id: this.id,
      name: this.name,
      locationId: this.locationId,
      energy: this.energy,
      health: this.health,
      reputation: this.reputation,
      jobId: this.jobId,
      wallet: this.wallet.toJSON(),
      progression: this.progression.toJSON(),
      inventory: this.inventory.toJSON(),
      relationships: this.relationships.toJSON(),
      missions: JSON.parse(JSON.stringify(this.missions)) as Record<string, MissionState>,
      lastActiveDay: this.lastActiveDay,
      visits: { ...this.visits },
      enrolments: { ...this.enrolments },
    };
  }

  static fromJSON(json: PlayerJSON): Player {
    const p = new Player(json.id, json.name, json.locationId, 0);
    p.energy = json.energy;
    p.health = json.health;
    p.reputation = json.reputation;
    p.jobId = json.jobId;
    p.wallet = Wallet.fromJSON(json.wallet);
    p.progression = Progression.fromJSON(json.progression);
    p.inventory = Inventory.fromJSON(json.inventory);
    p.relationships = Relationships.fromJSON(json.relationships);
    p.missions = { ...(json.missions ?? {}) };
    p.lastActiveDay = json.lastActiveDay ?? 1;
    p.visits = { ...(json.visits ?? {}) };
    p.enrolments = { ...(json.enrolments ?? {}) };
    return p;
  }
}
