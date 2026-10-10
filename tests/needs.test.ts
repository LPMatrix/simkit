import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { ActionRefused, createSimulation, requirements, Sim } from "../src/index.js";
import { GameRegistry } from "../server/registry.js";
import { createHttpServer } from "../server/http.js";

function thirstySim(): Sim {
  return createSimulation({
    gameId: "needs",
    seed: 3,
    startingCash: 20000,
    needs: [
      {
        id: "thirst",
        name: "Thirst",
        max: 100,
        decayPerDay: 30,
        thresholds: [{ below: 20, emit: "PARCHED" }],
      },
      { id: "morale", max: 100, decayPerDay: 0 },
    ],
    items: [
      { id: "water", price: 500, restores: { thirst: 50 } },
      { id: "mystery", price: 100, restores: { ghosts: 10 } },
    ],
  });
}

describe("need definitions", () => {
  it("validates max, initial, decay, and thresholds", async () => {
    const sim = createSimulation({ gameId: "ndef", seed: 1 });
    expect(() => sim.needs.define({ id: "", max: 10 })).toThrow(/must have an id/);
    expect(() => sim.needs.define({ id: "x", max: 0 })).toThrow(/positive max/);
    expect(() => sim.needs.define({ id: "x", max: 10, initial: -1 })).toThrow(/initial/);
    expect(() => sim.needs.define({ id: "x", max: 10, decayPerDay: -1 })).toThrow(/decayPerDay/);
    expect(() => sim.needs.define({ id: "x", max: 10, thresholds: [{ below: 5, emit: "" }] })).toThrow(
      /malformed threshold/,
    );
    expect(() => sim.needs.get("ghost")).toThrow(/Unknown need/);
    const n = sim.needs.define({ id: "thirst", max: 100 });
    expect(n).toMatchObject({ name: "thirst", decayPerDay: 0 });
    expect(sim.needs.list().map((x) => x.id)).toEqual(["energy", "health", "thirst"]); // builtins first
  });
});

describe("decay and thresholds", () => {
  it("decays daily, clamps at zero, and fires thresholds once until recovery", async () => {
    const sim = thirstySim();
    const p = await sim.players.create({ name: "A" });
    expect(p.needs.thirst).toBeUndefined(); // untouched until the first tick

    sim.advanceDays(1); // 100 → 70
    expect(p.needs.thirst).toBe(70);
    sim.advanceDays(1); // 70 → 40
    sim.advanceDays(1); // 40 → 10: crosses 20
    expect(p.needs.thirst).toBe(10);
    const parched = sim.eventLog.filter((e) => e.type === "PARCHED");
    expect(parched).toHaveLength(1);
    expect(parched[0]).toMatchObject({ playerId: p.id });
    expect(parched[0].data).toMatchObject({ needId: "thirst", value: 10 });

    sim.advanceDays(2); // 10 → 0, clamped; no refire while low
    expect(p.needs.thirst).toBe(0);
    expect(sim.eventLog.filter((e) => e.type === "PARCHED")).toHaveLength(1);
  });

  it("leaves static needs and other actors alone unless defined", async () => {
    const sim = thirstySim();
    const p = await sim.players.create({ name: "A" });
    sim.advanceDays(5);
    expect(p.needs.morale).toBeUndefined(); // decay 0 and never touched
    expect(p.needs.thirst).toBe(0); // clamped, not negative
  });
});

describe("restoration through items", () => {
  it("use() restores custom needs and clears alerts on recovery", async () => {
    const sim = thirstySim();
    const p = await sim.players.create({ name: "A" });
    sim.advanceDays(3); // thirst 10, PARCHED fired
    expect(p.needAlerts).toEqual({ "thirst:20": true });

    p.buy("water", 1);
    p.use("water"); // 10 + 50 = 60, above the threshold
    expect(p.needs.thirst).toBe(60);
    expect(p.needAlerts).toEqual({});
    const used = sim.eventLog.filter((e) => e.type === "PLAYER_USED_ITEM").at(-1);
    expect(used?.data).toMatchObject({ restored: { thirst: 50 } });

    sim.advanceDays(2); // 60 → 0, crosses again: refires
    expect(sim.eventLog.filter((e) => e.type === "PARCHED")).toHaveLength(2);
  });

  it("clamps restoration at max and rejects unknown needs", async () => {
    const sim = thirstySim();
    const p = await sim.players.create({ name: "A" });
    p.buy("water", 3);
    p.use("water"); // untouched thirst defaults to 100, stays 100
    expect(p.needs.thirst).toBe(100);
    p.buy("mystery", 1);
    expect(() => p.use("mystery")).toThrow(/Unknown need/);
  });
});

