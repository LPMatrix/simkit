import { describe, expect, it } from "vitest";
import { parseSimulateArgs } from "../src/cli.js";
import { defaultBehavior, simulate, type BehaviorContext } from "../src/simulate.js";
import type { GameConfigFile } from "../src/config.js";

const WORLD: GameConfigFile = {
  gameId: "test-town",
  seed: 1,
  startingCash: 20000,
  locations: [{ id: "yaba", travelCost: 100, travelTimeMinutes: 10 }],
  jobs: [{ id: "driver", salary: 120000, workingHours: 8, energyCost: 20 }],
  items: [{ id: "amala", price: 1000, energy: 20 }],
};

describe("simulate", () => {
  it("returns shaped per-run and aggregate metrics", async () => {
    const report = await simulate({ world: WORLD, population: 8, days: 4, seeds: [1, 2] });
    expect(report.population).toBe(8);
    expect(report.days).toBe(4);
    expect(report.seeds).toEqual([1, 2]);
    expect(report.runs).toHaveLength(2);
    for (const run of report.runs) {
      expect(run.metrics.population).toBe(8);
      expect(run.metrics.employed).toBeGreaterThan(0);
      expect(run.invariantViolations).toEqual([]);
    }
    expect(report.aggregate.runsWithViolations).toBe(0);
    expect(report.aggregate.moneySupply).toBeGreaterThan(0);
  });

  it("is deterministic for the same seeds", async () => {
    const opts = { world: WORLD, population: 8, days: 4, seeds: [5] as (number | string)[] };
    const a = await simulate({ ...opts });
    const b = await simulate({ ...opts });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("accepts a world factory and custom behavior", async () => {
    let calls = 0;
    const counting = async (ctx: BehaviorContext): Promise<void> => {
      calls += 1;
      await defaultBehavior(ctx);
    };
    const { createSimulation } = await import("../src/index.js");
    const report = await simulate({
      world: (seed) =>
        createSimulation({ gameId: "factory", seed, startingCash: 1000, jobs: [{ id: "j", salary: 30000 }] }),
      population: 5,
      days: 3,
      seeds: [1],
      behavior: counting,
    });
    expect(calls).toBe(5 * 3);
    expect(report.runs[0].metrics.employed).toBe(5);
  });

  it("measures full unemployment when no jobs exist", async () => {
    const report = await simulate({
      world: { gameId: "jobless", seed: 1, startingCash: 5000 },
      population: 6,
      days: 3,
      seeds: [1],
    });
    expect(report.runs[0].metrics.unemploymentRate).toBe(1);
    expect(report.runs[0].metrics.employed).toBe(0);
  });

  it("counts missed obligations end to end", async () => {
    const report = await simulate({
      world: {
        ...WORLD,
        schedules: [{ id: "rent", payer: "nobody", amount: 10, everyDays: 1, reason: "rent" }],
      },
      population: 4,
      days: 3,
      seeds: [1],
    });
    // Unknown payer: the schedule can never settle, so every tick misses without stalling.
    expect(report.runs[0].metrics.missedObligations).toBe(3);
  });

  it("keeps loop-days aligned with clock-days no matter the population", async () => {
    // Without intraday suspension, N agents acting sequentially would advance
    // roughly N working days per loop-day and over-settle every schedule.
    const report = await simulate({
      world: {
        ...WORLD,
        schedules: [{ id: "rent", payer: "nobody", amount: 10, everyDays: 1, reason: "rent" }],
      },
      population: 20,
      days: 3,
      seeds: [1],
    });
    expect(report.runs[0].metrics.missedObligations).toBe(3);
  });
});

describe("parseSimulateArgs", () => {
  it("parses flags with defaults", () => {
    expect(parseSimulateArgs(["--config", "w.yaml"])).toMatchObject({
      config: "w.yaml",
      population: 100,
      days: 30,
      seeds: 3,
      seedBase: 1,
      json: false,
    });
    expect(
      parseSimulateArgs(["--config", "w.yaml", "--population", "10", "--days", "5", "--seeds", "2", "--json"]),
    ).toMatchObject({ population: 10, days: 5, seeds: 2, json: true });
  });

  it("rejects missing config and bad numbers", () => {
    expect(() => parseSimulateArgs([])).toThrow(/--config/);
    expect(() => parseSimulateArgs(["--config", "w.yaml", "--population", "0"])).toThrow(/positive integer/);
    expect(() => parseSimulateArgs(["--config", "w.yaml", "--days", "x"])).toThrow(/positive integer/);
  });
});
