import type { ActionDef, RequirementContext } from "./action.js";
import { invalidInput, requirements } from "./action.js";

/**
 * Built-in actions. Each one reproduces the V1 Player method it replaces:
 * same ledger reasons, same log events, same time and energy effects.
 * Player methods delegate here, so behaviour cannot drift between the two.
 */

type Inputs = Record<string, unknown>;

function requireString(inputs: Inputs, key: string): string {
  const v = inputs[key];
  if (typeof v !== "string" || v === "") {
    throw invalidInput(`${key} (string) is required`);
  }
  return v;
}

function positiveQty(inputs: Inputs): number {
  const qty = (inputs.qty as number | undefined) ?? 1;
  if (!Number.isInteger(qty) || qty <= 0) {
    throw invalidInput("Quantity must be a positive whole number");
  }
  return qty;
}

/**
 * Apply a market modifier (set by events or the console) to a base price.
 * Keys: "transport" for travel, "goods" for items.
 */
function priced(sim: { priceModifiers: Record<string, number> }, key: string, base: number): number {
  return Math.round(base * (sim.priceModifiers[key] ?? 1));
}

/**
 * Link the running action to whatever set a price modifier, when the
 * modifier actually changed the price. Silent when prices are unmodified.
 */
function linkModifier(
  sim: {
    priceModifiers: Record<string, number>;
    priceSources: Record<string, { day: number; origin: string; eventSeq?: number }>;
    modifierLabel: (key: string) => string;
    addLink: (link: { kind: "modifier"; label: string; category: string; eventSeq?: number }) => void;
  },
  key: string,
  category: string,
): void {
  if ((sim.priceModifiers[key] ?? 1) === 1) return;
  sim.addLink({
    kind: "modifier",
    label: sim.modifierLabel(key),
    category,
    eventSeq: sim.priceSources[key]?.eventSeq,
  });
}

/** Cost of travelling to `inputs.to`; free when already there. */
function travelCostOf(ctx: RequirementContext): number {
  const to = ctx.inputs.to as string;
  if (to === ctx.actor.locationId) return 0;
  return priced(ctx.sim, "transport", ctx.sim.world.get(to).travelCost);
}

export const workAction: ActionDef<number> = {
  id: "work",
  description: "Work one shift for your current job: time, energy, daily pay, XP.",
  requires: [
    requirements.employed(),
    requirements.hasEnergy(10, "Too tired to work. Sleep or eat first."),
  ],
  execute({ sim, actor }) {
    const jobId = actor.jobId as string;
    const job = sim.jobs.get(jobId);
    const pay = sim.jobs.dailyPay(jobId);

    actor.touch();
    actor.hooks.advanceMinutes(job.workingHours * 60);
    actor.adjustEnergy(-job.energyCost);
    const tx = actor.wallet.credit(pay, actor.stamp(`salary:${jobId}`));
    actor.progression.addXp(10);
    sim.emit("PLAYER_WORKED", { jobId, hours: job.workingHours, pay, txId: tx.id }, actor.id);
    sim.emit("WALLET_CREDITED", { amount: pay, reason: `salary:${jobId}` }, actor.id);
    return pay;
  },
};

export const travelAction: ActionDef<void> = {
  id: "travel",
  description: "Travel to another location: costs money and time, uses a little energy.",
  validate({ sim, inputs }) {
    sim.world.get(requireString(inputs, "to")); // throws "Unknown location" for bad ids
  },
  requires: [requirements.hasCash(travelCostOf)],
  execute({ sim, actor, inputs }) {
    const to = inputs.to as string;
    actor.touch();
    if (to === actor.locationId) return;
    const loc = sim.world.get(to);
    const cost = priced(sim, "transport", loc.travelCost);
    linkModifier(sim, "transport", "travel");
    if (cost > 0) {
      actor.wallet.debit(cost, actor.stamp(`travel:${actor.locationId}->${to}`));
    }
    actor.hooks.advanceMinutes(loc.travelTimeMinutes);
    actor.locationId = to;
    actor.visits[to] = (actor.visits[to] ?? 0) + 1;
    actor.adjustEnergy(-5);
    sim.emit(
      "PLAYER_TRAVELED",
      { to, cost, minutes: loc.travelTimeMinutes },
      actor.id,
    );
  },
};

export const sleepAction: ActionDef<void> = {
  id: "sleep",
  description: "Sleep for a number of hours: time passes, energy and health recover.",
  execute({ sim, actor, inputs }) {
    const hours = (inputs.hours as number | undefined) ?? 8;
    actor.touch();
    actor.hooks.advanceMinutes(Math.round(hours * 60));
    actor.adjustEnergy(60);
    actor.adjustHealth(10);
    sim.emit("PLAYER_SLEPT", { hours }, actor.id);
  },
};

