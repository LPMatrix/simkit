import { ActionRefused } from "./runtime/action.js";
import { createSimulationFromConfig, type GameConfigFile } from "./config.js";
import { resetTxCounter } from "./wallet.js";
import type { Player } from "./player.js";
import type { SeededRng } from "./rng.js";
import type { Sim } from "./sim.js";

/**
 * Headless population runs for balancing and testing worlds (backlog item 6).
 * Many agents follow a daily routine for many days across several seeds;
 * the report aggregates wealth, employment, and obligation metrics plus any
 * invariant violations (which is what makes the runs trustworthy).
 */

export interface BehaviorContext {
  sim: Sim;
  agent: Player;
  /** 1-indexed simulated day. */
  day: number;
  rng: SeededRng;
}

export type BehaviorFn = (ctx: BehaviorContext) => void | Promise<void>;

/**
 * Baseline daily routine, documented and overridable: sleep when tired,
 * otherwise work (sleeping on refusal), then eat while energy is middling.
 * Unemployed agents idle. ActionRefused is routine; other errors propagate.
 */
export async function defaultBehavior({ agent }: BehaviorContext): Promise<void> {
  if (agent.energy < 25) {
    agent.sleep(8);
    return;
  }
  if (!agent.jobId) return;
  try {
    agent.work();
  } catch (err) {
    if (err instanceof ActionRefused) {
      agent.sleep(8);
      return;
    }
    throw err;
  }
  if (agent.energy < 60) {
    try {
      agent.eat();
    } catch (err) {
      if (!(err instanceof ActionRefused)) throw err;
    }
  }
}

export interface SimulateOptions {
  /** Declarative world, or a factory for programmatic setup. */
  world: GameConfigFile | ((seed: number | string) => Sim | Promise<Sim>);
  population: number;
  days: number;
  /** Explicit seeds; defaults to [1, 2, 3]. */
  seeds?: (number | string)[];
  /** Daily routine per agent; defaults to a work/sleep/eat baseline. */
  behavior?: BehaviorFn;
  /** "auto" assigns each agent a random job it qualifies for; "none" leaves all unemployed. */
  employ?: "auto" | "none";
}

export interface RunMetrics {
  population: number;
  employed: number;
  unemploymentRate: number;
  medianWealth: number;
  meanWealth: number;
  moneySupply: number;
  /** Median lifetime earnings per simulated day. */
  medianIncome: number;
  /** Share of agents with nothing left. No-debt model: broke means balance <= 0. */
  bankruptcyRate: number;
  missedObligations: number;
  /** Share of defined businesses with an owner; null when the world has none. */
  businessOwnershipRate: number | null;
  businessIncomeTotal: number;
  /** Refused action attempts (a friction proxy). */
  refusals: number;
}

export interface WorldRun {
  seed: number | string;
  days: number;
  metrics: RunMetrics;
  /** Invariant ids that failed on the final state (item 5). */
  invariantViolations: string[];
}

