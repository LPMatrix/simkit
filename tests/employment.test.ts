import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import {
  ActionRefused,
  createSimulation,
  defineEmployee,
  employeesOf,
  getEmployee,
  Sim,
  SimClient,
} from "../src/index.js";
import { GameRegistry } from "../server/registry.js";
import { createHttpServer } from "../server/http.js";

function shopSim(): Sim {
  return createSimulation({
    gameId: "shop",
    seed: 11,
    startingCash: 50000,
    businesses: [{ id: "buka", name: "Buka", cost: 20000, dailyIncome: 1000 }],
  });
}

async function ownedShop(): Promise<{ sim: Sim; ownerId: string }> {
  const sim = shopSim();
  const owner = await sim.players.create({ name: "Owner" });
  sim.buyBusiness(owner.id, "buka");
  return { sim, ownerId: owner.id };
}

describe("businesses as entities", () => {
  it("stores ownership as an entity attribute", async () => {
    const { sim, ownerId } = await ownedShop();
    const entity = sim.entities.get("buka", "business");
    expect(entity.attributes.ownerId).toBe(ownerId);
    expect(sim.businesses.get("buka").ownerId).toBe(ownerId);
    expect(sim.businesses.ownedBy(ownerId).map((b) => b.id)).toEqual(["buka"]);
  });

  it("live views write through: direct mutation persists and snapshots", async () => {
    const { sim } = await ownedShop();
    sim.businesses.get("buka").dailyIncome = 2500;
    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.businesses.get("buka").dailyIncome).toBe(2500);
    expect(restored.businesses.get("buka").ownerId).toBe(sim.businesses.get("buka").ownerId);
  });

  it("upsert preserves ownership but rejects kind conflicts", async () => {
    const { sim, ownerId } = await ownedShop();
    sim.businesses.define({ id: "buka", cost: 30000, dailyIncome: 1500 });
    expect(sim.businesses.get("buka").ownerId).toBe(ownerId);
    expect(sim.businesses.get("buka").cost).toBe(30000);

    sim.entities.define({ id: "cs101", kind: "course" });
    expect(() => sim.businesses.define({ id: "cs101", cost: 1, dailyIncome: 1 })).toThrow(/not a business/);
  });

  it("restores legacy snapshots that carry businesses without entities", async () => {
    const sim = shopSim();
    const snap = sim.snapshot();
    const legacy = { ...snap, entities: undefined, businesses: snap.businesses };
    const restored = Sim.restore(JSON.parse(JSON.stringify(legacy)));
    expect(restored.businesses.list().map((b) => b.id)).toEqual(["buka"]);
    expect(restored.entities.get("buka", "business").attributes.cost).toBe(20000);
  });
});

describe("hire", () => {
  it("creates an employee entity owned by the business", async () => {
    const { sim, ownerId } = await ownedShop();
    const result = sim.execute(ownerId, "hire", {
      target: "buka",
      id: "cook",
      name: "Cook",
      wage: 5000,
      role: "chef",
    });
    expect(result).toEqual({ id: "cook", wage: 5000 });
    const emp = getEmployee(sim.entities, "cook");
    expect(emp).toMatchObject({ name: "Cook", role: "chef", wage: 5000, employerId: "buka", balance: 0 });
    expect(employeesOf(sim.entities, "buka").map((e) => e.id)).toEqual(["cook"]);
    expect(sim.eventLog.some((e) => e.type === "HIRED")).toBe(true);
  });

  it("refuses non-owners, duplicate ids, and bad wages", async () => {
    const { sim, ownerId } = await ownedShop();
    const stranger = await sim.players.create({ name: "Stranger" });
    expect(() => sim.execute(stranger.id, "hire", { target: "buka", id: "x", wage: 100 })).toThrow(
      /don't own/,
    );
    expect(() => sim.execute(ownerId, "hire", { target: "buka", id: "cook", wage: 0 })).toThrow(
      /Wage must be positive/,
    );
    sim.execute(ownerId, "hire", { target: "buka", id: "cook", wage: 100 });
    expect(() => sim.execute(ownerId, "hire", { target: "buka", id: "cook", wage: 100 })).toThrow(
      /already exists/,
    );
    // Refusals are recorded; validation failures are not.
    // 1 success + 2 refusals (non-owner, duplicate); the wage-0 validate failure leaves no record.
    const ids = sim.causalRecords().map((c) => c.actionId);
    expect(ids.filter((id) => id === "hire")).toHaveLength(3);
  });

  it("404s on unknown businesses", async () => {
    const { sim, ownerId } = await ownedShop();
    expect(() => sim.execute(ownerId, "hire", { target: "ghost", id: "x", wage: 100 })).toThrow(
      /Unknown business: ghost/,
    );
  });
});

