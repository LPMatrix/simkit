import { invalidInput } from "./runtime/action.js";

export type TradeStatus = "pending" | "accepted" | "declined" | "cancelled";

export interface TradeTerms {
  offerCash?: number;
  offerItems?: Record<string, number>;
  askCash?: number;
  askItems?: Record<string, number>;
}

export interface TradeOffer {
  id: string;
  from: string;
  to: string;
  offerCash: number;
  offerItems: Record<string, number>;
  askCash: number;
  askItems: Record<string, number>;
  status: TradeStatus;
  day: number;
}

function normItems(items?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, qty] of Object.entries(items ?? {})) {
    if (!Number.isInteger(qty) || qty <= 0) throw invalidInput(`Invalid quantity for ${id}: ${qty}`);
    out[id] = qty;
  }
  return out;
}

function normCash(n?: number): number {
  if (n == null) return 0;
  if (!Number.isFinite(n) || n < 0) throw invalidInput(`Invalid cash amount: ${n}`);
  return Math.floor(n);
}

/**
 * Multiplayer trade ledger (§10): propose cash+item swaps between players,
 * accept atomically, decline/cancel freely. Validated twice — at proposal
 * and at acceptance, since balances move in between.
 */
export class TradeLedger {
  private offers = new Map<string, TradeOffer>();
  private seq = 0;

  propose(from: string, to: string, terms: TradeTerms, day: number): TradeOffer {
    if (from === to) throw invalidInput("Cannot trade with yourself");
    const offer: TradeOffer = {
      id: `trade_${++this.seq}`,
      from,
      to,
      offerCash: normCash(terms.offerCash),
      offerItems: normItems(terms.offerItems),
      askCash: normCash(terms.askCash),
      askItems: normItems(terms.askItems),
      status: "pending",
      day,
    };
    if (offer.offerCash === 0 && offer.askCash === 0 &&
        Object.keys(offer.offerItems).length === 0 && Object.keys(offer.askItems).length === 0) {
      throw invalidInput("Trade must offer or ask something");
    }
    this.offers.set(offer.id, offer);
    return { ...offer };
  }

  get(id: string): TradeOffer {
    const offer = this.offers.get(id);
    if (!offer) throw new Error(`Unknown trade: ${id}`);
    return offer;
  }

  /** Pending trades involving a player (as proposer or counterparty). */
  pendingFor(playerId?: string): TradeOffer[] {
    return [...this.offers.values()]
      .filter((o) => o.status === "pending" && (!playerId || o.from === playerId || o.to === playerId))
      .map((o) => ({ ...o }));
  }

  /** Proposer cancels before acceptance. */
  cancel(id: string, by: string): TradeOffer {
    const offer = this.get(id);
    if (offer.status !== "pending") throw new Error(`Trade is already ${offer.status}`);
    if (offer.from !== by) throw new Error("Only the proposer can cancel");
    offer.status = "cancelled";
    return { ...offer };
  }

  /** Counterparty declines. */
  decline(id: string, by: string): TradeOffer {
    const offer = this.get(id);
    if (offer.status !== "pending") throw new Error(`Trade is already ${offer.status}`);
    if (offer.to !== by && offer.from !== by) throw new Error("Not your trade");
    offer.status = "declined";
    return { ...offer };
  }

  /** Mark accepted after the Sim moves the assets. */
  markAccepted(id: string): void {
    this.get(id).status = "accepted";
  }

  toJSON(): TradeOffer[] {
    return [...this.offers.values()].map((o) => ({ ...o }));
  }

  static fromJSON(json: TradeOffer[]): TradeLedger {
    const ledger = new TradeLedger();
    for (const o of json ?? []) {
      ledger.offers.set(o.id, { ...o });
      const n = Number(o.id.split("_")[1]);
      if (Number.isInteger(n) && n > ledger.seq) ledger.seq = n;
    }
    return ledger;
  }
}
