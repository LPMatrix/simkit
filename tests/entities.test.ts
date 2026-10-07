import { describe, expect, it } from "vitest";
import { createSimulation, installPack, Sim } from "../src/index.js";

function hustleSim(): Sim {
  return createSimulation({
    gameId: "entities",
    seed: 9,
    startingCash: 50000,
    locations: [{ id: "yaba", travelCost: 0, travelTimeMinutes: 10 }],
    jobs: [{ id: "danfo-driver", salary: 150000, workingHours: 8 }],
    npcs: [{ id: "mama", name: "Mama", location: "yaba", dialogue: ["Eat!", "Pay!"] }],
    items: [{ id: "amala", price: 1500, energy: 30 }],
    businesses: [{ id: "buka", cost: 20000, dailyIncome: 1000 }],
    missions: [{ id: "earn-big", goal: { type: "earn", target: 20000 }, reward: 5000 }],
  });
}

describe("NPCs + relationships", () => {
  it("talks only in person, builds score deterministically", async () => {
    const sim = hustleSim();
    const p = await sim.players.create({ name: "A", location: "home" });
    await expect(
      (async () => sim.talk(p.id, "mama"))(),
    ).rejects.toThrow(/travel there first/);

    p.travel("yaba");
    const first = sim.talk(p.id, "mama");
    expect(["Eat!", "Pay!"]).toContain(first.line);
    expect(first.score).toBe(6);
    expect(first.level).toBe("stranger");

    sim.talk(p.id, "mama"); // 12 → acquaintance
    expect(p.relationships.level("mama")).toBe("acquaintance");
    expect(p.reputation).toBe(5); // level-up bonus
  });
});

describe("inventory", () => {
  it("buys, uses and sells with wallet effects", async () => {
    const sim = hustleSim();
    const p = await sim.players.create({ name: "B", location: "yaba" });
    p.adjustEnergy(-50);
    p.buy("amala", 2);
    expect(p.inventory.count("amala")).toBe(2);
    expect(p.wallet.balance).toBe(50000 - 3000);

    p.use("amala");
    expect(p.inventory.count("amala")).toBe(1);
    expect(p.energy).toBeGreaterThan(50);

    const gain = p.sell("amala", 1);
    expect(gain).toBe(750);
    expect(p.inventory.count("amala")).toBe(0);
  });

  it("rejects broke buys and empty uses", async () => {
    const sim = hustleSim();
    const p = await sim.players.create({ name: "C", location: "yaba", startingCash: 10 });
    expect(() => p.buy("amala")).toThrow(/Insufficient/);
    expect(() => p.use("amala")).toThrow(/Not enough/);
    expect(() => p.buy("nope")).toThrow(/Unknown item/);
  });
});

describe("P2P transfers", () => {
  it("moves money atomically with paired transactions", async () => {
    const sim = hustleSim();
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    sim.transfer(a.id, b.id, 5000, "gift");
    expect(a.wallet.balance).toBe(45000);
    expect(b.wallet.balance).toBe(55000);
    expect(a.wallet.history.at(-1)?.reason).toContain(`to:${b.id}`);
    expect(b.wallet.history.at(-1)?.reason).toContain(`from:${a.id}`);
  });

  it("rejects self, zero and broke transfers", async () => {
    const sim = hustleSim();
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    expect(() => sim.transfer(a.id, a.id, 100)).toThrow(/yourself/);
    expect(() => sim.transfer(a.id, b.id, 0)).toThrow(/positive/);
    expect(() => sim.transfer(a.id, b.id, 999_999)).toThrow(/Insufficient/);
    expect(() => sim.transfer(a.id, "ghost", 100)).toThrow(/Unknown player/);
    expect(a.wallet.balance).toBe(50000); // untouched
  });
});

describe("businesses", () => {
  it("buys once and accrues daily income", async () => {
    const sim = hustleSim();
    const p = await sim.players.create({ name: "D" });
    sim.buyBusiness(p.id, "buka");
    expect(p.wallet.balance).toBe(30000);
    expect(() => sim.buyBusiness(p.id, "buka")).toThrow(/already owned/);
    expect(() => sim.collectIncome(p.id, "buka")).toThrow(/nothing to collect/);

    sim.advanceDays(3);
    const payout = sim.collectIncome(p.id, "buka");
    expect(payout).toBe(3000);
    expect(p.wallet.balance).toBe(33000);
  });
});

describe("missions", () => {
  it("accept → progress → claim exactly once", async () => {
    const sim = hustleSim();
    const p = await sim.players.create({ name: "E" });
    expect(() => sim.claimMission(p.id, "earn-big")).toThrow(/not accepted/);
    sim.acceptMission(p.id, "earn-big");
    expect(() => sim.acceptMission(p.id, "earn-big")).toThrow(/already accepted/);
    expect(sim.missionProgress(p.id, "earn-big").done).toBe(false);
    expect(() => sim.claimMission(p.id, "earn-big")).toThrow(/not complete/);

    p.wallet.credit(25000, { reason: "hustle", day: 1, time: "08:00" });
    expect(sim.missionProgress(p.id, "earn-big").done).toBe(true);
    const reward = sim.claimMission(p.id, "earn-big");
    expect(reward).toBe(5000);
    expect(p.wallet.balance).toBe(50000 + 25000 + 5000);
    expect(() => sim.claimMission(p.id, "earn-big")).toThrow(/already claimed/);
  });
});

describe("persistence of new entities", () => {
  it("snapshot round-trips npcs, items, businesses, missions, inventory", async () => {
    const sim = hustleSim();
    installPack(sim, "characters-lagos");
    const p = await sim.players.create({ name: "F", location: "yaba" });
    p.buy("amala");
    sim.talk(p.id, "mama");
    sim.acceptMission(p.id, "first-100k");

    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.npcs.has("tech-bro")).toBe(true);
    expect(restored.items.has("suya")).toBe(true);
    expect(restored.businesses.has("mama-put-buka")).toBe(true);
    expect(restored.missions.has("first-100k")).toBe(true);
    const rp = restored.players.get(p.id);
    expect(rp.inventory.count("amala")).toBe(1);
    expect(rp.relationships.score("mama")).toBe(6);
    expect(rp.missions["first-100k"].accepted).toBe(true);
  });

  it("restores pre-entity snapshots with sane defaults", async () => {
    const sim = hustleSim();
    const p = await sim.players.create({ name: "G" });
    const snap = sim.snapshot();
    const legacy = { ...snap, players: [{ ...p.toJSON(), inventory: undefined, relationships: undefined, missions: undefined }] };
    const restored = Sim.restore(JSON.parse(JSON.stringify(legacy)));
    const rp = restored.players.get(p.id);
    expect(rp.inventory.count("amala")).toBe(0);
    expect(rp.relationships.score("mama")).toBe(0);
  });
});