describe("payroll", () => {
  it("pays every employee from the owner's wallet with ledger reasons", async () => {
    const { sim, ownerId } = await ownedShop();
    sim.execute(ownerId, "hire", { target: "buka", id: "cook", wage: 5000 });
    sim.execute(ownerId, "hire", { target: "buka", id: "server", wage: 3000 });
    const owner = sim.players.get(ownerId);
    const before = owner.wallet.balance; // 50000 - 20000 (buka)

    const result = sim.execute(ownerId, "payroll", { target: "buka" });
    expect(result).toEqual({
      total: 8000,
      payments: [
        { employeeId: "cook", amount: 5000 },
        { employeeId: "server", amount: 3000 },
      ],
    });
    expect(owner.wallet.balance).toBe(before - 8000);
    expect(getEmployee(sim.entities, "cook").balance).toBe(5000);
    expect(getEmployee(sim.entities, "server").balance).toBe(3000);
    const reasons = owner.wallet.history.slice(-2).map((t) => t.reason);
    expect(reasons).toEqual(["payroll:buka:to:cook", "payroll:buka:to:server"]);
    const payroll = sim.eventLog.find((e) => e.type === "PAYROLL_PAID");
    expect(payroll?.data).toMatchObject({ businessId: "buka", total: 8000 });
  });

  it("refuses when unaffordable or staff-less, moving nothing", async () => {
    const sim = shopSim();
    const owner = await sim.players.create({ name: "Owner", startingCash: 25000 });
    sim.buyBusiness(owner.id, "buka"); // 25000 - 20000 = 5000 left
    sim.execute(owner.id, "hire", { target: "buka", id: "cook", wage: 8000 });
    expect(() => sim.execute(owner.id, "payroll", { target: "buka" })).toThrow(/Insufficient funds/);
    expect(getEmployee(sim.entities, "cook").balance).toBe(0);
    expect(owner.wallet.balance).toBe(5000);

    const lone = await sim.players.create({ name: "Lone", startingCash: 100000 });
    sim.entities.define({ id: "empty", kind: "business", attributes: { cost: 0, dailyIncome: 0 } });
    // Bypass buy (cost 0 business, unowned): hire directly fails on ownership first.
    expect(() => sim.execute(lone.id, "payroll", { target: "empty" })).toThrow(/don't own/);
  });

  it("defineEmployee validates directly", () => {
    const sim = shopSim();
    expect(() => defineEmployee(sim.entities, { id: "x", wage: -5, employerId: "buka" })).toThrow(
      /Wage must be positive/,
    );
    expect(() => defineEmployee(sim.entities, { id: "x", wage: 100, employerId: "ghost" })).toThrow(
      /Unknown business: ghost/,
    );
  });
});

describe("employment over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  const apiKey = "employment-key";

  beforeAll(async () => {
    const registry = new GameRegistry(null);
    await registry.init();
    await registry.create({
      gameId: "biz",
      seed: 3,
      startingCash: 100000,
      businesses: [{ id: "stall", cost: 10000, dailyIncome: 500 }],
    });
    server = createHttpServer(registry, { apiKeys: new Set([apiKey]), required: true });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("hires and runs payroll through /actions, lists by employer", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const client = new SimClient({ baseUrl, apiKey, gameId: "biz" });
    const owner = await client.createPlayer({ name: "Boss" });
    await client.buyBusiness(owner.id, "stall");
    await client.hire(owner.id, "stall", { id: "attendant", wage: 2000 });

    const listed = await (
      await fetch(`${baseUrl}/v1/games/biz/entities?kind=employee&employerId=stall`, { headers })
    ).json();
    expect(listed.entities.map((e: { id: string }) => e.id)).toEqual(["attendant"]);

    const { total, player } = await client.payroll(owner.id, "stall");
    expect(total).toBe(2000);
    expect(player.wallet.balance).toBe(100000 - 10000 - 2000);

    // Double payroll in the same window is fine; balances accumulate on the entity.
    await client.payroll(owner.id, "stall");
    const again = await (
      await fetch(`${baseUrl}/v1/games/biz/entities?kind=employee&employerId=stall`, { headers })
    ).json();
    expect(again.entities[0].attributes.balance).toBe(4000);
  });

  it("non-owner hire fails over HTTP", async () => {
    const client = new SimClient({ baseUrl, apiKey, gameId: "biz" });
    const stranger = await client.createPlayer({ name: "Stranger" });
    await expect(client.hire(stranger.id, "stall", { id: "spy", wage: 100 })).rejects.toThrow(/don't own/);
  });
});

describe("ActionRefused is thrown for employment refusals", () => {
  it("surfaces reasons for hire and payroll", async () => {
    const { ActionRefused: Refused } = await import("../src/index.js");
    const { sim, ownerId } = await ownedShop();
    try {
      sim.execute(ownerId, "payroll", { target: "buka" });
      throw new Error("should refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(Refused);
      expect((err as InstanceType<typeof Refused>).reasons).toEqual(["No employees to pay"]);
    }
  });
});
