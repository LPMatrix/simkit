import { invalidInput } from "./runtime/action.js";
import type { Player } from "./player.js";

/**
 * Configurable needs (thirst, morale, mana — anything energy/health shaped).
 * Storage lives here; daily decay and threshold events live in the needs
 * system's onTick. Energy and health are pre-registered needs whose values
 * live on player fields (legacy storage); all reads and writes in the
 * action pipeline go through level()/adjust() so custom needs compose
 * identically.
 */

export interface NeedThreshold {
  /** Fire when the value is at or below this. */
  below: number;
  /** Log event type emitted on crossing (once until recovery). */
  emit: string;
}

export interface NeedDef {
  id: string;
  name?: string;
  /** Maximum (and default initial) value. Must be positive. */
  max: number;
  /** Starting value. Defaults to max. Clamped to 0..max. */
  initial?: number;
  /** Points lost per game day. Defaults to 0 (static). Must not be negative. */
  decayPerDay?: number;
  thresholds?: NeedThreshold[];
}

export interface Need extends NeedDef {
  name: string;
  decayPerDay: number;
}

/**
 * Built-in needs every world gets. Decay 0 preserves legacy behavior:
 * only actions move them. Called by the Sim constructor and after
 * snapshot restore, so old saves without needs keep working.
 */
export function defineBuiltinNeeds(m: NeedManager): void {
  if (!m.has("energy")) m.define({ id: "energy", name: "Energy", max: 100, decayPerDay: 0 });
  if (!m.has("health")) m.define({ id: "health", name: "Health", max: 100, decayPerDay: 0 });
}
export class NeedManager {
  private needs = new Map<string, Need>();

  define(def: NeedDef): Need {
    if (!def.id || typeof def.id !== "string") throw invalidInput("Need must have an id");
    if (typeof def.max !== "number" || !(def.max > 0)) {
      throw invalidInput(`Need ${def.id} needs a positive max`);
    }
    if (def.initial !== undefined && (typeof def.initial !== "number" || def.initial < 0)) {
      throw invalidInput(`Need ${def.id} initial must be >= 0`);
    }
    if (def.decayPerDay !== undefined && (typeof def.decayPerDay !== "number" || def.decayPerDay < 0)) {
      throw invalidInput(`Need ${def.id} decayPerDay must be >= 0`);
    }
    for (const t of def.thresholds ?? []) {
      if (typeof t.below !== "number" || typeof t.emit !== "string" || !t.emit) {
        throw invalidInput(`Need ${def.id} has a malformed threshold`);
      }
    }
    const need: Need = {
      id: def.id,
      name: def.name ?? def.id,
      max: def.max,
      initial: def.initial,
      decayPerDay: def.decayPerDay ?? 0,
      thresholds: (def.thresholds ?? []).map((t) => ({ ...t })),
    };
    this.needs.set(need.id, need);
    return need;
  }

  get(id: string): Need {
    const need = this.needs.get(id);
    if (!need) throw Object.assign(new Error(`Unknown need: ${id}`), { status: 404 });
    return need;
  }

  has(id: string): boolean {
    return this.needs.has(id);
  }

  /**
   * Read a need for an actor, from whichever store holds it. Energy and
   * health live on player fields (legacy storage); custom needs live in
   * the actor's needs map. Throws "Unknown need" for undefined ids, so
   * typos fail instead of silently passing.
   */
  level(actor: Player, id: string): number {
    const need = this.get(id);
    if (id === "energy") return actor.energy;
    if (id === "health") return actor.health;
    return actor.needs[id] ?? need.initial ?? need.max;
  }

  /**
   * Change a need by delta, clamped to 0..max. Returns the new value.
   * This is the single choke point for need writes in the action pipeline.
   */
  adjust(actor: Player, id: string, delta: number): number {
    const need = this.get(id);
    const value = Math.min(need.max, Math.max(0, this.level(actor, id) + delta));
    if (id === "energy") actor.energy = value;
    else if (id === "health") actor.health = value;
    else actor.needs[id] = value;
    return value;
  }

  list(): Need[] {
    return [...this.needs.values()];
  }

  toJSON(): Need[] {
    return this.list().map((n) => ({ ...n, thresholds: n.thresholds?.map((t) => ({ ...t })) }));
  }

  static fromJSON(json: Need[] | undefined): NeedManager {
    const m = new NeedManager();
    for (const n of json ?? []) {
      m.needs.set(n.id, {
        ...n,
        thresholds: n.thresholds?.map((t) => ({ ...t })),
      });
    }
    return m;
  }
}
