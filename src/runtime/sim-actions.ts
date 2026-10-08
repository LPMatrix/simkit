import type { ActionDef, RequirementContext } from "./action.js";
import { invalidInput, requirements } from "./action.js";
import type { TradeOffer, TradeTerms } from "../trades.js";
import { defineEmployee, employeesOf } from "../employment.js";

/**
 * Sim-level actions: NPC talk, player-to-player money and trades, businesses,
 * and missions. Each reproduces the Sim method it backs: same requirement
 * order, same messages, same ledger reasons, same events.
 */

type Inputs = Record<string, unknown>;

function str(inputs: Inputs, key: string): string {
  const v = inputs[key];
  if (typeof v !== "string" || v === "") throw invalidInput(`${key} (string) is required`);
  return v;
}

function positiveAmount(inputs: Inputs): number {
  const amount = inputs.amount;
  if (typeof amount !== "number" || !(amount > 0)) {
    throw invalidInput("Transfer amount must be positive");
  }
  return amount;
}

function termsOf(inputs: Inputs): TradeTerms {
  return {
    offerCash: inputs.offerCash as number | undefined,
    offerItems: inputs.offerItems as Record<string, number> | undefined,
    askCash: inputs.askCash as number | undefined,
    askItems: inputs.askItems as Record<string, number> | undefined,
  };
}

/** A trade's current offer, looked up for requirement checks. */
function tradeOf(ctx: RequirementContext) {
  return ctx.sim.trades.get(str(ctx.inputs, "tradeId"));
}

function businessOf(ctx: RequirementContext) {
  return ctx.sim.businesses.get(str(ctx.inputs, "businessId"));
}

function missionOf(ctx: RequirementContext) {
  return ctx.sim.missions.get(str(ctx.inputs, "missionId"));
}

export const talkAction: ActionDef<{ line: string; score: number; level: string }> = {
  id: "talk",
  description: "Talk to an NPC in your location. Builds the relationship over time.",
  validate({ sim, inputs }) {
    sim.npcs.get(str(inputs, "npcId"));
  },
  requires: [
    {
      id: "same-location",
      check: ({ sim, actor, inputs }) => {
        const npc = sim.npcs.get(str(inputs, "npcId"));
        return !npc.location || npc.location === actor.locationId
          ? null
          : `${npc.name} is at ${npc.location} — travel there first`;
      },
    },
  ],
  execute({ sim, actor, inputs }) {
    const npcId = str(inputs, "npcId");
    const npc = sim.npcs.get(npcId);
    actor.touch();
    const before = actor.relationships.level(npcId);
    const line = sim.rng.pick(npc.dialogue);
    actor.hooks.advanceMinutes(15);
    const score = actor.relationships.adjust(npcId, 6);
    const level = actor.relationships.level(npcId);
    sim.emit("PLAYER_TALKED", { npcId, line, score }, actor.id);
    if (level !== before) {
      actor.adjustReputation(5);
      sim.emit("RELATIONSHIP_LEVEL_UP", { npcId, level }, actor.id);
    }
    return { line, score, level };
  },
};

export const transferAction: ActionDef<void> = {
  id: "transfer",
  description: "Send money to another player. Both sides move, or neither does.",
  validate({ sim, actor, inputs }) {
    const to = str(inputs, "to");
    if (to === actor.id) throw invalidInput("Cannot transfer to yourself");
    positiveAmount(inputs);
    sim.players.get(to);
  },
  requires: [requirements.hasCash((ctx) => ctx.inputs.amount as number)],
  execute({ sim, actor, inputs }) {
    const toId = str(inputs, "to");
    const amount = positiveAmount(inputs);
    const reason = (inputs.reason as string | undefined) ?? "transfer";
    const to = sim.players.get(toId);
    actor.touch();
    to.touch();
    actor.wallet.debit(amount, actor.stamp(`${reason}:to:${toId}`));
    to.wallet.credit(amount, to.stamp(`${reason}:from:${actor.id}`));
    sim.emit("WALLET_DEBITED", { amount, reason }, actor.id);
    sim.emit("WALLET_CREDITED", { amount, reason }, toId);
    sim.emit("PLAYER_TRANSFERRED", { from: actor.id, to: toId, amount }, actor.id);
  },
};

