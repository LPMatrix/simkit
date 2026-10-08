import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createSimulation, Sim, SimClient } from "../src/index.js";
import { GameRegistry } from "../server/registry.js";
import { createHttpServer } from "../server/http.js";

describe("pause and resume", () => {
  it("freezes mutation and emits log entries, idempotently", async () => {
    const sim = createSimulation({ gameId: "pause", seed: 1 });
    expect(sim.paused).toBe(false);
    sim.pause();
    expect(sim.paused).toBe(true);
    sim.pause();
    expect(sim.eventLog.filter((e) => e.type === "WORLD_PAUSED")).toHaveLength(1);
    sim.resume();
    expect(sim.paused).toBe(false);
    sim.resume();
    expect(sim.eventLog.filter((e) => e.type === "WORLD_RESUMED")).toHaveLength(1);
  });

  it("persists across snapshots, defaulting to running", async () => {
    const sim = createSimulation({ gameId: "pause2", seed: 1 });
    sim.pause();
    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.paused).toBe(true);
    const legacy = Sim.restore(JSON.parse(JSON.stringify({ ...sim.snapshot(), paused: undefined })));
    expect(legacy.paused).toBe(false);
  });
});

describe("control room over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  const apiKey = "control-key";

  beforeAll(async () => {
    const registry = new GameRegistry(null);
    await registry.init();
    await registry.create({
      gameId: "control",
      seed: 3,
      startingCash: 50000,
      locations: [{ id: "yaba", travelCost: 0, travelTimeMinutes: 5 }],
      jobs: [{ id: "driver", salary: 90000, workingHours: 8 }],
    });
    const sim = registry.get("control");
    sim.npcs.define({ id: "mama", name: "Mama", location: "yaba", dialogue: ["Eat!"] });
    server = createHttpServer(registry, { apiKeys: new Set([apiKey]), required: true });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("blocks mutation with 423 while paused, lets reads through, and resumes", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const client = new SimClient({ baseUrl, apiKey, gameId: "control" });
    const p = await client.createPlayer({ name: "Op", location: "yaba" });

    expect(await client.pause()).toEqual({ paused: true });
    const info = await (await fetch(`${baseUrl}/v1/games/control`, { headers })).json();
    expect(info.paused).toBe(true);

    const advance = await fetch(`${baseUrl}/v1/games/control/advance`, {
      method: "POST", headers, body: JSON.stringify({ days: 1 }),
    });
    expect(advance.status).toBe(423);

    const act = await fetch(`${baseUrl}/v1/games/control/players/${p.id}/actions`, {
      method: "POST", headers, body: JSON.stringify({ action: "sleep" }),
    });
    expect(act.status).toBe(423);

    const give = await fetch(`${baseUrl}/v1/games/control/console/give-all`, {
      method: "POST", headers, body: JSON.stringify({ amount: 1 }),
    });
    expect(give.status).toBe(423);

    // Reads pass through.
    expect((await fetch(`${baseUrl}/v1/games/control/players`, { headers })).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/games/control/log?limit=5`, { headers })).status).toBe(200);

    // Unknown games still 404, not 423.
    const ghost = await fetch(`${baseUrl}/v1/games/ghost/advance`, {
      method: "POST", headers, body: JSON.stringify({ days: 1 }),
    });
    expect(ghost.status).toBe(404);

    expect(await client.resume()).toEqual({ paused: false });
    const after = await fetch(`${baseUrl}/v1/games/control/advance`, {
      method: "POST", headers, body: JSON.stringify({ days: 1 }),
    });
    expect(after.status).toBe(200);
  });

  it("inspects players and NPC actors through one route", async () => {
    const headers = { "x-api-key": apiKey };
    const client = new SimClient({ baseUrl, apiKey, gameId: "control" });
    const p = await client.createPlayer({ name: "Watched", location: "yaba" });
    await client.acceptJob(p.id, "driver");
    await client.work(p.id);

    const actor = await client.actor(p.id);
    expect(actor.name).toBe("Watched");
    expect(actor.wallet.balance).toBeGreaterThan(0);

    await client.talk(p.id, "mama");
    const npc = await client.actor("mama");
    expect(npc.id).toBe("mama");
    expect(npc.relationships).toBeDefined();

    const ghost = await fetch(`${baseUrl}/v1/games/control/actors/ghost`, { headers });
    expect(ghost.status).toBe(404);
  });

  it("serves the inspector UI", async () => {
    const html = await (await fetch(`${baseUrl}/dashboard`)).text();
    expect(html).toContain("Inspector");
    expect(html).toContain("inspectId");
    expect(html).toContain("pauseBtn");
  });
});
