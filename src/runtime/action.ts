import type { Player } from "../player.js";
import type { Sim } from "../sim.js";
import type { Entity } from "../entities.js";

/** Everything a requirement needs to decide whether an action may run. */
export interface RequirementContext {
  sim: Sim;
  actor: Player;
  inputs: Record<string, unknown>;
  /** Resolved entity for actions that declare a `targetKind`. */
  target?: Entity;
}

/**
 * A precondition. `check` returns a human-readable reason when the action is
 * not allowed, or `null` when the requirement is met.
 */
export interface Requirement {
  id: string;
  check(ctx: RequirementContext): string | null;
}

export interface ActionContext extends RequirementContext {
  /** Id of the causal record this execution belongs to. */
  causeId: string;
}

/**
 * A first-class state change. `requires` is checked before anything moves;
 * `execute` performs the effects. Every wallet transaction and log event
 * produced inside `execute` is linked to the action's cause id.
 */
export interface ActionDef<R = unknown> {
  id: string;
  description?: string;
  /**
   * If set, the action acts on an entity of this kind. The caller passes its id
   * as `inputs.target`; the runtime resolves it (404 if unknown or the wrong kind)
   * before validation, and exposes it as `target` to every hook.
   */
  targetKind?: string;
  /**
   * Input validation. Throw for malformed input or unknown ids. Thrown errors
   * are request errors, not refusals: nothing is recorded and nothing moves.
   */
  validate?(ctx: RequirementContext): void;
  requires?: Requirement[];
  execute(ctx: ActionContext): R;
}

/** A cross-action causal link on a cause record. */
export interface CauseLink {
  /** "modifier" for price effects, "trade" for offer→accept. */
  kind: "modifier" | "trade";
  /** Human sentence, e.g. "transport ×1.25 (EVENT:fuel-crisis, day 4)". */
  label: string;
  /** Ledger category this affected, if any (lets explain() attach it). */
  category?: string;
  /** Id of the earlier cause, when the trigger was an action. */
  causeId?: string;
  /** Log seq of the earlier event, when the trigger was an event. */
  eventSeq?: number;
}

/** One attempted action, successful or refused. Kept for replay and explanation. */
export interface CauseRecord {
  id: string;
  actionId: string;
  actorId: string;
  day: number;
  time: string;
  inputs: Record<string, unknown>;
  outcome: "ok" | "refused";
  reasons: string[];
  /** Log sequence range (exclusive start, inclusive end) covering this action's events. */
  seqFrom: number;
  seqTo: number;
  /** Links to earlier causes or events that shaped this action. */
  links: CauseLink[];
}

/** Thrown when one or more requirements fail. Maps to HTTP 400. */
export class ActionRefused extends Error {
  status = 400;
  readonly actionId: string;
  readonly reasons: string[];

  constructor(actionId: string, reasons: string[]) {
    super(reasons[0] ?? `Action refused: ${actionId}`);
    this.name = "ActionRefused";
    this.actionId = actionId;
    this.reasons = reasons;
  }
}

/** Thrown for malformed input. Maps to HTTP 400, like a refusal, but is not recorded as one. */
export function invalidInput(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

/** Small library of reusable requirements. */
export const requirements = {
  employed(): Requirement {
    return {
      id: "employed",
      check: ({ actor }) => (actor.jobId ? null : "Player has no job. Call acceptJob() first."),
    };
  },

  hasEnergy(min: number, message?: string): Requirement {
    return {
      id: `hasEnergy:${min}`,
      check: (ctx) => {
        const level = ctx.sim.needs.level(ctx.actor, "energy");
        return level >= min ? null : (message ?? `Not enough energy (need ${min}). Sleep or eat first.`);
      },
    };
  },

  hasCash(amount: number | ((ctx: RequirementContext) => number)): Requirement {
    return {
      id: "hasCash",
      check: (ctx) => {
        const needed = typeof amount === "number" ? amount : amount(ctx);
        return ctx.actor.wallet.balance >= needed
          ? null
          : `Insufficient funds: balance ${ctx.actor.wallet.balance}, need ${needed}`;
      },
    };
  },

  hasItem(
    itemId: string | ((ctx: RequirementContext) => string),
    qty: number | ((ctx: RequirementContext) => number) = 1,
  ): Requirement {    return {
      id: "hasItem",
      check: (ctx) => {
        const id = typeof itemId === "string" ? itemId : itemId(ctx);
        const needed = typeof qty === "number" ? qty : qty(ctx);
        const have = ctx.actor.inventory.count(id);
        return have >= needed ? null : `Not enough ${id}: have ${have}, need ${needed}`;
      },
    };
  },

  /** Gate an action on custom need levels, e.g. needsAtLeast({ focus: 30 }). */
  needsAtLeast(levels: Record<string, number>): Requirement {
    return {
      id: `needsAtLeast:${Object.keys(levels).sort().join(",")}`,
      check: (ctx) => {
        for (const [needId, min] of Object.entries(levels)) {
          const value = ctx.sim.needs.level(ctx.actor, needId); // throws "Unknown need" on typo
          if (value < min) return `Need ${needId} too low (${value} < ${min})`;
        }
        return null;
      },
    };
  },
};