export const tradeOfferAction: ActionDef<TradeOffer> = {
  id: "trade-offer",
  description: "Propose a swap of cash and items with another player.",
  validate({ sim, actor, inputs }) {
    const to = str(inputs, "to");
    if (to === actor.id) throw invalidInput("Cannot trade with yourself");
    sim.players.get(to);
  },
  requires: [
    {
      id: "affordable",
      check: ({ actor, inputs }) =>
        ((inputs.offerCash as number | undefined) ?? 0) > actor.wallet.balance
          ? "You can't afford what you're offering"
          : null,
    },
    {
      id: "owned-items",
      check: ({ actor, inputs }) => {
        const offered = (inputs.offerItems as Record<string, number> | undefined) ?? {};
        for (const [id, qty] of Object.entries(offered)) {
          if (actor.inventory.count(id) < qty) return `You don't have ${qty}x ${id}`;
        }
        return null;
      },
    },
  ],
  execute({ sim, actor, inputs }) {
    const to = str(inputs, "to");
    const offer = sim.trades.propose(actor.id, to, termsOf(inputs), sim.clock.day);
    actor.touch();
    sim.emit("TRADE_PROPOSED", { tradeId: offer.id, to }, actor.id);
    return offer;
  },
};

export const tradeAcceptAction: ActionDef<TradeOffer> = {
  id: "trade-accept",
  description: "Accept a pending trade. All legs settle together, or nothing moves.",
  validate({ sim, inputs }) {
    sim.trades.get(str(inputs, "tradeId"));
  },
  requires: [
    {
      id: "pending",
      check: (ctx) => {
        const offer = tradeOf(ctx);
        return offer.status === "pending" ? null : `Trade is already ${offer.status}`;
      },
    },
    {
      id: "counterparty",
      check: (ctx) => (tradeOf(ctx).to === ctx.actor.id ? null : "Only the counterparty can accept"),
    },
    {
      // Balances and stock can change between proposal and acceptance, so both
      // sides are checked again here.
      id: "proposer-can-pay",
      check: (ctx) => {
        const offer = tradeOf(ctx);
        const from = ctx.sim.players.get(offer.from);
        return from.wallet.balance < offer.offerCash ? `${from.name} can no longer afford this trade` : null;
      },
    },
    {
      id: "counterparty-can-pay",
      check: (ctx) => {
        const offer = tradeOf(ctx);
        return ctx.actor.wallet.balance < offer.askCash
          ? `${ctx.actor.name} can no longer afford this trade`
          : null;
      },
    },
    {
      id: "proposer-items",
      check: (ctx) => {
        const offer = tradeOf(ctx);
        const from = ctx.sim.players.get(offer.from);
        for (const [id, qty] of Object.entries(offer.offerItems)) {
          if (from.inventory.count(id) < qty) return `${from.name} no longer has ${qty}x ${id}`;
        }
        return null;
      },
    },
    {
      id: "counterparty-items",
      check: (ctx) => {
        const offer = tradeOf(ctx);
        for (const [id, qty] of Object.entries(offer.askItems)) {
          if (ctx.actor.inventory.count(id) < qty) return `${ctx.actor.name} no longer has ${qty}x ${id}`;
        }
        return null;
      },
    },
  ],
  execute({ sim, actor, inputs }) {
    const tradeId = str(inputs, "tradeId");
    const offer = sim.trades.get(tradeId);
    const from = sim.players.get(offer.from);
    const to = actor;
    const moveCash = (a: typeof from, b: typeof to, amount: number): void => {
      if (amount <= 0) return;
      a.wallet.debit(amount, a.stamp(`trade:${tradeId}:to:${b.id}`));
      b.wallet.credit(amount, b.stamp(`trade:${tradeId}:from:${a.id}`));
    };
    moveCash(from, to, offer.offerCash);
    moveCash(to, from, offer.askCash);
    const moveItems = (a: typeof from, b: typeof to, items: Record<string, number>): void => {
      for (const [id, qty] of Object.entries(items)) {
        a.inventory.remove(id, qty);
        b.inventory.add(id, qty);
      }
    };
    moveItems(from, to, offer.offerItems);
    moveItems(to, from, offer.askItems);
    from.touch();
    to.touch();
    sim.trades.markAccepted(tradeId);
    sim.emit("TRADE_ACCEPTED", { tradeId, from: from.id, to: to.id }, to.id);
    return sim.trades.get(tradeId);
  },
};

