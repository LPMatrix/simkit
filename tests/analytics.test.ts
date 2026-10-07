import { describe, expect, it } from "vitest";
import { createSimulation } from "../src/index.js";

describe("analytics", () => {
  it("records daily series, buckets wealth, tracks retention", async () => {
    const sim = createSimulation({ gameId: "stats", seed: 5, startingCash: 50000 });
    const active = await sim.players.create({ name: "Active" });
    const rich = await sim.players.create({ name: "Rich" });
    rich.wallet.credit(500000, { reason: "test", day: 1, time: "08:00" });

    sim.advanceDays(10);
    expect(sim.history.map((h) => h.day)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(sim.history.at(-1)).toMatchObject({ players: 2 });

    active.touch();
    rich.touch();
    const a = sim.analytics();
    expect(a.series).toHaveLength(10);
    expect(a.retention).toMatchObject({ total: 2, active7d: 2, active30d: 2 });
    // 50k → ₦50–200k band, 550k → ₦200k–1m band
    expect(a.wealthBuckets.find((b) => b.label === "₦50–200k")?.count).toBe(1);
    expect(a.wealthBuckets.find((b) => b.label === "₦200k–1m")?.count).toBe(1);

    // Stale player drops out of 7d retention but stays in 30d.
    active.lastActiveDay = 1;
    sim.clock.advanceDays(10); // day 21 — no record (direct clock move)
    rich.touch();
    const b = sim.analytics();
    expect(b.retention).toMatchObject({ total: 2, active7d: 1, active30d: 2 });
  });

  it("survives snapshot round-trips", async () => {
    const sim = createSimulation({ gameId: "stats2", seed: 5 });
    await sim.players.create({ name: "A" });
    sim.advanceDays(3);
    const { Sim } = await import("../src/index.js");
    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.history).toHaveLength(3);
    expect(restored.analytics().series).toHaveLength(3);
  });
});