export interface SimulationReport {
  population: number;
  days: number;
  seeds: (number | string)[];
  runs: WorldRun[];
  aggregate: {
    meanWealth: number;
    medianWealth: number;
    moneySupply: number;
    unemploymentRate: number;
    bankruptcyRate: number;
    missedObligationsPerCapita: number;
    refusalsPerCapita: number;
    runsWithViolations: number;
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

async function buildWorld(
  world: SimulateOptions["world"],
  seed: number | string,
): Promise<Sim> {
  if (typeof world === "function") return world(seed);
  const { sim } = createSimulationFromConfig({ ...world, seed });
  return sim;
}

export async function simulate(opts: SimulateOptions): Promise<SimulationReport> {
  if (!Number.isInteger(opts.population) || opts.population <= 0) {
    throw new Error("population must be a positive integer");
  }
  if (!Number.isInteger(opts.days) || opts.days <= 0) {
    throw new Error("days must be a positive integer");
  }
  const seeds = opts.seeds ?? [1, 2, 3];
  if (seeds.length === 0) throw new Error("seeds must not be empty");
  const behavior = opts.behavior ?? defaultBehavior;
  const employ = opts.employ ?? "auto";

  const runs: WorldRun[] = [];
  for (const seed of seeds) {
    resetTxCounter();
    const sim = await buildWorld(opts.world, seed);
    const agents: Player[] = [];
    for (let i = 0; i < opts.population; i++) {
      agents.push(await sim.players.create({ name: `agent-${i}` }));
    }
    if (employ === "auto") {
      for (const agent of agents) {
        const qualified = sim.jobs.list().filter((j) => agent.progression.meets(j.requirements ?? {}));
        if (qualified.length > 0) agent.acceptJob(sim.rng.pick(qualified).id);
      }
    }
    for (let day = 1; day <= opts.days; day++) {
      // One loop iteration is exactly one clock day: intraday time is
      // suspended so sequential agents don't each advance the shared clock.
      sim.suspendTime = true;
      try {
        for (const agent of agents) {
          try {
            await behavior({ sim, agent, day, rng: sim.rng });
          } catch (err) {
            if (err instanceof ActionRefused) continue; // routine refusal; recorded in causes
            throw err;
          }
        }
      } finally {
        sim.suspendTime = false;
      }
      sim.advanceDays(1);
    }
    runs.push({ seed, days: opts.days, metrics: measure(sim, agents, opts), invariantViolations: [] });
    const violations = sim
      .checkInvariants()
      .filter((r) => !r.ok)
      .map((r) => r.id);
    runs[runs.length - 1].invariantViolations = violations;
  }

  const per = (f: (m: RunMetrics) => number): number[] => runs.map((r) => f(r.metrics));
  return {
    population: opts.population,
    days: opts.days,
    seeds: [...seeds],
    runs,
    aggregate: {
      meanWealth: mean(per((m) => m.meanWealth)),
      medianWealth: median(per((m) => m.medianWealth)),
      moneySupply: mean(per((m) => m.moneySupply)),
      unemploymentRate: mean(per((m) => m.unemploymentRate)),
      bankruptcyRate: mean(per((m) => m.bankruptcyRate)),
      missedObligationsPerCapita: mean(per((m) => m.missedObligations / m.population)),
      refusalsPerCapita: mean(per((m) => m.refusals / m.population)),
      runsWithViolations: runs.filter((r) => r.invariantViolations.length > 0).length,
    },
  };
}

function measure(sim: Sim, agents: Player[], opts: SimulateOptions): RunMetrics {
  const wealth = agents.map((a) => a.wallet.balance);
  const employed = agents.filter((a) => a.jobId).length;
  const businesses = sim.businesses.list();
  const businessIncomeTotal = sim.eventLog
    .filter((e) => e.type === "BUSINESS_INCOME")
    .reduce((s, e) => s + ((e.data as { payout?: number } | undefined)?.payout ?? 0), 0);
  return {
    population: agents.length,
    employed,
    unemploymentRate: agents.length === 0 ? 0 : 1 - employed / agents.length,
    medianWealth: median(wealth),
    meanWealth: mean(wealth),
    moneySupply: wealth.reduce((s, v) => s + v, 0),
    medianIncome: median(agents.map((a) => a.wallet.totalEarned() / opts.days)),
    bankruptcyRate: agents.length === 0 ? 0 : agents.filter((a) => a.wallet.balance <= 0).length / agents.length,
    missedObligations: sim.eventLog.filter((e) => e.type === "OBLIGATION_MISSED").length,
    businessOwnershipRate:
      businesses.length === 0 ? null : businesses.filter((b) => b.ownerId).length / businesses.length,
    businessIncomeTotal,
    refusals: sim.causalRecords().filter((c) => c.outcome === "refused").length,
  };
}
