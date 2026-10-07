/**
 * Usage metering for monetization tiers (§15 of the plan).
 *
 * Generous free tier to get developers building; paid tiers raise caps.
 * Enterprise = unlimited (custom pricing, enforced out-of-band).
 */
export type PlanTier = "free" | "developer" | "pro" | "enterprise";

export interface PlanLimits {
  maxPlayers: number;
  /** Simulation events per rolling 30-day window. */
  maxEvents: number;
  price: string;
}

export const PLANS: Record<PlanTier, PlanLimits> = {
  free: { maxPlayers: 1000, maxEvents: 100_000, price: "$0" },
  developer: { maxPlayers: 10_000, maxEvents: 1_000_000, price: "$29/mo" },
  pro: { maxPlayers: 100_000, maxEvents: 10_000_000, price: "$99/mo" },
  enterprise: { maxPlayers: Number.MAX_SAFE_INTEGER, maxEvents: Number.MAX_SAFE_INTEGER, price: "custom" },
};

interface WindowedUsage {
  windowStart: number;
  apiCalls: number;
  simulationEvents: number;
}

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function overLimitError(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 429 });
}

export class Meter {
  private plans = new Map<string, PlanTier>();
  private usage = new Map<string, WindowedUsage>();

  plan(gameId: string): PlanTier {
    return this.plans.get(gameId) ?? "free";
  }

  setPlan(gameId: string, tier: PlanTier): PlanTier {
    if (!PLANS[tier]) throw new Error(`Unknown plan tier: ${tier}`);
    this.plans.set(gameId, tier);
    return tier;
  }

  private window(gameId: string): WindowedUsage {
    const now = Date.now();
    let w = this.usage.get(gameId);
    if (!w || now - w.windowStart > WINDOW_MS) {
      w = { windowStart: now, apiCalls: 0, simulationEvents: 0 };
      this.usage.set(gameId, w);
    }
    return w;
  }

  recordApi(gameId: string): void {
    this.window(gameId).apiCalls += 1;
  }

  recordEvents(gameId: string, count: number): void {
    if (count <= 0) return;
    const w = this.window(gameId);
    w.simulationEvents += count;
    if (w.simulationEvents > PLANS[this.plan(gameId)].maxEvents) {
      throw overLimitError(
        `Simulation event quota exceeded for plan "${this.plan(gameId)}" (${PLANS[this.plan(gameId)].maxEvents}/30d). Upgrade to keep simulating.`,
      );
    }
  }

  /** Throws 429 when the game is over its plan's player cap. */
  checkPlayerCap(gameId: string, currentPlayers: number): void {
    const max = PLANS[this.plan(gameId)].maxPlayers;
    if (currentPlayers >= max) {
      throw overLimitError(
        `Player cap reached for plan "${this.plan(gameId)}" (${max} players). Upgrade to add more.`,
      );
    }
  }

  report(gameId: string, currentPlayers: number): {
    plan: PlanTier;
    limits: PlanLimits;
    usage: { players: number; apiCalls: number; simulationEvents: number };
  } {
    const w = this.window(gameId);
    return {
      plan: this.plan(gameId),
      limits: PLANS[this.plan(gameId)],
      usage: { players: currentPlayers, apiCalls: w.apiCalls, simulationEvents: w.simulationEvents },
    };
  }
}
