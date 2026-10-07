import { Wallet } from "./wallet.js";
import { Progression, type ProgressionJSON } from "./progression.js";
import { Inventory, type InventoryJSON, type Item } from "./inventory.js";
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
}

export interface PlayerHooks {
  day: () => number;
  time: () => string;
  travelCost: (toId: string) => { cost: number; minutes: number };
  assertLocation: (id: string) => void;
  dailyPay: (jobId: string) => number;
  jobEnergyCost: (jobId: string) => number;
  jobWorkingHours: (jobId: string) => number;
  jobRequirements: (jobId: string) => Record<string, number>;
  assertJob: (id: string) => void;
  getItem: (id: string) => Item;
  log: (type: string, data?: Record<string, unknown>, playerId?: string) => void;
  advanceMinutes: (minutes: number) => void;
}

function clamp(n: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, n));
}

/** Playable agent: cash, energy, health, reputation, location, inventory-ish stats. */
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

  /** Wired by Sim; not serialized. */
  hooks!: PlayerHooks;

  constructor(id: string, name: string, locationId: string, startingCash = 0) {
    this.id = id;
    this.name = name;
    this.locationId = locationId;
    this.wallet = new Wallet(startingCash);
  }

  private stamp(reason?: string): { reason?: string; day: number; time: string } {
    return { reason, day: this.hooks.day(), time: this.hooks.time() };
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

  travel(toId: string): void {
    this.touch();
    this.hooks.assertLocation(toId);
    if (toId === this.locationId) return;
    const { cost, minutes } = this.hooks.travelCost(toId);
    if (cost > 0) this.wallet.debit(cost, this.stamp(`travel:${this.locationId}->${toId}`));
    this.hooks.advanceMinutes(minutes);
    this.locationId = toId;
    this.visits[toId] = (this.visits[toId] ?? 0) + 1;
    this.adjustEnergy(-5);
    this.hooks.log("PLAYER_TRAVELED", { to: toId, cost, minutes }, this.id);
  }

  sleep(hours = 8): void {
    this.touch();
    this.hooks.advanceMinutes(Math.round(hours * 60));
    this.adjustEnergy(60);
    this.adjustHealth(10);
    this.hooks.log("PLAYER_SLEPT", { hours }, this.id);
  }

  eat(cost = 1500, energyGain = 25): void {
    this.touch();
    if (cost > 0) this.wallet.debit(cost, this.stamp("food"));
    this.adjustEnergy(energyGain);
    this.adjustHealth(2);
    this.hooks.log("PLAYER_ATE", { cost, energyGain }, this.id);
  }

  acceptJob(jobId: string): void {
    this.touch();
    this.hooks.assertJob(jobId);
    const reqs = this.hooks.jobRequirements(jobId);
    if (!this.progression.meets(reqs)) {
      throw new Error(`Player does not meet requirements for job ${jobId}`);
    }
    this.jobId = jobId;
    this.hooks.log("JOB_ACCEPTED", { jobId }, this.id);
  }

  quitJob(): void {
    this.touch();
    if (!this.jobId) return;
    const old = this.jobId;
    this.jobId = null;
    this.hooks.log("JOB_QUIT", { jobId: old }, this.id);
  }

  /** Work one shift: consumes time + energy, pays daily wage, grants XP. */
  work(): number {
    this.touch();
    if (!this.jobId) throw new Error("Player has no job. Call acceptJob() first.");
    if (this.energy < 10) throw new Error("Too tired to work. Sleep or eat first.");
    const hours = this.hooks.jobWorkingHours(this.jobId);
    const cost = this.hooks.jobEnergyCost(this.jobId);
    const pay = this.hooks.dailyPay(this.jobId);

    this.hooks.advanceMinutes(hours * 60);
    this.adjustEnergy(-cost);
    const tx = this.wallet.credit(pay, this.stamp(`salary:${this.jobId}`));
    this.progression.addXp(10);
    this.hooks.log(
      "PLAYER_WORKED",
      { jobId: this.jobId, hours, pay, txId: tx.id },
      this.id,
    );
    this.hooks.log("WALLET_CREDITED", { amount: pay, reason: `salary:${this.jobId}` }, this.id);
    return pay;
  }

  /** Buy items at catalog price. Costs a little time (shopping). */
  buy(itemId: string, qty = 1): void {
    this.touch();
    const item = this.hooks.getItem(itemId);
    if (qty <= 0) throw new Error("Quantity must be positive");
    this.wallet.debit(item.price * qty, this.stamp(`buy:${itemId}x${qty}`));
    this.inventory.add(itemId, qty);
    this.hooks.advanceMinutes(10);
    this.hooks.log("PLAYER_BOUGHT", { itemId, qty, cost: item.price * qty }, this.id);
  }

  /** Use one unit: applies its energy/health effects. */
  use(itemId: string): void {
    this.touch();
    const item = this.hooks.getItem(itemId);
    this.inventory.remove(itemId, 1);
    if (item.energy) this.adjustEnergy(item.energy);
    if (item.health) this.adjustHealth(item.health);
    this.hooks.log(
      "PLAYER_USED_ITEM",
      { itemId, energy: item.energy ?? 0, health: item.health ?? 0 },
      this.id,
    );
  }

  /** Sell back at 50% of catalog price (rounded down). */
  sell(itemId: string, qty = 1): number {
    this.touch();
    const item = this.hooks.getItem(itemId);
    this.inventory.remove(itemId, qty);
    const gain = Math.floor((item.price * qty) / 2);
    this.wallet.credit(gain, this.stamp(`sell:${itemId}x${qty}`));
    this.hooks.log("PLAYER_SOLD", { itemId, qty, gain }, this.id);
    return gain;
  }

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
    return p;
  }
}
