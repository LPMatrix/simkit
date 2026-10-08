import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { ActionRefused, createSimulation, Sim, SimClient } from "../src/index.js";
import { GameRegistry } from "../server/registry.js";
import { createHttpServer } from "../server/http.js";

function town(): Sim {
  return createSimulation({
    gameId: "town",
    seed: 21,
    locations: [
      { id: "yaba", travelCost: 0, travelTimeMinutes: 10 },
      { id: "ikeja", travelCost: 0, travelTimeMinutes: 10 },
    ],
    jobs: [{ id: "driver", salary: 90000, workingHours: 8 }],
    npcs: [
      { id: "mama", name: "Mama", location: "yaba", dialogue: ["Eat!"] },
      { id: "tunde", name: "Tunde", location: "yaba", dialogue: ["Oya!"] },
    ],
  });
}

describe("NPC actors", () => {
  it("creates actor state lazily from the NPC definition", async () => {
    const sim = town();
    await sim.players.create({ name: "P" });
    expect(sim.isPlayer("mama")).toBe(false);

    sim.execute("mama", "travel", { to: "ikeja" });
    expect(sim.isPlayer("mama")).toBe(false);
    expect(sim.actorOf("mama").locationId).toBe("ikeja");
    expect(sim.actorOf("mama").name).toBe("Mama");
    // Separate from player accounts.
    expect(sim.players.list().map((p) => p.id)).toEqual(["player_1"]);
    expect(sim.stats().totalPlayers).toBe(1);
  });

  it("throws Unknown actor (404) for ids that are neither player nor NPC", async () => {
    const sim = town();
    await sim.players.create({ name: "P" });
    expect(() => sim.execute("ghost", "sleep")).toThrow(/Unknown actor: ghost/);
    try {
      sim.execute("ghost", "sleep");
    } catch (err) {
      expect((err as { status?: number }).status).toBeUndefined(); // core stays transport-agnostic
    }
    expect(sim.causalRecords()).toHaveLength(0); // failed resolution records nothing
  });

  it("records refusals and successes under the NPC's own id", async () => {
    const sim = town();
    await sim.players.create({ name: "P" });
    expect(() => sim.execute("mama", "work", {})).toThrow(ActionRefused); // no job
    sim.execute("mama", "sleep", { hours: 2 });
    const records = sim.causalRecords();
    expect(records.map((c) => [c.actionId, c.actorId, c.outcome])).toEqual([
      ["work", "mama", "refused"],
      ["sleep", "mama", "ok"],
    ]);
  });

  it("an NPC can hold a job and earn into its own wallet", async () => {
    const sim = town();
    await sim.players.create({ name: "P" });
    sim.execute("mama", "accept-job", { jobId: "driver" });
    const pay = sim.execute("mama", "work", {});
    expect(pay).toBe(3000); // 90000 / 30
    expect(sim.actorOf("mama").wallet.balance).toBe(3000);
    expect(sim.explain("mama").lines).toEqual([
      { category: "salary", credits: 3000, debits: 0, net: 3000 },
    ]);
  });

  it("an NPC can talk to another NPC, building its own relationship", async () => {
    const sim = town();
    await sim.players.create({ name: "P" });
    const result = sim.execute("mama", "talk", { npcId: "tunde" }) as {
      line: string;
      score: number;
      level: string;
    };
    expect(result.line).toBe("Oya!");
    expect(result.score).toBe(6);
    expect(sim.actorOf("mama").relationships.score("tunde")).toBe(6);
    expect(sim.actorOf("tunde").relationships.score("mama")).toBe(0); // target is passive
  });

  it("replay filters by NPC id like any actor", async () => {
    const sim = town();
    const p = await sim.players.create({ name: "P" });
    sim.execute("mama", "sleep", { hours: 1 });
    p.sleep(1);
    expect(sim.replay({ actorId: "mama" }).map((t) => t.actionId)).toEqual(["sleep"]);
    expect(sim.replay({ actorId: p.id }).map((t) => t.actionId)).toEqual(["sleep"]);
  });

  it("survives snapshot round-trips with hooks intact", async () => {
    const sim = town();
    await sim.players.create({ name: "P" });
    sim.execute("mama", "travel", { to: "ikeja" });
    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.actorOf("mama").locationId).toBe("ikeja");
    expect(restored.isPlayer("mama")).toBe(false);
    // Hooks are reattached: acting after restore works and links causes.
    restored.execute("mama", "sleep", { hours: 1 });
    expect(restored.causalRecords()).toHaveLength(2);
    expect(restored.replay({ actorId: "mama" })).toHaveLength(2);
  });
});

describe("NPC actors over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  const apiKey = "npc-key";

  beforeAll(async () => {
    const registry = new GameRegistry(null);
    await registry.init();
    await registry.create({
      gameId: "npctown",
      seed: 3,
      locations: [{ id: "yaba", travelCost: 0, travelTimeMinutes: 5 }],
    });
    const sim = registry.get("npctown");
    sim.npcs.define({ id: "mama", name: "Mama", location: "yaba", dialogue: ["Eat!"] });
    server = createHttpServer(registry, { apiKeys: new Set([apiKey]), required: true });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("an NPC acts through /actions and stays out of player listings", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const client = new SimClient({ baseUrl, apiKey, gameId: "npctown" });
    await client.createPlayer({ name: "P", location: "yaba" });

    const slept = await fetch(`${baseUrl}/v1/games/npctown/players/mama/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "sleep", hours: 2 }),
    });
    expect(slept.status).toBe(200);
    const body = await slept.json();
    expect(body.player.id).toBe("mama");

    const players = await client.listPlayers();
    expect(players.players.map((p) => p.id)).toEqual(["player_1"]);

    const ghost = await fetch(`${baseUrl}/v1/games/npctown/players/ghost/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "sleep" }),
    });
    expect(ghost.status).toBe(404);
    expect((await ghost.json()).error).toMatch(/Unknown actor/);
  });
});
