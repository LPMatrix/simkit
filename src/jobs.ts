import type { JobDef } from "./types.js";
import { invalidInput } from "./runtime/action.js";

export interface Job extends JobDef {
  name: string;
  workingHours: number;
  energyCost: number;
  requirements: Record<string, number>;
}

export class JobManager {
  private jobs = new Map<string, Job>();

  constructor(defs: (string | JobDef)[] = []) {
    for (const d of defs) this.define(d as JobDef);
  }

  define(def: JobDef & { name?: string }): Job {
    if (!def.id) throw new Error("Job must have an id");
    if (
      def.dismissAfterAbsentDays !== undefined &&
      (!Number.isInteger(def.dismissAfterAbsentDays) || def.dismissAfterAbsentDays < 0)
    ) {
      throw invalidInput(`Job ${def.id} dismissAfterAbsentDays must be an integer >= 0`);
    }
    const job: Job = {
      id: def.id,
      name: def.name ?? def.id,
      salary: def.salary ?? 0,
      location: def.location,
      workingHours: def.workingHours ?? 8,
      energyCost: def.energyCost ?? 20,
      requirements: def.requirements ?? {},
      dismissAfterAbsentDays: def.dismissAfterAbsentDays,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  }

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  /** Daily pay derived from monthly salary (30-day month). */
  dailyPay(id: string): number {
    return Math.round(this.get(id).salary / 30);
  }

  toJSON(): Job[] {
    return this.list();
  }

  static fromJSON(json: Job[]): JobManager {
    const m = new JobManager();
    for (const j of json) m.define(j);
    return m;
  }
}
