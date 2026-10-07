import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { GameRegistry } from "../server/registry.js";
import { createHttpServer } from "../server/http.js";
import { SimClient } from "../src/index.js";

describe("API server", () => {
  let server: Server;
  let baseUrl: string;
  const apiKey = "test-key";

  beforeAll(async () => {
    const registry = new GameRegistry(null); // no disk persistence in tests
    await registry.init();
    await registry.create({
      gameId: "test-lagos",
      currency: "NGN",
      seed: 123,
      locations: [{ id: "yaba", travelCost: 500, travelTimeMinutes: 30 }],
      jobs: [{ id: "danfo-driver", salary: 150000, workingHours: 8 }],
      events: [{ id: "fuel-crisis", probability: 0 }],
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
});