export const tradeDeclineAction: ActionDef<TradeOffer> = {
  id: "trade-decline",
  description: "Decline a pending trade you are part of.",
  validate({ sim, inputs }) {
    sim.trades.get(str(inputs, "tradeId"));
  },
  requires: [
    {
      id: "pending",
      check: (ctx) => {
        const offer = tradeOf(ctx);
        return offer.status === "pending" ? null : `Trade is already ${offer.status}`;
      },
    },
    {
      id: "participant",
      check: (ctx) => {
        const offer = tradeOf(ctx);
        return offer.to === ctx.actor.id || offer.from === ctx.actor.id ? null : "Not your trade";
      },
    },
  ],
  execute({ sim, actor, inputs }) {
    const offer = sim.trades.decline(str(inputs, "tradeId"), actor.id);
    sim.emit("TRADE_DECLINED", { tradeId: offer.id }, actor.id);
    return offer;
  },
};

export const tradeCancelAction: ActionDef<TradeOffer> = {
  id: "trade-cancel",
  description: "Cancel a pending trade you proposed.",
  validate({ sim, inputs }) {
    sim.trades.get(str(inputs, "tradeId"));
  },
  requires: [
    {
      id: "pending",
      check: (ctx) => {
        const offer = tradeOf(ctx);
        return offer.status === "pending" ? null : `Trade is already ${offer.status}`;
      },
    },
    {
      id: "proposer",
      check: (ctx) => (tradeOf(ctx).from === ctx.actor.id ? null : "Only the proposer can cancel"),
    },
  ],
  execute({ sim, actor, inputs }) {
    const offer = sim.trades.cancel(str(inputs, "tradeId"), actor.id);
    sim.emit("TRADE_CANCELLED", { tradeId: offer.id }, actor.id);
    return offer;
  },
};

export const businessBuyAction: ActionDef<void> = {
  id: "business-buy",
  description: "Buy an unowned business. Income accrues daily from then on.",
  validate({ sim, inputs }) {
    sim.businesses.get(str(inputs, "businessId"));
  },
  requires: [
    {
      id: "unowned",
      check: (ctx) => {
        const biz = businessOf(ctx);
        return biz.ownerId ? `${biz.name} is already owned` : null;
      },
    },
    requirements.hasCash((ctx) => businessOf(ctx).cost),
  ],
  execute({ sim, actor, inputs }) {
    const businessId = str(inputs, "businessId");
    const biz = sim.businesses.get(businessId);
    actor.touch();
    actor.wallet.debit(biz.cost, actor.stamp(`business:${businessId}`));
    biz.ownerId = actor.id;
    biz.lastCollectedDay = sim.clock.day;
    sim.emit("BUSINESS_BOUGHT", { businessId, cost: biz.cost }, actor.id);
  },
};

