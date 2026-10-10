import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createSimulation, SimClient, type Sim, type System } from "../src/index.js";
import { GameRegistry } from "../server/registry.js";
import { createHttpServer } from "../server/http.js";

/**
 * A third-party system, defined entirely outside src/. If this file can
 * install behavior (actions, schedules, daily hooks, reports) through the
 * public API, the composability claim holds.
 */
function weatherSystem(): System {
  return {
    id: "weather",
    description: "Daily conditions that move goods prices.",
    actions: [
      {
        id: "forecast",
        description: "Read the current condition.",
        execute({ sim, actor }) {
          const condition = sim.entities.get("weather").attributes.condition;
          sim.emit("FORECAST_READ", { condition }, actor.id);
          return condition;
        },
      },
    ],
    schedules: [
      { id: "wx-fee", payer: "player_1", amount: 50, everyDays: 1, reason: "weather-lab" },
    ],
    onTick({ sim }) {
      const w = sim.entities.get("weather");
      const condition = sim.rng.next() < 0.5 ? "sunny" : "storm";
      w.attributes.condition = condition;
      sim.priceModifiers.goods = condition === "storm" ? 1.5 : 1;
    },
    report({ sim }) {
      return { condition: sim.entities.get("weather").attributes.condition };
    },
  };
}

function withWeather(seed = 11): Promise<{ sim: Sim; playerId: string }> {
  return (async () => {
    const sim = createSimulation({ gameId: "wx", seed, startingCash: 10000 });
    sim.entities.define({ id: "weather", kind: "weather", attributes: { condition: "sunny" } });
    const player = await sim.players.create({ name: "A" });
    sim.use(weatherSystem());
    return { sim, playerId: player.id };
  })();
}

describe("built-ins load through use()", () => {
  it("installs ten systems and every action exactly once", () => {
    const sim = createSimulation({ gameId: "sys", seed: 1 });
    expect(sim.systems().map((s) => s.id)).toEqual([
      "jobs",
      "needs",
      "world",
      "market",
      "social",
      "economy",
      "trades",
      "business",
      "missions",
      "entities",
    ]);
    expect(sim.listActions()).toHaveLength(23);
  });

  it("rejects duplicate systems and garbage definitions", () => {
    const sim = createSimulation({ gameId: "sys2", seed: 1 });
    expect(() => sim.use({ id: "jobs", actions: [] })).toThrow(/already installed/);
    expect(() => sim.use({} as never)).toThrow(/pack or a system/);
    expect(() => sim.use({ id: "nope" } as never)).toThrow(/pack or a system/);
  });
});

