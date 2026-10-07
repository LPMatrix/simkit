import type { SeededRng } from "./rng.js";

export interface SimLogEvent {
  seq: number;
  type: string;
  day: number;
  time: string;
  playerId?: string;
  data?: Record<string, unknown>;
}

export interface EventContext {
  rng: SeededRng;
  day: number;
  time: string;
  emit: (type: string, data?: Record<string, unknown>, playerId?: string) => void;
  getPlayer: (id: string) => {
    adjustEnergy: (d: number) => void;
    adjustHealth: (d: number) => void;
    wallet: { credit: (n: number, m?: Record<string, unknown>) => void; debit: (n: number, m?: Record<string, unknown>) => void };
  };
  priceModifiers: Record<string, number>;
}

export interface EventDefinition {
  id: string;
  name?: string;
  /** Probability per tick (per day) in [0,1] */
  probability: number;
  once?: boolean;
  cooldownDays?: number;
  condition?: (ctx: Pick<EventContext, "day">) => boolean;
  effect?: (ctx: EventContext) => void;
}

interface RuntimeState {
  def: EventDefinition;
  lastFiredDay: number | null;
  fired: boolean;
}

/**
 * Killer-feature candidate: declarative random world events
 * (fuel crisis, rent due, power outage, salary day...).
 * Deterministic: uses sim RNG, supports replay via seed + rng state.
 */
export class EventEngine {
  private events = new Map<string, RuntimeState>();
  triggerCounts = new Map<string, number>();

  define(def: EventDefinition): void {
    if (!def.id) throw new Error("Event must have an id");
    if (def.probability < 0 || def.probability > 1) {
      throw new Error("Event probability must be in [0,1]");
    }
    this.events.set(def.id, { def, lastFiredDay: null, fired: false });
  }

  remove(id: string): void {
    this.events.delete(id);
  }

  list(): EventDefinition[] {
    return [...this.events.values()].map((s) => s.def);
  }

  count(id: string): number {
    return this.triggerCounts.get(id) ?? 0;
  }

  /** Roll all events once (called once per simulated day). Returns fired ids. */
  tick(ctx: EventContext): string[] {
    const fired: string[] = [];
    for (const state of this.events.values()) {
      const { def } = state;
      if (def.once && state.fired) continue;
      if (
        def.cooldownDays != null &&
        state.lastFiredDay != null &&
        ctx.day - state.lastFiredDay < def.cooldownDays
      ) {
        continue;
      }
      if (def.condition && !def.condition(ctx)) continue;
      if (!ctx.rng.chance(def.probability)) continue;

      state.lastFiredDay = ctx.day;
      state.fired = true;
      this.triggerCounts.set(def.id, this.count(def.id) + 1);
      try {
        def.effect?.(ctx);
      } catch {
        // Event effects must never crash the simulation tick.
      }
      ctx.emit(`EVENT:${def.id}`, { name: def.name ?? def.id });
      fired.push(def.id);
    }
    return fired;
  }

  /** Force-trigger an event (simulation console). */
  trigger(id: string, ctx: EventContext): void {
    const state = this.events.get(id);
    if (!state) throw new Error(`Unknown event: ${id}`);
    state.lastFiredDay = ctx.day;
    state.fired = true;
    this.triggerCounts.set(id, this.count(id) + 1);
    state.def.effect?.(ctx);
    ctx.emit(`EVENT:${id}`, { name: state.def.name ?? id, forced: true });
  }

  toJSON(): { counts: Record<string, number>; lastFired: Record<string, number | null> } {
    const counts: Record<string, number> = {};
    const lastFired: Record<string, number | null> = {};
    for (const [id, c] of this.triggerCounts) counts[id] = c;
    for (const [id, s] of this.events) lastFired[id] = s.lastFiredDay;
    return { counts, lastFired };
  }

  restoreCounts(json: { counts: Record<string, number>; lastFired: Record<string, number | null> }): void {
    this.triggerCounts = new Map(Object.entries(json.counts ?? {}));
    for (const [id, day] of Object.entries(json.lastFired ?? {})) {
      const s = this.events.get(id);
      if (s) {
        s.lastFiredDay = day;
        if (day != null) s.fired = true;
      }
    }
  }
}
