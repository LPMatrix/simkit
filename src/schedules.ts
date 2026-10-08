import { invalidInput } from "./runtime/action.js";

/** What happens when a scheduled payment cannot be made. */
export type MissPolicy =
  /** Log the miss and move to the next due date. */
  | "skip"
  /** Log the miss and try again on the next processed day. */
  | "retry"
  /** Log the miss, record a default, and cancel the schedule. */
  | "default";

export interface ScheduleDef {
  id: string;
  /** Actor id that pays. Resolved when each payment falls due. */
  payer: string;
  /** Actor id that receives. Absent means a sink: the money is destroyed (rent, bills, fees). */
  payee?: string;
  /** Positive amount in game currency. */
  amount: number;
  /** Cadence in days: 1 daily, 7 weekly, 30 monthly. Positive integer. */
  everyDays: number;
  /** First due day. Defaults to the day of definition. */
  startsOn?: number;
  /** Ledger reason for each payment (becomes the explain() category). */
  reason?: string;
  onMiss?: MissPolicy;
}

export interface Schedule {
  id: string;
  payer: string;
  payee?: string;
  amount: number;
  everyDays: number;
  reason: string;
  onMiss: MissPolicy;
  nextDue: number;
  active: boolean;
}

const POLICIES: MissPolicy[] = ["skip", "retry", "default"];

/**
 * Recurring obligations: rent, burn, tuition, payroll-style fixed payments.
 * The manager only stores schedules; the Sim settles them once per game day
 * through the `settle-obligation` action, so every payment (and every miss)
 * goes through requirements, the ledger, and the causal record.
 */
export class ScheduleManager {
  private schedules = new Map<string, Schedule>();

  /** `today` anchors the first due date when `startsOn` is absent (default day 1). */
  define(def: ScheduleDef, today = 1): Schedule {
    if (!def.id || typeof def.id !== "string") throw invalidInput("Schedule must have an id");
    if (this.schedules.has(def.id)) throw invalidInput(`Schedule already exists: ${def.id}`);
    if (!def.payer || typeof def.payer !== "string") throw invalidInput("Schedule must have a payer");
    if (def.payee !== undefined && (typeof def.payee !== "string" || !def.payee)) {
      throw invalidInput("Schedule payee must be a non-empty string");
    }
    if (typeof def.amount !== "number" || !(def.amount > 0)) {
      throw invalidInput(`Schedule amount must be positive, got ${String(def.amount)}`);
    }
    if (!Number.isInteger(def.everyDays) || def.everyDays <= 0) {
      throw invalidInput(`Schedule everyDays must be a positive integer, got ${String(def.everyDays)}`);
    }
    const onMiss = def.onMiss ?? "skip";
    if (!POLICIES.includes(onMiss)) throw invalidInput(`Schedule onMiss must be one of: ${POLICIES.join("|")}`);
    const startsOn = def.startsOn ?? today;
    if (!Number.isInteger(startsOn) || startsOn < 1) {
      throw invalidInput(`Schedule startsOn must be a day >= 1, got ${String(def.startsOn)}`);
    }
    const schedule: Schedule = {
      id: def.id,
      payer: def.payer,
      payee: def.payee,
      amount: def.amount,
      everyDays: def.everyDays,
      reason: def.reason ?? "obligation",
      onMiss,
      nextDue: startsOn,
      active: true,
    };
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  get(id: string): Schedule {
    const s = this.schedules.get(id);
    if (!s) throw Object.assign(new Error(`Unknown schedule: ${id}`), { status: 404 });
    return s;
  }

  has(id: string): boolean {
    return this.schedules.has(id);
  }

  list(): Schedule[] {
    return [...this.schedules.values()];
  }

  cancel(id: string): Schedule {
    const s = this.get(id);
    s.active = false;
    return s;
  }

  /** Schedules owed on `day` (catch-up safe: anything at or past due). */
  dueOn(day: number): Schedule[] {
    return this.list().filter((s) => s.active && s.nextDue <= day);
  }

  toJSON(): Schedule[] {
    return this.list().map((s) => ({ ...s }));
  }

  static fromJSON(json: Schedule[] | undefined): ScheduleManager {
    const m = new ScheduleManager();
    for (const s of json ?? []) {
      m.schedules.set(s.id, { ...s, active: s.active ?? true });
    }
    return m;
  }
}
