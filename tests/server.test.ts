import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { GameRegistry } from "../server/registry.js";
import { createHttpServer } from "../server/http.js";
import { SimClient } from "../src/index.js";

describe("API server", () => {
  let server: Server;
  let registry: GameRegistry;
  let baseUrl: string;
  const apiKey = "test-key";

  beforeAll(async () => {
    registry = new GameRegistry(null); // no disk persistence in tests
    await registry.init();
    await registry.create({
      gameId: "test-lagos",
      currency: "NGN",
      seed: 123,
      locations: [{ id: "yaba", travelCost: 500, travelTimeMinutes: 30 }],
      jobs: [{ id: "danfo-driver", salary: 150000, workingHours: 8 }],
      events: [{ id: "fuel-crisis", probability: 0 }],
    });
    registry.catalog.define("test-lagos", { version: "v1" });
    registry.catalog.define("test-lagos", {
      version: "v2",
      jobs: [{ id: "danfo-driver", salary: 300000, workingHours: 8 }],
    });
    server = createHttpServer(registry, { apiKeys: new Set([apiKey]), required: true });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 8787;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("rejects missing API key, serves full game loop with key", async () => {
    const anon = await fetch(`${baseUrl}/v1/games`);
    expect(anon.status).toBe(401);

    const client = new SimClient({ baseUrl, apiKey, gameId: "test-lagos" });
    const player = await client.createPlayer({ name: "Api Musa", location: "yaba" });
    expect(player.name).toBe("Api Musa");

    await client.acceptJob(player.id, "danfo-driver");
    const afterWork = await client.work(player.id);
    expect(afterWork.wallet.balance).toBeGreaterThan(player.wallet.balance);

    await client.travel(afterWork.id, "yaba").catch(() => {}); // same location = no-op
    await client.sleep(afterWork.id);
    const advanced = await client.advance(7);
    expect(advanced.day).toBeGreaterThan(1);

    await client.console.giveAll(5000);
    const stats = (await client.stats()) as { totalCurrency: number };
    expect(stats.totalCurrency).toBeGreaterThan(0);

    const log = await client.log(10);
    expect(log.log.length).toBeGreaterThan(0);
  });

  it("dashboard serves HTML", async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("simkit console");
  });

  it("play serves the reference game", async () => {
    const res = await fetch(`${baseUrl}/play`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Lagos Life Mini");
  });

  it("packs install over HTTP and usage reflects plan", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const packs = await (await fetch(`${baseUrl}/v1/packs?kind=world`, { headers })).json();
    expect(packs.packs.map((p: { id: string }) => p.id)).toContain("world-lagos");

    const install = await fetch(`${baseUrl}/v1/games/test-lagos/packs/system-nysc/install`, {
      method: "POST",
      headers,
    });
    expect(install.status).toBe(200);

    const info = await (await fetch(`${baseUrl}/v1/games/test-lagos`, { headers })).json();
    expect(info.jobs.map((j: { id: string }) => j.id)).toContain("corper");

    const usage = await (await fetch(`${baseUrl}/v1/games/test-lagos/usage`, { headers })).json();
    expect(usage.plan).toBe("free");
    expect(usage.usage.apiCalls).toBeGreaterThan(0);

    const plan = await (
      await fetch(`${baseUrl}/v1/games/test-lagos/plan`, {
        method: "POST",
        headers,
        body: JSON.stringify({ tier: "developer" }),
      })
    ).json();
    expect(plan.plan).toBe("developer");
  });

  it("social + economy endpoints: talk, items, transfer, business, missions", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const post = (path: string, body?: unknown) =>
      fetch(`${baseUrl}${path}`, { method: "POST", headers, body: body ? JSON.stringify(body) : undefined });
    const client = new SimClient({ baseUrl, apiKey, gameId: "test-lagos" });

    await post("/v1/games/test-lagos/packs/characters-lagos/install");
    const a = await client.createPlayer({ name: "Ada", location: "yaba" });
    const b = await client.createPlayer({ name: "Bola", location: "yaba" });

    const talk = await (await post(`/v1/games/test-lagos/players/${a.id}/talk`, { npcId: "mama-put" })).json();
    expect(talk.score).toBe(6);
    expect(typeof talk.line).toBe("string");

    const withAmala = await client.buy(a.id, "amala", 1);
    expect(withAmala.inventory.items.amala).toBe(1);

    const moved = await client.transfer(a.id, b.id, 1000);
    expect(moved.from.wallet.balance).toBe(a.wallet.balance - 1000 - 1500);
    expect(moved.to.wallet.balance).toBe(50000 + 1000);

    await post("/v1/games/test-lagos/businesses", { id: "kiosk", cost: 5000, dailyIncome: 500 });
    await client.buyBusiness(a.id, "kiosk");
    await client.advance(2);
    const { payout } = await client.collectIncome(a.id, "kiosk");
    expect(payout).toBe(1000);

    await post("/v1/games/test-lagos/missions", {
      id: "daily-grind",
      goal: { type: "earn", target: 5000 },
      reward: 500,
    });
    await client.acceptMission(a.id, "daily-grind");
    await client.acceptJob(a.id, "danfo-driver");
    await client.work(a.id);
    const claimed = await client.claimMission(a.id, "daily-grind");
    expect(claimed.reward).toBe(500);
  });

  it("world migration endpoint bumps rules safely", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const bad = await fetch(`${baseUrl}/v1/games/test-lagos/migrate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ target: "v9" }),
    });
    expect(bad.status).toBe(404);

    const res = await fetch(`${baseUrl}/v1/games/test-lagos/migrate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ target: "v2" }),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result).toMatchObject({ from: "v1", to: "v2", worldVersion: "v2" });

    const info = await (await fetch(`${baseUrl}/v1/games/test-lagos`, { headers })).json();
    expect(info.worldVersion).toBe("v2");
    expect(info.jobs.find((j: { id: string }) => j.id === "danfo-driver").salary).toBe(300000);
  });
});