describe("third-party systems", () => {
  it("installs actions, schedules, hooks, and reports without touching src/", async () => {
    const { sim, playerId } = await withWeather();
    expect(sim.systems().at(-1)).toMatchObject({ id: "weather" });
    expect(sim.listActions().map((a) => a.id)).toContain("forecast");
    expect(sim.schedules.get("wx-fee").amount).toBe(50);

    sim.advanceDays(3);
    // Schedule settled daily through the pipeline.
    const player = sim.players.get(playerId);
    expect(player.wallet.history.filter((t) => t.reason === "weather-lab")).toHaveLength(3);
    // Hook ran each day and moved prices deterministically.
    expect(sim.systemReport()).toMatchObject({
      weather: { condition: expect.stringMatching(/sunny|storm/) },
    });
    expect(sim.execute(playerId, "forecast")).toBe(
      (sim.systemReport().weather as { condition: string }).condition,
    );
  });

  it("is deterministic for the same seed", async () => {
    const a = await withWeather(77);
    const b = await withWeather(77);
    a.sim.advanceDays(5);
    b.sim.advanceDays(5);
    expect(a.sim.priceModifiers).toEqual(b.sim.priceModifiers);
    expect(a.sim.entities.get("weather").attributes).toEqual(b.sim.entities.get("weather").attributes);
  });

  it("hooks observe the settled day: events, then schedules, then hooks", async () => {
    const sim = createSimulation({ gameId: "order", seed: 1, startingCash: 1000 });
    const p = await sim.players.create({ name: "A" });
    const seen: { day: number; balance: number }[] = [];
    sim.use({
      id: "recorder",
      onTick({ sim: s, day }) {
        seen.push({ day, balance: s.players.get(p.id).wallet.balance });
      },
    });
    sim.schedules.define({ id: "fee", payer: p.id, amount: 100, everyDays: 1, reason: "fee" });
    sim.advanceDays(2); // days 2, 3
    expect(seen).toEqual([
      { day: 2, balance: 900 }, // fee already debited when the hook runs
      { day: 3, balance: 800 },
    ]);
  });

  it("a throwing hook is logged and skipped without stalling the world", async () => {
    const sim = createSimulation({ gameId: "fragile", seed: 1, startingCash: 1000 });
    const p = await sim.players.create({ name: "A" });
    const ran: number[] = [];
    sim.use({ id: "bomb", onTick: () => { throw new Error("boom"); } });
    sim.use({ id: "witness", onTick: ({ day }) => { ran.push(day); } });
    sim.schedules.define({ id: "fee", payer: p.id, amount: 10, everyDays: 1, reason: "fee" });
    sim.advanceDays(2);
    expect(sim.eventLog.filter((e) => e.type === "SYSTEM_TICK_FAILED")).toHaveLength(2);
    expect(ran).toEqual([2, 3]); // later hooks still ran, both days processed
    expect(p.wallet.history.filter((t) => t.reason === "fee")).toHaveLength(2); // schedules unaffected
  });
});

describe("systems over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  const apiKey = "systems-key";

  beforeAll(async () => {
    const registry = new GameRegistry(null);
    await registry.init();
    await registry.create({ gameId: "syshttp", seed: 3 });
    server = createHttpServer(registry, { apiKeys: new Set([apiKey]), required: true });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("lists installed systems", async () => {
    const headers = { "x-api-key": apiKey };
    const client = new SimClient({ baseUrl, apiKey, gameId: "syshttp" });
    const listed = await client.listSystems();
    expect(listed.systems.map((s) => s.id)).toContain("jobs");
    const raw = await (await fetch(`${baseUrl}/v1/games/syshttp/systems`, { headers })).json();
    expect(raw.systems).toHaveLength(10);
  });
});

describe("system dependencies", () => {
  const farm: System = {
    id: "farm",
    description: "Grows crops; needs seasons and irrigation.",
    dependencies: ["seasons", "irrigation"],
    actions: [{ id: "harvest", execute: () => "wheat" }],
  };

  it("names every missing dependency and installs nothing on failure", () => {
    const sim = createSimulation({ gameId: "deps", seed: 1 });
    const actionsBefore = sim.listActions().length;
    expect(() => sim.use(farm)).toThrow(/needs missing dependencies: seasons, irrigation/);
    expect(sim.systems().map((s) => s.id)).not.toContain("farm");
    expect(sim.listActions()).toHaveLength(actionsBefore);
  });

  it("installs once dependencies are present", () => {
    const sim = createSimulation({ gameId: "deps2", seed: 1 });
    sim.use({ id: "irrigation", description: "Water.", actions: [] });
    expect(() => sim.use(farm)).toThrow(/needs missing dependency: seasons\./);
    sim.use({ id: "seasons", description: "Seasons.", actions: [] });
    sim.use(farm);
    expect(sim.systems().map((s) => s.id)).toContain("farm");
    expect(sim.listActions().map((a) => a.id)).toContain("harvest");
  });

  it("accepts a dependencies-only bundle as a system", async () => {
    const sim = createSimulation({ gameId: "deps3", seed: 1 });
    const before = sim.listActions().length;
    sim.use({ id: "meta", dependencies: [] });
    expect(sim.systems().map((s) => s.id)).toContain("meta");
    expect(sim.listActions()).toHaveLength(before);
    const p = await sim.players.create({ name: "A" });
    expect(() => sim.execute(p.id, "harvest")).toThrow(/Unknown action/);
  });
});