export const eatAction: ActionDef<void> = {
  id: "eat",
  description: "Eat a meal: costs money, restores energy.",
  requires: [requirements.hasCash(({ inputs }) => (inputs.cost as number | undefined) ?? 1500)],
  execute({ sim, actor, inputs }) {
    const cost = (inputs.cost as number | undefined) ?? 1500;
    const energyGain = (inputs.energyGain as number | undefined) ?? 25;
    actor.touch();
    if (cost > 0) actor.wallet.debit(cost, actor.stamp("food"));
    actor.adjustEnergy(energyGain);
    actor.adjustHealth(2);
    sim.emit("PLAYER_ATE", { cost, energyGain }, actor.id);
  },
};

export const acceptJobAction: ActionDef<void> = {
  id: "accept-job",
  description: "Take a job you qualify for.",
  validate({ sim, inputs }) {
    sim.jobs.get(requireString(inputs, "jobId")); // throws "Unknown job"
  },
  requires: [
    {
      id: "job-requirements",
      check: ({ sim, actor, inputs }) => {
        const jobId = inputs.jobId as string;
        return actor.progression.meets(sim.jobs.get(jobId).requirements)
          ? null
          : `Player does not meet requirements for job ${jobId}`;
      },
    },
  ],
  execute({ sim, actor, inputs }) {
    const jobId = inputs.jobId as string;
    actor.jobId = jobId;
    sim.emit("JOB_ACCEPTED", { jobId }, actor.id);
  },
};

export const quitJobAction: ActionDef<void> = {
  id: "quit-job",
  description: "Leave your current job. No-op when unemployed.",
  execute({ sim, actor }) {
    if (!actor.jobId) return;
    const old = actor.jobId;
    actor.jobId = null;
    sim.emit("JOB_QUIT", { jobId: old }, actor.id);
  },
};

export const buyAction: ActionDef<void> = {
  id: "buy",
  description: "Buy items at catalog price. Costs a little time.",
  validate({ sim, inputs }) {
    sim.items.get(requireString(inputs, "itemId")); // throws "Unknown item"
    positiveQty(inputs);
  },
  requires: [
    requirements.hasCash(({ sim, inputs }) => {
      const price = priced(sim, "goods", sim.items.get(inputs.itemId as string).price);
      return price * positiveQty(inputs);
    }),
  ],
  execute({ sim, actor, inputs }) {
    const itemId = inputs.itemId as string;
    const qty = positiveQty(inputs);
    const cost = priced(sim, "goods", sim.items.get(itemId).price) * qty;
    linkModifier(sim, "goods", "buy");
    actor.touch();
    actor.wallet.debit(cost, actor.stamp(`buy:${itemId}x${qty}`));
    actor.inventory.add(itemId, qty);
    actor.hooks.advanceMinutes(10);
    sim.emit("PLAYER_BOUGHT", { itemId, qty, cost }, actor.id);
  },
};

export const useAction: ActionDef<void> = {
  id: "use",
  description: "Use one unit of an item: applies its energy and health effects.",
  validate({ sim, inputs }) {
    sim.items.get(requireString(inputs, "itemId")); // throws "Unknown item"
  },
  requires: [requirements.hasItem((ctx) => ctx.inputs.itemId as string, 1)],
  execute({ sim, actor, inputs }) {
    const itemId = inputs.itemId as string;
    const item = sim.items.get(itemId);
    actor.touch();
    actor.inventory.remove(itemId, 1);
    if (item.energy) actor.adjustEnergy(item.energy);
    if (item.health) actor.adjustHealth(item.health);
    sim.emit(
      "PLAYER_USED_ITEM",
      { itemId, energy: item.energy ?? 0, health: item.health ?? 0 },
      actor.id,
    );
  },
};

export const sellAction: ActionDef<number> = {
  id: "sell",
  description: "Sell items back at 50% of catalog price, rounded down.",
  validate({ sim, inputs }) {
    sim.items.get(requireString(inputs, "itemId")); // throws "Unknown item"
    positiveQty(inputs);
  },
  requires: [requirements.hasItem((ctx) => ctx.inputs.itemId as string, (ctx) => positiveQty(ctx.inputs))],
  execute({ sim, actor, inputs }) {
    const itemId = inputs.itemId as string;
    const qty = positiveQty(inputs);
    const price = priced(sim, "goods", sim.items.get(itemId).price);
    linkModifier(sim, "goods", "sell");
    actor.touch();
    actor.inventory.remove(itemId, qty);
    const gain = Math.floor((price * qty) / 2);
    actor.wallet.credit(gain, actor.stamp(`sell:${itemId}x${qty}`));
    sim.emit("PLAYER_SOLD", { itemId, qty, gain }, actor.id);
    return gain;
  },
};

export const CORE_ACTIONS: ActionDef<unknown>[] = [
  workAction as ActionDef<unknown>,
  travelAction as ActionDef<unknown>,
  sleepAction as ActionDef<unknown>,
  eatAction as ActionDef<unknown>,
  acceptJobAction as ActionDef<unknown>,
  quitJobAction as ActionDef<unknown>,
  buyAction as ActionDef<unknown>,
  useAction as ActionDef<unknown>,
  sellAction as ActionDef<unknown>,
];
