import { describe, expect, it } from "vitest";
import { createSimulation } from "../src/index.js";

describe("leaderboards", () => {
  it("ranks by wealth with dense ties and limits", async () => {
    const sim = createSimulation({ gameId: "boards", seed: 1, startingCash: 0 });
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    const c = await sim.players.create({ name: "C" });
    a.wallet.credit(100, { reason: "t", day: 1, time: "08:00" });
    b.wallet.credit(100, { reason: "t", day: 1, time: "08:00" });
    c.wallet.credit(50, { reason: "t", day: 1, time: "08:00" });

    const board = sim.leaderboard("wealth");
    expect(board.map((e) => [e.name, e.rank, e.value])).toEqual([
      ["A", 1, 100],
      ["B", 1, 100],
      ["C", 2, 50],
    ]);
    expect(sim.leaderboard("wealth", 2)).toHaveLength(2);
    expect(sim.rankOf(c.id)).toEqual({ rank: 2, total: 3 });
    expect(sim.rankOf("ghost")).toBeNull();
    expect(() => sim.leaderboard("vibes" as never)).toThrow(/Unknown leaderboard metric/);
  });

  it("supports level, xp and reputation metrics", async () => {
    const sim = createSimulation({ gameId: "boards2", seed: 1 });
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    a.progression.addXp(500);
    b.adjustReputation(10);
    expect(sim.leaderboard("xp")[0].playerId).toBe(a.id);
    expect(sim.leaderboard("reputation")[0].playerId).toBe(b.id);
    expect(sim.leaderboard("level")[0].value).toBeGreaterThanOrEqual(1);
  });
});

describe("economy observability", () => {
  it("tracks issued/destroyed, inflation, jobs, visits, activities", async () => {
    const sim = createSimulation({
      gameId: "econ",
      seed: 1,
      startingCash: 20000,
      locations: [
        { id: "yaba", travelCost: 500, travelTimeMinutes: 30 },
        { id: "lekki", travelCost: 1000, travelTimeMinutes: 60 },
      ],
      jobs: [
        { id: "banker", salary: 300000, workingHours: 8 },
        { id: "driver", salary: 120000, workingHours: 8 },
      ],
    });
    const p = await sim.players.create({ name: "A", location: "home" });
    p.travel("yaba");   // -500, visit yaba
    p.travel("lekki");  // -1000, visit lekki
    p.acceptJob("banker");
    p.work();           // +10000
    sim.console.setPrice("transport", 1.2);

    const e = sim.economics();
    expect(e.issued).toBe(30000); // 20000 genesis funding + 10000 salary
    expect(e.destroyed).toBe(1500);
    expect(e.net).toBe(28500);
    expect(e.inflationPct).toBe(20);
    expect(e.topJobs[0]).toMatchObject({ id: "banker", dailyPay: 10000 });
    expect(e.locations.find((l) => l.id === "yaba")).toMatchObject({ residents: 0, visits: 1 });
    expect(e.locations.find((l) => l.id === "lekki")).toMatchObject({ residents: 1, visits: 1 });
    const worked = e.activities.find((a) => a.type === "PLAYER_WORKED");
    expect(worked?.count).toBe(1);
  });
});