export const businessCollectAction: ActionDef<number> = {
  id: "business-collect",
  description: "Collect income accrued since the last collection.",
  validate({ sim, inputs }) {
    sim.businesses.get(str(inputs, "businessId"));
  },
  requires: [
    {
      id: "owner",
      check: (ctx) => {
        const biz = businessOf(ctx);
        return biz.ownerId === ctx.actor.id ? null : `You don't own ${biz.name}`;
      },
    },
    {
      id: "accrued",
      check: (ctx) => {
        const biz = businessOf(ctx);
        return ctx.sim.clock.day - biz.lastCollectedDay > 0
          ? null
          : `${biz.name} has nothing to collect yet — come back tomorrow`;
      },
    },
  ],
  execute({ sim, actor, inputs }) {
    const businessId = str(inputs, "businessId");
    const biz = sim.businesses.get(businessId);
    const days = sim.clock.day - biz.lastCollectedDay;
    const payout = biz.dailyIncome * days;
    actor.touch();
    biz.lastCollectedDay = sim.clock.day;
    actor.wallet.credit(payout, actor.stamp(`business-income:${businessId}`));
    sim.emit("BUSINESS_INCOME", { businessId, days, payout }, actor.id);
    return payout;
  },
};

export const missionAcceptAction: ActionDef<void> = {
  id: "mission-accept",
  description: "Take on a mission.",
  validate({ sim, inputs }) {
    sim.missions.get(str(inputs, "missionId"));
  },
  requires: [
    {
      id: "not-yet-accepted",
      check: (ctx) =>
        ctx.actor.missions[str(ctx.inputs, "missionId")]?.accepted
          ? "Mission already accepted"
          : null,
    },
  ],
  execute({ sim, actor, inputs }) {
    const missionId = str(inputs, "missionId");
    actor.touch();
    const state = (actor.missions[missionId] ??= { accepted: false, claimed: false });
    state.accepted = true;
    sim.emit("MISSION_ACCEPTED", { missionId }, actor.id);
  },
};

export const missionClaimAction: ActionDef<number> = {
  id: "mission-claim",
  description: "Claim the reward for a completed mission, once.",
  validate({ sim, inputs }) {
    sim.missions.get(str(inputs, "missionId"));
  },
  requires: [
    {
      id: "accepted",
      check: (ctx) =>
        ctx.actor.missions[str(ctx.inputs, "missionId")]?.accepted
          ? null
          : "Mission not accepted yet",
    },
    {
      id: "not-claimed",
      check: (ctx) =>
        ctx.actor.missions[str(ctx.inputs, "missionId")]?.claimed
          ? "Mission reward already claimed"
          : null,
    },
    {
      id: "complete",
      check: (ctx) =>
        ctx.sim.missionProgress(ctx.actor.id, str(ctx.inputs, "missionId")).done
          ? null
          : "Mission goal not complete yet",
    },
  ],
  execute({ sim, actor, inputs }) {
    const missionId = str(inputs, "missionId");
    const mission = sim.missions.get(missionId);
    actor.touch();
    actor.missions[missionId].claimed = true;
    actor.wallet.credit(mission.reward, actor.stamp(`mission:${missionId}`));
    actor.progression.addXp(mission.xp ?? 20);
    sim.emit("MISSION_COMPLETED", { missionId, reward: mission.reward }, actor.id);
    return mission.reward;
  },
};

export const hireAction: ActionDef<{ id: string; wage: number }> = {
  id: "hire",
  description: "Hire an employee for a business you own. The company pays them via payroll.",
  targetKind: "business",
  validate({ inputs }) {
    str(inputs, "id");
    const wage = inputs.wage;
    if (typeof wage !== "number" || !(wage > 0)) {
      throw invalidInput(`Wage must be positive, got ${String(wage)}`);
    }
  },
  requires: [
    {
      id: "owner",
      check: (ctx) => {
        const biz = ctx.sim.businesses.get((ctx.target as { id: string }).id);
        return biz.ownerId === ctx.actor.id ? null : `You don't own ${biz.name}`;
      },
    },
    {
      id: "id-free",
      check: (ctx) =>
        ctx.sim.entities.has(str(ctx.inputs, "id")) ? `Entity already exists: ${str(ctx.inputs, "id")}` : null,
    },
  ],
  execute({ sim, actor, inputs, target }) {
    const businessId = (target as { id: string }).id;
    const employee = defineEmployee(sim.entities, {
      id: str(inputs, "id"),
      name: (inputs.name as string | undefined) ?? str(inputs, "id"),
      role: inputs.role as string | undefined,
      wage: inputs.wage as number,
      employerId: businessId,
    });
    actor.touch();
    sim.emit("HIRED", { businessId, employeeId: employee.id, wage: employee.wage }, actor.id);
    return { id: employee.id, wage: employee.wage };
  },
};

