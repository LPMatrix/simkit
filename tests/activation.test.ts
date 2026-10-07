import { describe, expect, it } from "vitest";
import { createSimulation } from "../src/index.js";

describe("activation funnel", () => {
  it("tracks the road to playable from the event log", async () => {
    const sim = createSimulation({
      gameId: "funnel",
      seed: 1,
      jobs: [{ id: "driver", salary: 120000, workingHours: 8 }],
    });
    let a = sim.activation();
    expect(a.playable).toBe(false);
    expect(a.milestones.find((m) => m.id === "created")).toMatchObject({ reached: true, day: 1 });

    const p = await sim.players.create({ name: "A" });
    const q = await sim.players.create({ name: "B" });
    p.acceptJob("driver");
    p.work();
    sim.transfer(p.id, q.id, 500, "gift");

    a = sim.activation();
    expect(a.playable).toBe(true);
    expect(a.milestones).toMatchObject([
      { id: "created", reached: true, day: 1 },
      { id: "first-player", reached: true, day: 1 },
      { id: "first-job", reached: true, day: 1 },
      { id: "first-paycheck", reached: true, day: 1 },
      { id: "first-trade", reached: true, day: 1 },
    ]);
  });
});
