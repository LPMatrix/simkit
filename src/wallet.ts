import type { TransactionMeta } from "./types.js";

export type TransactionType = "credit" | "debit";

export interface Transaction {
  id: string;
  type: TransactionType;
  amount: number;
  reason?: string;
  day: number;
  time: string;
  meta?: TransactionMeta;
}

let txCounter = 0;

export function nextTxId(): string {
  txCounter += 1;
  return `tx_${txCounter}`;
}

export function resetTxCounter(): void {
  txCounter = 0;
}

/** Auditable money container. Every financial action creates a transaction. */
export class Wallet {
  balance: number;
  history: Transaction[] = [];

  constructor(startingBalance = 0) {
    this.balance = startingBalance;
  }

  credit(
    amount: number,
    meta: TransactionMeta & { day?: number; time?: string } = {},
  ): Transaction {
    if (amount < 0) throw new Error("Credit amount must be >= 0");
    const tx: Transaction = {
      id: nextTxId(),
      type: "credit",
      amount,
      reason: meta.reason,
      day: meta.day ?? 1,
      time: meta.time ?? "00:00",
      meta,
    };
    this.balance += amount;
    this.history.push(tx);
    return tx;
  }

  debit(
    amount: number,
    meta: TransactionMeta & { day?: number; time?: string } = {},
  ): Transaction {
    if (amount < 0) throw new Error("Debit amount must be >= 0");
    if (this.balance < amount) {
      throw new Error(
        `Insufficient funds: balance ${this.balance}, tried to debit ${amount}`,
      );
    }
    const tx: Transaction = {
      id: nextTxId(),
      type: "debit",
      amount,
      reason: meta.reason,
      day: meta.day ?? 1,
      time: meta.time ?? "00:00",
      meta,
    };
    this.balance -= amount;
    this.history.push(tx);
    return tx;
  }

  /** Remove all funds (console / reset tooling). Records a debit. */
  reset(meta: TransactionMeta & { day?: number; time?: string } = {}): void {
    if (this.balance > 0) {
      this.debit(this.balance, { ...meta, reason: meta.reason ?? "reset" });
    }
  }

  /** Earnings through play. Genesis funding (starting cash) is money supply, not earnings. */
  totalEarned(): number {
    return this.history
      .filter((t) => t.type === "credit" && t.reason !== "genesis")
      .reduce((s, t) => s + t.amount, 0);
  }

  totalSpent(): number {
    return this.history
      .filter((t) => t.type === "debit")
      .reduce((s, t) => s + t.amount, 0);
  }

  toJSON(): { balance: number; history: Transaction[] } {
    return { balance: this.balance, history: this.history };
  }

  static fromJSON(json: { balance: number; history: Transaction[] }): Wallet {
    const w = new Wallet(json.balance);
    w.history = json.history ?? [];
    return w;
  }
}