export const payrollAction: ActionDef<{ total: number; payments: { employeeId: string; amount: number }[] }> = {
  id: "payroll",
  description: "Pay every employee of a business you own their wage, from your wallet.",
  targetKind: "business",
  requires: [
    {
      id: "owner",
      check: (ctx) => {
        const biz = ctx.sim.businesses.get((ctx.target as { id: string }).id);
        return biz.ownerId === ctx.actor.id ? null : `You don't own ${biz.name}`;
      },
    },
    {
      id: "has-employees",
      check: (ctx) =>
        employeesOf(ctx.sim.entities, (ctx.target as { id: string }).id).length > 0
          ? null
          : "No employees to pay",
    },
    requirements.hasCash((ctx) =>
      employeesOf(ctx.sim.entities, (ctx.target as { id: string }).id).reduce((s, e) => s + e.wage, 0),
    ),
  ],
  execute({ sim, actor, target }) {
    const businessId = (target as { id: string }).id;
    const payments: { employeeId: string; amount: number }[] = [];
    actor.touch();
    for (const emp of employeesOf(sim.entities, businessId)) {
      actor.wallet.debit(emp.wage, actor.stamp(`payroll:${businessId}:to:${emp.id}`));
      emp.balance += emp.wage;
      payments.push({ employeeId: emp.id, amount: emp.wage });
    }
    const total = payments.reduce((s, p) => s + p.amount, 0);
    sim.emit("PAYROLL_PAID", { businessId, total, payments }, actor.id);
    return { total, payments };
  },
};

export const settleObligationAction: ActionDef<{ amount: number; payee?: string; sunk: boolean }> = {
  id: "settle-obligation",
  description: "Settle one scheduled payment: debit the payer, credit the payee, or destroy the money.",
  validate({ sim, inputs }) {
    const s = sim.schedules.get(str(inputs, "scheduleId"));
    if (!s.active) throw invalidInput(`Schedule ${s.id} is not active`);
  },
  requires: [requirements.hasCash((ctx) => ctx.sim.schedules.get(str(ctx.inputs, "scheduleId")).amount)],
  execute({ sim, actor, inputs }) {
    const s = sim.schedules.get(str(inputs, "scheduleId"));
    actor.wallet.debit(s.amount, actor.stamp(s.reason));
    const payee = s.payee ? sim.actorIfPresent(s.payee) : undefined;
    const sunk = !payee;
    if (payee) payee.wallet.credit(s.amount, payee.stamp(`${s.reason}:from:${actor.id}`));
    sim.emit(
      "OBLIGATION_PAID",
      { scheduleId: s.id, amount: s.amount, payer: actor.id, payee: s.payee, sunk },
      actor.id,
    );
    return { amount: s.amount, payee: s.payee, sunk };
  },
};

export const SIM_ACTIONS: ActionDef<unknown>[] = [
  talkAction,
  transferAction,
  tradeOfferAction,
  tradeAcceptAction,
  tradeDeclineAction,
  tradeCancelAction,
  businessBuyAction,
  businessCollectAction,
  missionAcceptAction,
  missionClaimAction,
  hireAction,
  payrollAction,
  settleObligationAction,
] as ActionDef<unknown>[];