describe("needs gating actions", () => {
  it("needsAtLeast blocks and allows custom actions", async () => {
    const sim = thirstySim();
    sim.defineAction({
      id: "meditate",
      requires: [requirements.needsAtLeast({ thirst: 50 })],
      execute: () => "calm",
    });
    const p = await sim.players.create({ name: "A" });
    expect(sim.execute(p.id, "meditate")).toBe("calm"); // default 100 ≥ 50
    sim.advanceDays(2); // 100 → 40
    expect(() => sim.execute(p.id, "meditate")).toThrow(ActionRefused);
    try {
      sim.execute(p.id, "meditate");
    } catch (err) {
      expect((err as ActionRefused).reasons).toEqual(["Need thirst too low (40 < 50)"]);
    }
  });

  it("needs compose with jobs: thirsty work is still work", async () => {
    const sim = createSimulation({
      gameId: "combo",
      seed: 4,
      startingCash: 10000,
      jobs: [{ id: "porter", salary: 30000, workingHours: 8, energyCost: 10 }],
      needs: [{ id: "focus", max: 100, decayPerDay: 60 }],
    });
    sim.defineAction({
      id: "deep-work",
      requires: [requirements.needsAtLeast({ focus: 80 })],
      execute: ({ actor }) => {
        actor.wallet.credit(500, actor.stamp("deep-work"));
        return 500;
      },
    });
    const p = await sim.players.create({ name: "A" });
    p.acceptJob("porter");
    p.work(); // normal job loop unaffected by custom needs
    expect(p.wallet.balance).toBeGreaterThan(10000);
    sim.advanceDays(1); // focus 100 → 40
    expect(() => sim.execute(p.id, "deep-work")).toThrow(/Need focus too low/);
    // The refusal is recorded and explains itself in replay.
    const trace = sim.replay({ actorId: p.id }).at(-1);
    expect(trace).toMatchObject({ actionId: "deep-work", outcome: "refused" });
  });
});

describe("needs persistence and config", () => {
  it("round-trips defs, values, and alerts", async () => {
    const sim = thirstySim();
    const p = await sim.players.create({ name: "A" });
    sim.advanceDays(3); // thirst 10, alert set
    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.needs.get("thirst").max).toBe(100);
    const rp = restored.players.get(p.id);
    expect(rp.needs.thirst).toBe(10);
    expect(rp.needAlerts).toEqual({ "thirst:20": true });
    restored.advanceDays(1); // decay continues from restored state
    expect(rp.needs.thirst).toBe(0);
  });

    it("loads needs from YAML config", async () => {
    const { parseGameConfig, createSimulationFromConfig } = await import("../src/index.js");    const cfg = parseGameConfig(`
gameId: yaml-needs
needs:
  - id: mana
    max: 50
    decayPerDay: 5
    thresholds:
      - below: 10
        emit: MANA_LOW
items:
  - id: potion
    price: 100
    restores: { mana: 20 }
`);
    const { sim } = createSimulationFromConfig(cfg);
    expect(sim.needs.get("mana").decayPerDay).toBe(5);
    const p = await sim.players.create({ name: "A" });
    sim.advanceDays(9); // 50 → 5, crosses 10
    expect(sim.eventLog.some((e) => e.type === "MANA_LOW")).toBe(true);
    expect(p.needs.mana).toBe(5);
  });
});

describe("needs over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  const apiKey = "needs-key";

  beforeAll(async () => {
    const registry = new GameRegistry(null);
    await registry.init();
    await registry.create({ gameId: "needs-http", seed: 3 });
    server = createHttpServer(registry, { apiKeys: new Set([apiKey]), required: true });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("defines and lists needs, rejecting bad defs", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const created = await fetch(`${baseUrl}/v1/games/needs-http/needs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "thirst", max: 100, decayPerDay: 10 }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).id).toBe("thirst");

    const bad = await fetch(`${baseUrl}/v1/games/needs-http/needs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "x", max: 0 }),
    });
    expect(bad.status).toBe(400);

    const listed = await (await fetch(`${baseUrl}/v1/games/needs-http/needs`, { headers })).json();
    expect(listed.needs.map((n: { id: string }) => n.id)).toEqual(["energy", "health", "thirst"]);
  });
});

describe("energy and health resolve through the registry", () => {
  it("need bounds come from definitions, not hardcoded 100", async () => {
    const sim = createSimulation({ gameId: "bounds", seed: 1 });
    sim.needs.define({ id: "energy", max: 50 }); // redefine builtin bound
    const p = await sim.players.create({ name: "A" });
    p.energy = 0;
    p.sleep(8); // +60, clamped to the registered max
    expect(p.energy).toBe(50);
  });

  it("needsAtLeast reads actor energy, not the defaults map", async () => {
    const sim = createSimulation({ gameId: "gate", seed: 1 });
    sim.defineAction({
      id: "sprint",
      requires: [requirements.needsAtLeast({ energy: 10 })],
      execute: () => "fast",
    });
    const p = await sim.players.create({ name: "A" });
    expect(sim.execute(p.id, "sprint")).toBe("fast");
    p.adjustEnergy(-95); // 100 → 5, below the gate
    expect(() => sim.execute(p.id, "sprint")).toThrow(/Need energy too low \(5 < 10\)/);
  });

  it("unknown needs fail in gates instead of passing silently", async () => {
    const sim = createSimulation({ gameId: "typo", seed: 1 });
    sim.defineAction({
      id: "focus-work",
      requires: [requirements.needsAtLeast({ focuz: 10 })],
      execute: () => "done",
    });
    const p = await sim.players.create({ name: "A" });
    expect(() => sim.execute(p.id, "focus-work")).toThrow(/Unknown need/);
  });

  it("work keeps its exact refusal message through the registry", async () => {
    const sim = createSimulation({
      gameId: "msg",
      seed: 1,
      jobs: [{ id: "porter", salary: 30000, workingHours: 8, energyCost: 10 }],
    });
    const p = await sim.players.create({ name: "A" });
    p.acceptJob("porter");
    p.adjustEnergy(-95);
    expect(() => p.work()).toThrow("Too tired to work. Sleep or eat first.");
  });
});
