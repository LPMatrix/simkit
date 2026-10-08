import type { ActionDef } from "./runtime/action.js";
import type { ScheduleDef } from "./schedules.js";
import type { Sim } from "./sim.js";
import {
  acceptJobAction,
  buyAction,
  eatAction,
  quitJobAction,
  sellAction,
  sleepAction,
  travelAction,
  useAction,
  workAction,
} from "./runtime/core-actions.js";
import {
  businessBuyAction,
  businessCollectAction,
  hireAction,
  missionAcceptAction,
  missionClaimAction,
  payrollAction,
  settleObligationAction,
  talkAction,
  tradeAcceptAction,
  tradeCancelAction,
  tradeDeclineAction,
  tradeOfferAction,
  transferAction,
} from "./runtime/sim-actions.js";
import { enrolAction } from "./runtime/entity-actions.js";

/** Context passed to per-day system hooks and report functions. */
export interface SystemContext {
  sim: Sim;
  /** The game day being processed (1-indexed). */
  day: number;
}

/**
 * A composable simulation system. Systems are behavior installed with
 * `sim.use()`: actions enter the pipeline, schedules start ticking, `onTick`
 * runs once per game day after events and settlements, and `report` feeds
 * inspection tooling. Data managers (jobs, world, items, ...) stay storage;
 * systems own behavior.
 */
export interface System {
  id: string;
  description?: string;
  actions?: ActionDef<unknown>[];
  schedules?: ScheduleDef[];
  onTick?: (ctx: SystemContext) => void;
  report?: (ctx: SystemContext) => unknown;
}

/** True for behavior bundles; packs are data and take the other branch of `use()`. */
export function isSystem(def: unknown): def is System {
  if (!def || typeof def !== "object") return false;
  const d = def as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    (Array.isArray(d.actions) || typeof d.onTick === "function" || Array.isArray(d.schedules) || typeof d.report === "function")
  );
}

function system(
  id: string,
  description: string,
  actions: ActionDef<unknown>[],
): System {
  return { id, description, actions };
}

/** The built-in domain systems. Installed by the Sim constructor through `use()`,
 * the same path third-party systems take. */
export const BUILTIN_SYSTEMS: System[] = [
  system("jobs", "Employment: take jobs, work shifts, quit.", [
    workAction as ActionDef<unknown>,
    acceptJobAction as ActionDef<unknown>,
    quitJobAction as ActionDef<unknown>,
  ]),
  system("needs", "Bodily upkeep: sleep and eat.", [
    sleepAction as ActionDef<unknown>,
    eatAction as ActionDef<unknown>,
  ]),
  system("world", "Movement between locations.", [travelAction as ActionDef<unknown>]),
  system("market", "Goods: buy, use, and sell items.", [
    buyAction as ActionDef<unknown>,
    useAction as ActionDef<unknown>,
    sellAction as ActionDef<unknown>,
  ]),
  system("social", "NPC conversation and relationships.", [talkAction as ActionDef<unknown>]),
  system("economy", "Money movement and scheduled settlement.", [
    transferAction as ActionDef<unknown>,
    settleObligationAction as ActionDef<unknown>,
  ]),
  system("trades", "Proposed swaps of cash and items.", [
    tradeOfferAction as ActionDef<unknown>,
    tradeAcceptAction as ActionDef<unknown>,
    tradeDeclineAction as ActionDef<unknown>,
    tradeCancelAction as ActionDef<unknown>,
  ]),
  system("business", "Ownership, income, hiring, and payroll.", [
    businessBuyAction as ActionDef<unknown>,
    businessCollectAction as ActionDef<unknown>,
    hireAction as ActionDef<unknown>,
    payrollAction as ActionDef<unknown>,
  ]),
  system("missions", "Goals with rewards.", [
    missionAcceptAction as ActionDef<unknown>,
    missionClaimAction as ActionDef<unknown>,
  ]),
  system("entities", "Enrolment in generic entities such as courses.", [
    enrolAction as ActionDef<unknown>,
  ]),
];
