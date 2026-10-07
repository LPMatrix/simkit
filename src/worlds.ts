import type { Sim } from "./sim.js";
import type { EventDefinition } from "./events.js";
import type { JobDef, LocationDef } from "./types.js";

/**
 * Versioned game worlds (§14 of the plan).
 *
 * Rule changes (e.g. danfo salary ₦150k → ₦200k) ship as new world
 * versions. Existing players are migrated safely: changed definitions are
 * upserted, and players holding removed jobs are moved to a fallback job
 * (or gracefully quit) instead of breaking.
 */
export interface WorldVersionDef {
  version: string;
  locations?: (string | LocationDef)[];
  jobs?: JobDef[];
  events?: EventDefinition[];
  /** Job ids removed in this version. */
  removedJobs?: string[];
  /** Where to move players holding a removed job. Absent = they quit. */
  jobFallback?: Record<string, string>;
}

export interface MigrateOptions {
  /** Default: "upsert" — apply new defs, remap holders of removed jobs. */
  strategy?: "upsert";
}

export class WorldCatalog {
  private versions = new Map<string, WorldVersionDef[]>();

  define(gameId: string, def: WorldVersionDef): void {
    if (!def.version) throw new Error("World version requires a version string");
    const list = this.versions.get(gameId) ?? [];
    if (list.some((v) => v.version === def.version)) {
      throw new Error(`World version already defined: ${gameId}@${def.version}`);
    }
    list.push(def);
    this.versions.set(gameId, list);
  }

  list(gameId: string): string[] {
    return (this.versions.get(gameId) ?? []).map((v) => v.version);
  }

  /**
   * Migrate a live Sim from its current `worldVersion` to `target` by
   * applying every intermediate version in definition order.
   */
  migrate(sim: Sim, target: string, _opts: MigrateOptions = {}): { from: string; to: string; remapped: number } {
    const list = this.versions.get(sim.gameId) ?? [];
    const targetIdx = list.findIndex((v) => v.version === target);
    if (targetIdx === -1) throw new Error(`Unknown world version: ${sim.gameId}@${target}`);
    const currentIdx = list.findIndex((v) => v.version === sim.worldVersion);
    // If current version is unknown to the catalog (e.g. hand-built "v1"
    // world), apply everything up to and including target.
    const start = currentIdx === -1 ? 0 : currentIdx + 1;
    if (start > targetIdx) {
      throw new Error(`Cannot migrate backwards: ${sim.worldVersion} → ${target}`);
    }
    const from = sim.worldVersion;
    let remapped = 0;
    for (let i = start; i <= targetIdx; i++) {
      remapped += this.applyVersion(sim, list[i]);
    }
    sim.worldVersion = target;
    sim.emit("WORLD_MIGRATED", { from, to: target, remapped });
    return { from, to: target, remapped };
  }

  private applyVersion(sim: Sim, def: WorldVersionDef): number {
    for (const loc of def.locations ?? []) sim.world.define(loc);
    for (const job of def.jobs ?? []) sim.jobs.define(job);
    for (const ev of def.events ?? []) {
      try {
        sim.events.define(ev);
      } catch {
        // Already defined (e.g. re-applied seed event): skip.
      }
    }
    let remapped = 0;
    for (const removed of def.removedJobs ?? []) {
      for (const player of sim.players.list()) {
        if (player.jobId !== removed) continue;
        const fallback = def.jobFallback?.[removed];
        if (fallback) {
          sim.jobs.get(fallback); // throws on unknown fallback — fail fast
          player.jobId = fallback;
        } else {
          player.quitJob();
        }
        remapped += 1;
        sim.emit("PLAYER_JOB_MIGRATED", { from: removed, to: player.jobId }, player.id);
      }
    }
    return remapped;
  }
}
