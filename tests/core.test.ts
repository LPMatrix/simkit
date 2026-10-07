import { describe, expect, it } from "vitest";
import { createSimulation, Sim } from "../src/index.js";

describe("time", () => {
  it("starts Monday 08:00 and advances", async () => {
    const sim = new Sim({ gameId: "t", seed: 1 });
    expect(sim.clock.weekday).toBe("Monday");
    expect(sim.clock.timeLabel).toBe("08:00");
    sim.clock.advanceHours(8);
    expect(sim.clock.timeLabel).toBe("16:00");
  });
});

describe("economy", () => {
  it("credits salary and records transactions", async () => {
    const sim = createSimulation({
      seed: 1,
      jobs: [{ id: "danfo-driver", salary: 150000, workingHours: 8 }],
    });
    const p = await sim.players.create({ name: "A" });
    p.acceptJob("danfo-driver");
    const start = p.wallet.balance;
    p.work();
    expect(p.wallet.balance).toBe(start + 5000); // 150k / 30
    expect(p.wallet.history.length).toBeGreaterThan(0);
  });

  it("rejects debit beyond balance", async () => {
    const sim = createSimulation({ seed: 1, startingCash: 100 });
    const p = await sim.players.create({ name: "B" });
    expect(() => p.eat(999_999)).toThrow();
  });
});

describe("jobs", () => {
  it("enforces skill requirements", async () => {
    const sim = createSimulation({
      seed: 1,
      jobs: [{ id: "dev", salary: 350000, requirements: { coding: 50 } }],
    });
    const p = await sim.players.create({ name: "C" });
    expect(() => p.acceptJob("dev")).toThrow();
    p.progression.setStat("coding", 60);
    p.acceptJob("dev");
    expect(p.jobId).toBe("dev");
  });
});

describe("travel + sleep", () => {
  it("charges cost and time, restores energy on sleep", async () => {
    const sim = createSimulation({
      seed: 1,
      startingCash: 50000,
      locations: [{ id: "yaba", travelCost: 500, travelTimeMinutes: 30 }],
    });
    const p = await sim.players.create({ name: "D", location: "home" });
    const before = p.wallet.balance;
    p.travel("yaba");
    expect(p.locationId).toBe("yaba");
    expect(p.wallet.balance).toBe(before - 500);
    p.adjustEnergy(-80);
    p.sleep();
    expect(p.energy).toBeGreaterThan(50);
  });
});

describe("events + determinism", () => {
  it("same seed produces same event sequence", async () => {
    const mk = (): Sim =>
      createSimulation({
        seed: "game-93821",
        events: [{ id: "fuel-crisis", probability: 0.2 }],
      });
    const a = mk();
    const b = mk();
    await a.players.create({ name: "A" });
    await b.players.create({ name: "B" });
    a.advanceDays(30);
    b.advanceDays(30);
    expect(a.replayLog()).toEqual(b.replayLog());
    expect(a.stats().eventCounts).toEqual(b.stats().eventCounts);
  });

  it("snapshot restore preserves state and rng", async () => {
    const sim = createSimulation({ gameId: "g", seed: 7 });
    const p = await sim.players.create({ name: "E" });
    p.wallet.credit(1000, { reason: "test", day: 1, time: "08:00" });
    const snap = sim.snapshot();
    const restored = Sim.restore(JSON.parse(JSON.stringify(snap)));
    expect(restored.players.get(p.id).wallet.balance).toBe(p.wallet.balance);
    expect(restored.clock.day).toBe(sim.clock.day);
  });
});

describe("simulation console", () => {
  it("giveAll / advanceWeek / trigger work", async () => {
    const sim = createSimulation({
      seed: 3,
      events: [{ id: "fuel-crisis", probability: 0 }],
    });
    await sim.players.create({ name: "F" });
    sim.console.giveAll(10000);
    expect(sim.stats().totalCurrency).toBeGreaterThan(0);
    sim.console.advanceWeek();
    expect(sim.clock.day).toBe(8);
    sim.triggerEvent("fuel-crisis");
    expect(sim.stats().eventCounts["fuel-crisis"]).toBe(1);
  });
});
