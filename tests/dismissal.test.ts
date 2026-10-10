import { describe, expect, it } from "vitest";
import { createSimulation, Sim } from "../src/index.js";

function factorySim(opts: { dismiss?: number } = {}): Sim {
  return createSimulation({
    gameId: "dismiss",
    seed: 5,
    startingCash: 100000,
    jobs: [
      { id: "strict", name: "Strict", salary: 90000, workingHours: 8, energyCost: 10, dismissAfterAbsentDays: opts.dismiss },
      { id: "chill", name: "Chill", salary: 60000, workingHours: 8, energyCost: 10 },
    ],
  });
}

describe("dismissal validation", () => {
  it("accepts integers >= 0 and rejects anything else", () => {
    const sim = factorySim();
    expect(() => sim.jobs.define({ id: "a", salary: 1, dismissAfterAbsentDays: 0 })).not.toThrow();
    expect(() => sim.jobs.define({ id: "b", salary: 1, dismissAfterAbsentDays: 3 })).not.toThrow();
    expect(() => sim.jobs.define({ id: "c", salary: 1, dismissAfterAbsentDays: -1 })).toThrow(/integer >= 0/);
    expect(() => sim.jobs.define({ id: "d", salary: 1, dismissAfterAbsentDays: 1.5 })).toThrow(/integer >= 0/);
  });
});

describe("dismissal timing", () => {
  it("fires only once absence exceeds the threshold, not at it", async () => {
    const sim = factorySim({ dismiss: 2 });
    const p = await sim.players.create({ name: "A" });
    p.acceptJob("strict");
    p.work(); // day 1 shift
    expect(p.jobId).toBe("strict");

    sim.advanceDays(1); // day 2: absent 1
    expect(p.jobId).toBe("strict");
    sim.advanceDays(1); // day 3: absent 2 — at threshold, tolerated
    expect(p.jobId).toBe("strict");
    sim.advanceDays(1); // day 4: absent 3 — exceeds, dismissed
    expect(p.jobId).toBeNull();

    const fired = sim.eventLog.filter((e) => e.type === "JOB_DISMISSED");
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ playerId: p.id });
    expect(fired[0].data).toMatchObject({ jobId: "strict", absentDays: 3, threshold: 2 });
  });

  it("never fires for jobs without a threshold, however long the absence", async () => {
    const sim = factorySim();
    const p = await sim.players.create({ name: "B" });
    p.acceptJob("chill");
    sim.advanceDays(365);
    expect(p.jobId).toBe("chill");
    expect(sim.eventLog.filter((e) => e.type === "JOB_DISMISSED")).toHaveLength(0);
  });

  it("hiring day counts as present, so absence starts counting from hire", async () => {
    const sim = factorySim({ dismiss: 1 });
    const p = await sim.players.create({ name: "C" });
    sim.advanceDays(1); // day 2: hire never happened yet
    p.acceptJob("strict"); // hired day 2: clock restarts
    sim.advanceDays(1); // day 3: absent 1, tolerated
    expect(p.jobId).toBe("strict");
    sim.advanceDays(1); // day 4: absent 2, dismissed
    expect(p.jobId).toBeNull();
  });

  it("regular work prevents dismissal under the documented clock drift", async () => {
    // work (8h) + advanceDays (24h) moves 32h per cycle, so shift-start days
    // drift (1, 2, 4, 5, ...) leaving absent gaps of 2 in steady state.
    // Threshold 2 tolerates that; threshold 1 would not.
    const sim = factorySim({ dismiss: 2 });
    const p = await sim.players.create({ name: "D" });
    p.acceptJob("strict");
    for (let i = 0; i < 6; i++) {
      p.work();
      sim.advanceDays(1);
    }
    expect(p.jobId).toBe("strict");
    expect(sim.eventLog.filter((e) => e.type === "JOB_DISMISSED")).toHaveLength(0);
  });

  it("rehiring after dismissal restarts the absence clock, then dismisses again", async () => {
    const sim = factorySim({ dismiss: 1 });
    const p = await sim.players.create({ name: "E" });
    p.acceptJob("strict");
    p.work(); // day 1
    sim.advanceDays(3); // days 2-4; day 3 absent 2 > 1 → dismissed
    expect(p.jobId).toBeNull();
    p.acceptJob("strict"); // day 4: clock restarts
    expect(sim.jobs.get("strict").dismissAfterAbsentDays).toBe(1);
    sim.advanceDays(1); // day 5: absent 1, tolerated
    expect(p.jobId).toBe("strict");
    sim.advanceDays(1); // day 6: absent 2, dismissed again
    expect(p.jobId).toBeNull();
    expect(sim.eventLog.filter((e) => e.type === "JOB_DISMISSED")).toHaveLength(2);
  });

  it("dismisses NPC actors holding jobs too", async () => {
    const sim = factorySim({ dismiss: 1 });
    sim.npcs.define({ id: "mama", name: "Mama", dialogue: ["Eat!"] });
    await sim.players.create({ name: "P" });
    sim.execute("mama", "accept-job", { jobId: "strict" });
    sim.advanceDays(2); // day 3: absent 2 > 1
    expect(sim.actorOf("mama").jobId).toBeNull();
    const fired = sim.eventLog.find((e) => e.type === "JOB_DISMISSED");
    expect(fired).toMatchObject({ playerId: "mama" });
  });
});

describe("work history persistence", () => {
  it("round-trips stamps, and dismissal works after restore", async () => {
    const sim = factorySim({ dismiss: 2 });
    const p = await sim.players.create({ name: "F" });
    p.acceptJob("strict");
    p.work(); // day 1
    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    const rp = restored.players.get(p.id);
    expect(rp.workHistory).toEqual({ strict: 1 });
    restored.advanceDays(4); // day 5: absent 4 > 2
    expect(rp.jobId).toBeNull();
    expect(restored.eventLog.filter((e) => e.type === "JOB_DISMISSED")).toHaveLength(1);
  });

  it("old saves without workHistory load safely: no stamps means no dismissal until real work", async () => {
    const sim = factorySim({ dismiss: 2 });
    const p = await sim.players.create({ name: "G" });
    p.acceptJob("strict");
    const snap = sim.snapshot() as unknown as { players: Record<string, unknown>[] };
    for (const pl of snap.players) delete pl.workHistory;
    const restored = Sim.restore(JSON.parse(JSON.stringify(snap)));
    const rp = restored.players.get(p.id);
    expect(rp.workHistory).toEqual({});
    // Missing stamps fall back to the current tick day: absence reads as 0,
    // so a legacy save is never insta-dismissed — even after long advances.
    restored.advanceDays(30);
    expect(rp.jobId).toBe("strict");
    // Once a real stamp exists, dismissal applies normally from it.
    rp.workHistory.strict = 5;
    restored.advanceDays(4); // day 5 → 9: absent 4 > 2
    expect(rp.jobId).toBeNull();
  });
});
