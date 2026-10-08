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

  it("analytics endpoint reports series and retention", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const client = new SimClient({ baseUrl, apiKey, gameId: "test-lagos" });
    await client.advance(3);
    const a = await client.analytics();
    expect((a.series as unknown[]).length).toBeGreaterThanOrEqual(3);
    expect(a.retention as object).toMatchObject({ total: expect.any(Number) });
  });

  it("trade endpoints propose and settle swaps", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const post = (path: string, body?: unknown) =>
      fetch(`${baseUrl}${path}`, { method: "POST", headers, body: body ? JSON.stringify(body) : undefined });
    const client = new SimClient({ baseUrl, apiKey, gameId: "test-lagos" });
    const a = await client.createPlayer({ name: "TraderA", location: "yaba" });
    const b = await client.createPlayer({ name: "TraderB", location: "yaba" });

    const offer = await (await post("/v1/games/test-lagos/trades", {
      from: a.id, to: b.id, offerCash: 2000, askCash: 1000,
    })).json();
    expect(offer.status).toBe("pending");

    const listed = await (await fetch(`${baseUrl}/v1/games/test-lagos/trades?playerId=${b.id}`, { headers })).json();
    expect(listed.trades).toHaveLength(1);

    const done = await (await post(`/v1/games/test-lagos/trades/${offer.id}/accept`, { by: b.id })).json();
    expect(done.status).toBe("accepted");

    const afterA = await client.getPlayer(a.id);
    const afterB = await client.getPlayer(b.id);
    expect(afterA.wallet.balance).toBe(a.wallet.balance - 2000 + 1000);
    expect(afterB.wallet.balance).toBe(50000 - 1000 + 2000);
  });

  it("leaderboard, rank and economy endpoints", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const client = new SimClient({ baseUrl, apiKey, gameId: "test-lagos" });
    const p = await client.createPlayer({ name: "Champ", location: "yaba" });

    const board = await client.leaderboard("wealth", 5);
    expect(board.metric).toBe("wealth");
    expect(board.entries.length).toBeGreaterThan(0);
    expect(board.entries[0].rank).toBe(1);

    const rank = await client.rank(p.id, "wealth");
    expect(rank.total).toBeGreaterThanOrEqual(1);

    const bad = await fetch(`${baseUrl}/v1/games/test-lagos/leaderboards?metric=vibes`, { headers });
    expect(bad.status).toBe(400);

    const econ = await client.economy();
    expect(econ).toMatchObject({ inflationPct: expect.any(Number) });
    expect(Array.isArray(econ.topJobs)).toBe(true);
  });

  it("runtime endpoints: actions, replay, explain, refusal as 400", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const client = new SimClient({ baseUrl, apiKey, gameId: "test-lagos" });
    const p = await client.createPlayer({ name: "Runner", location: "yaba" });

    const actions = await (await fetch(`${baseUrl}/v1/games/test-lagos/actions`, { headers })).json();
    expect(actions.actions.map((a: { id: string }) => a.id)).toContain("work");

    const refused = await fetch(`${baseUrl}/v1/games/test-lagos/players/${p.id}/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "work" }),
    });
    expect(refused.status).toBe(400);

    await client.acceptJob(p.id, "danfo-driver");
    await client.work(p.id);

    const replay = await (await fetch(`${baseUrl}/v1/games/test-lagos/replay?actorId=${p.id}`, { headers })).json();
    expect(replay.trace.at(-1)).toMatchObject({ actionId: "work", outcome: "ok" });
    expect(replay.trace.at(-1).transactions.length).toBeGreaterThan(0);

    const explain = await (await fetch(`${baseUrl}/v1/games/test-lagos/players/${p.id}/explain`, { headers })).json();
    expect(explain.lines.map((l: { category: string }) => l.category)).toContain("salary");
  });

  it("generic action endpoint dispatches every registered action with 400/404 semantics", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const client = new SimClient({ baseUrl, apiKey, gameId: "test-lagos" });
    const p = await client.createPlayer({ name: "Dispatch", location: "yaba" });
    const act = (body: unknown) =>
      fetch(`${baseUrl}/v1/games/test-lagos/players/${p.id}/actions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

    const bought = await act({ action: "buy", itemId: "amala", qty: 1 });
    expect(bought.status).toBe(200);
    expect((await bought.json()).player.inventory.items.amala).toBeGreaterThanOrEqual(1);

    expect((await act({ action: "travel" })).status).toBe(400); // missing "to": request error
    expect((await act({ action: "buy", itemId: "ghost" })).status).toBe(404);
    expect((await act({ action: "teleport" })).status).toBe(404); // unknown action id
    expect((await act({ action: "use", itemId: "gala" })).status).toBe(400); // no stock: refusal
    expect((await act({})).status).toBe(400);
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

  it("creates games from config text and reports activation", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const yaml = "gameId: cfg-game\npacks: [world-ilorin]\njobs:\n  - id: rider\n    salary: 60000\n";
    const created = await fetch(`${baseUrl}/v1/games/from-config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: yaml }),
    });
    expect(created.status).toBe(201);

    const dupe = await fetch(`${baseUrl}/v1/games/from-config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: yaml }),
    });
    expect(dupe.status).toBe(409);

    const invalid = await fetch(`${baseUrl}/v1/games/from-config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "- just\n- a\n- list" }),
    });
    expect(invalid.status).toBe(400);

    const fresh = await (await fetch(`${baseUrl}/v1/games/cfg-game/activation`, { headers })).json();
    expect(fresh.playable).toBe(false);

    const client = new SimClient({ baseUrl, apiKey, gameId: "cfg-game" });
    const p = await client.createPlayer({ name: "Cfg" });
    await client.acceptJob(p.id, "rider");
    await client.work(p.id);
    const done = await client.activation();
    expect(done.playable).toBe(true);
  });

  it("defines schedules over HTTP and settles them on advance", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const client = new SimClient({ baseUrl, apiKey, gameId: "test-lagos" });
    const p = await client.createPlayer({ name: "Tenant", location: "yaba" });
    const start = p.wallet.balance;

    const created = await client.defineSchedule({
      id: "rent-http",
      payer: p.id,
      amount: 1000,
      everyDays: 1,
      reason: "rent",
    });
    expect(created).toMatchObject({ id: "rent-http", nextDue: expect.any(Number) });

    const listed = await client.listSchedules();
    expect(listed.schedules.map((s) => (s as { id: string }).id)).toContain("rent-http");

    await client.advance(1);
    expect((await client.getPlayer(p.id)).wallet.balance).toBe(start - 1000);

    const bad = await fetch(`${baseUrl}/v1/games/test-lagos/schedules`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "bad", payer: p.id, amount: -5, everyDays: 1 }),
    });
    expect(bad.status).toBe(400);

    await client.cancelSchedule("rent-http");
    await client.advance(2);
    expect((await client.getPlayer(p.id)).wallet.balance).toBe(start - 1000); // no further charges
  });
});
