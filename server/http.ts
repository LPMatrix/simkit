import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameRegistry } from "./registry.js";
import { isAuthorized, type AuthConfig } from "./auth.js";
import { installPack, listPacks, parseGameConfig, LEADERBOARD_METRICS, type LeaderboardMetric } from "../src/index.js";

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL, body: unknown) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path
        .split("/")
        .map((part) => {
          if (part.startsWith(":")) {
            keys.push(part.slice(1));
            return "([^/]+)";
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/") +
      "/?$",
  );
  return { method, pattern, keys, handler };
}

function send(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "access-control-allow-origin": "*",
  });
  res.end(html);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") return null;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON body") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (body == null) return {};
  if (typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  throw Object.assign(new Error("JSON object body required"), { status: 400 });
}

function errStatus(err: unknown): number {
  if (err != null && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  if (err instanceof Error && /Unknown (game|player|actor|location|job|event|item|action|npc|NPC|business|mission|trade|pack|schedule)/.test(err.message)) return 404;
  if (err instanceof Error && /already exists|does not meet|Insufficient|Too tired|has no job/i.test(err.message)) return 400;
  return 500;
}

const here = dirname(fileURLToPath(import.meta.url));

export function createHttpServer(registry: GameRegistry, auth: AuthConfig): Server {
  // SSE subscribers per game.
  const streams = new Map<string, Set<ServerResponse>>();

  const broadcast = (gameId: string, event: unknown): void => {
    const subs = streams.get(gameId);
    if (!subs || subs.size === 0) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of [...subs]) {
      try {
        res.write(payload);
      } catch {
        subs.delete(res);
      }
    }
  };

  // Attach broadcast to every game lazily (subscribe once per game).
  const subscribed = new Set<string>();
  const ensureSubscribed = (gameId: string): void => {
    if (subscribed.has(gameId)) return;
    subscribed.add(gameId);
    try {
      const sim = registry.get(gameId);
      sim.on("*", (e) => broadcast(gameId, e));
    } catch {
      // Game may not exist yet; will subscribe on next request.
      subscribed.delete(gameId);
    }
  };

  const routes: Route[] = [
    route("GET", "/health", (_req, res) => send(res, 200, { ok: true })),

    route("GET", "/v1/games", (_req, res) => {
      send(res, 200, {
        games: registry.list().map((s) => ({
          gameId: s.gameId,
          currency: s.currency,
          day: s.clock.day,
          time: s.clock.timeLabel,
          ...s.stats(),
        })),
      });
    }),

    route("POST", "/v1/games", async (_req, res, _p, _url, body) => {
      const b = asObject(body);
      if (!b.gameId || typeof b.gameId !== "string") {
        return send(res, 400, { error: "gameId (string) is required" });
      }
      const sim = await registry.create({
        gameId: b.gameId,
        currency: typeof b.currency === "string" ? b.currency : "NGN",
        seed: (b.seed as number | string | undefined) ?? Date.now(),
        startingCash: typeof b.startingCash === "number" ? b.startingCash : undefined,
        locations: b.locations as never,
        jobs: b.jobs as never,
        events: (b.events as never) ?? [],
      });
      ensureSubscribed(sim.gameId);
      send(res, 201, { gameId: sim.gameId, currency: sim.currency });
    }),

    route("POST", "/v1/games/from-config", async (_req, res, _p, _url, body) => {
      const b = asObject(body);
      if (typeof b.text !== "string") return send(res, 400, { error: "text (YAML/JSON config) required" });
      let cfg;
      try {
        cfg = parseGameConfig(b.text);
      } catch (err) {
        return send(res, 400, { error: (err as Error).message });
      }
      const sim = await registry.createFromConfig(cfg);
      ensureSubscribed(sim.gameId);
      send(res, 201, { gameId: sim.gameId, currency: sim.currency });
    }),

    route("GET", "/v1/games/:gameId", (_req, res, p) => {
      const sim = registry.get(p.gameId);
      ensureSubscribed(p.gameId);
      send(res, 200, {
        gameId: sim.gameId,
        currency: sim.currency,
        worldVersion: sim.worldVersion,
        paused: sim.paused,
        versions: registry.catalog.list(p.gameId),
        plan: registry.meter.plan(p.gameId),
        clock: { day: sim.clock.day, weekday: sim.clock.weekday, time: sim.clock.timeLabel },
        world: sim.world.list(),
        jobs: sim.jobs.list(),
        events: sim.events.list(),
        npcs: sim.npcs.list(),
        items: sim.items.list(),
        businesses: sim.businesses.list(),
        missions: sim.missions.list(),
        priceModifiers: sim.priceModifiers,
        stats: sim.stats(),
      });
    }),

    route("GET", "/v1/games/:gameId/stats", (_req, res, p) => {
      send(res, 200, registry.get(p.gameId).stats());
    }),

    route("GET", "/v1/games/:gameId/analytics", (_req, res, p) => {
      send(res, 200, registry.get(p.gameId).analytics());
    }),

    route("GET", "/v1/games/:gameId/economy", (_req, res, p) => {
      send(res, 200, registry.get(p.gameId).economics());
    }),

    route("GET", "/v1/games/:gameId/activation", (_req, res, p) => {
      send(res, 200, registry.get(p.gameId).activation());
    }),

    route("GET", "/v1/games/:gameId/leaderboards", (_req, res, p, url) => {
      const metric = (url.searchParams.get("metric") ?? "wealth") as LeaderboardMetric;
      if (!LEADERBOARD_METRICS.includes(metric)) {
        return send(res, 400, { error: `metric must be one of: ${LEADERBOARD_METRICS.join("|")}` });
      }
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 10)));
      send(res, 200, { metric, entries: registry.get(p.gameId).leaderboard(metric, limit) });
    }),

    route("GET", "/v1/games/:gameId/players/:playerId/rank", (_req, res, p, url) => {
      const sim = registry.get(p.gameId);
      sim.players.get(p.playerId); // 404 on unknown player
      const metric = (url.searchParams.get("metric") ?? "wealth") as LeaderboardMetric;
      if (!LEADERBOARD_METRICS.includes(metric)) {
        return send(res, 400, { error: `metric must be one of: ${LEADERBOARD_METRICS.join("|")}` });
      }
      send(res, 200, { metric, ...sim.rankOf(p.playerId, metric) });
    }),

    route("GET", "/v1/packs", (_req, res, _p, url) => {
      const kind = url.searchParams.get("kind");
      send(res, 200, {
        packs: listPacks(
          kind === "world" || kind === "jobs" || kind === "system" || kind === "characters" || kind === "assets" ? kind : undefined,
        ),
      });
    }),

    route("POST", "/v1/games/:gameId/packs/:packId/install", async (_req, res, p) => {
      const sim = registry.get(p.gameId);
      const pack = installPack(sim, p.packId);
      registry.schedulePersist(p.gameId);
      send(res, 200, { ok: true, pack: { id: pack.id, name: pack.name, kind: pack.kind } });
    }),

    route("GET", "/v1/games/:gameId/usage", (_req, res, p) => {
      const sim = registry.get(p.gameId);
      send(res, 200, registry.meter.report(p.gameId, sim.players.list().length));
    }),

    route("POST", "/v1/games/:gameId/plan", async (_req, res, p, _url, body) => {
      registry.get(p.gameId);
      const b = asObject(body);
      if (b.tier !== "free" && b.tier !== "developer" && b.tier !== "pro" && b.tier !== "enterprise") {
        return send(res, 400, { error: "tier must be free|developer|pro|enterprise" });
      }
      const tier = registry.meter.setPlan(p.gameId, b.tier);
      send(res, 200, { ok: true, plan: tier });
    }),

    route("GET", "/v1/games/:gameId/versions", (_req, res, p) => {
      const sim = registry.get(p.gameId);
      send(res, 200, { current: sim.worldVersion, versions: registry.catalog.list(p.gameId) });
    }),

    route("POST", "/v1/games/:gameId/migrate", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const b = asObject(body);
      if (typeof b.target !== "string") return send(res, 400, { error: "target (version) required" });
      const result = registry.catalog.migrate(sim, b.target);
      registry.schedulePersist(p.gameId);
      send(res, 200, { ok: true, ...result, worldVersion: sim.worldVersion });
    }),

    route("POST", "/v1/games/:gameId/players", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      registry.meter.checkPlayerCap(p.gameId, sim.players.list().length);
      const b = asObject(body);
      if (!b.name || typeof b.name !== "string") return send(res, 400, { error: "name is required" });
      const player = await sim.players.create({
        name: b.name,
        location: typeof b.location === "string" ? b.location : undefined,
        startingCash: typeof b.startingCash === "number" ? b.startingCash : undefined,
      });
      registry.schedulePersist(p.gameId);
      send(res, 201, player.toJSON());
    }),

    route("GET", "/v1/games/:gameId/players", async (_req, res, p) => {
      const sim = registry.get(p.gameId);
      send(res, 200, { players: sim.players.list().map((pl) => pl.toJSON()) });
    }),

    route("GET", "/v1/games/:gameId/players/:playerId", (_req, res, p) => {
      send(res, 200, registry.get(p.gameId).players.get(p.playerId).toJSON());
    }),

    route("GET", "/v1/games/:gameId/actors/:actorId", (_req, res, p) => {
      send(res, 200, registry.get(p.gameId).actorOf(p.actorId).toJSON());
    }),

    // Generic action endpoint: { action, ...params }
    route("POST", "/v1/games/:gameId/players/:playerId/actions", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      // Any actor: an account-holding player, or an NPC acting on its own.
      const actor = sim.actorOf(p.playerId); // 404 on unknown actor
      const { action: rawAction, ...inputs } = asObject(body);
      if (typeof rawAction !== "string" || !rawAction) {
        return send(res, 400, { error: "action (string) is required" });
      }
      // Legacy camelCase aliases map onto the registered action ids.
      const aliases: Record<string, string> = { acceptJob: "accept-job", quitJob: "quit-job" };
      const actionId = aliases[rawAction] ?? rawAction;
      const value = sim.execute(p.playerId, actionId, inputs);
      const result = actionId === "work" ? { pay: value } : (value ?? null);
      // NPC actors persist through snapshots, not player accounts.
      if (sim.isPlayer(p.playerId)) await sim.players.save(p.playerId).catch(() => {});
      registry.schedulePersist(p.gameId);
      send(res, 200, { player: actor.toJSON(), result });
    }),

    route("POST", "/v1/games/:gameId/advance", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const b = asObject(body);
      const days = typeof b.days === "number" ? Math.max(1, Math.min(30, Math.floor(b.days))) : 1;
      const before = sim.eventLog.length;
      const fired = sim.advanceDays(days);
      // Metering is post-hoc: exact event counts are random, so the advance
      // stands and an exceeded quota surfaces as 429 + overage in /usage.
      registry.meter.recordEvents(p.gameId, sim.eventLog.length - before);
      registry.schedulePersist(p.gameId);
      send(res, 200, { day: sim.clock.day, time: sim.clock.timeLabel, fired });
    }),

    route("POST", "/v1/games/:gameId/entities", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const entity = sim.entities.define(asObject(body) as never);
      registry.schedulePersist(p.gameId);
      send(res, 201, entity);
    }),

    route("GET", "/v1/games/:gameId/entities", (_req, res, p, url) => {
      const kind = url.searchParams.get("kind") ?? undefined;
      const employerId = url.searchParams.get("employerId") ?? undefined;
      let entities = registry.get(p.gameId).entities.list(kind);
      if (employerId) {
        entities = entities.filter((e) => e.kind === "employee" && e.attributes.employerId === employerId);
      }
      send(res, 200, { entities });
    }),

    route("GET", "/v1/games/:gameId/actions", (_req, res, p) => {
      send(res, 200, { actions: registry.get(p.gameId).listActions() });
    }),

    route("GET", "/v1/games/:gameId/systems", (_req, res, p) => {
      send(res, 200, { systems: registry.get(p.gameId).systems() });
    }),

    route("GET", "/v1/games/:gameId/replay", (_req, res, p, url) => {
      const sim = registry.get(p.gameId);
      const num = (k: string): number | undefined => {
        const v = url.searchParams.get(k);
        return v == null || v === "" ? undefined : Number(v);
      };
      const actorId = url.searchParams.get("actorId") ?? undefined;
      send(res, 200, { trace: sim.replay({ actorId, fromDay: num("fromDay"), toDay: num("toDay") }) });
    }),

    route("GET", "/v1/games/:gameId/players/:playerId/explain", (_req, res, p, url) => {
      const sim = registry.get(p.gameId);
      const num = (k: string): number | undefined => {
        const v = url.searchParams.get(k);
        return v == null || v === "" ? undefined : Number(v);
      };
      send(res, 200, sim.explain(p.playerId, { fromDay: num("fromDay"), toDay: num("toDay") }));
    }),

    route("GET", "/v1/games/:gameId/graph", (_req, res, p, url) => {
      const sim = registry.get(p.gameId);
      const num = (k: string): number | undefined => {
        const v = url.searchParams.get(k);
        return v == null || v === "" ? undefined : Number(v);
      };
      const actorId = url.searchParams.get("actorId") ?? undefined;
      send(res, 200, sim.replayGraph({ actorId, fromDay: num("fromDay"), toDay: num("toDay") }));
    }),

    route("GET", "/v1/games/:gameId/log", (_req, res, p, url) => {
      const sim = registry.get(p.gameId);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
      const log = sim.eventLog.slice(-limit);
      send(res, 200, { log });
    }),

    route("POST", "/v1/games/:gameId/npcs", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const npc = sim.npcs.define(asObject(body) as never);
      registry.schedulePersist(p.gameId);
      send(res, 201, npc);
    }),

    route("POST", "/v1/games/:gameId/items", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const item = sim.items.define(asObject(body) as never);
      registry.schedulePersist(p.gameId);
      send(res, 201, item);
    }),

    route("POST", "/v1/games/:gameId/businesses", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const biz = sim.businesses.define(asObject(body) as never);
      registry.schedulePersist(p.gameId);
      send(res, 201, biz);
    }),

    route("POST", "/v1/games/:gameId/missions", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const mission = sim.missions.define(asObject(body) as never);
      registry.schedulePersist(p.gameId);
      send(res, 201, mission);
    }),

    route("POST", "/v1/games/:gameId/players/:playerId/talk", async (_req, res, p, _url, body) => {      const sim = registry.get(p.gameId);
      const b = asObject(body);
      if (typeof b.npcId !== "string") return send(res, 400, { error: "npcId required" });
      const result = sim.talk(p.playerId, b.npcId);
      registry.schedulePersist(p.gameId);
      send(res, 200, { ...result, player: sim.players.get(p.playerId).toJSON() });
    }),

    route("GET", "/v1/games/:gameId/items", (_req, res, p) => {
      send(res, 200, { items: registry.get(p.gameId).items.list() });
    }),

    route("POST", "/v1/games/:gameId/players/:playerId/buy", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const player = sim.players.get(p.playerId);
      const b = asObject(body);
      if (typeof b.itemId !== "string") return send(res, 400, { error: "itemId required" });
      player.buy(b.itemId, typeof b.qty === "number" ? b.qty : 1);
      registry.schedulePersist(p.gameId);
      send(res, 200, { player: player.toJSON() });
    }),

    route("POST", "/v1/games/:gameId/players/:playerId/use", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const player = sim.players.get(p.playerId);
      const b = asObject(body);
      if (typeof b.itemId !== "string") return send(res, 400, { error: "itemId required" });
      player.use(b.itemId);
      registry.schedulePersist(p.gameId);
      send(res, 200, { player: player.toJSON() });
    }),

    route("POST", "/v1/games/:gameId/players/:playerId/sell", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const player = sim.players.get(p.playerId);
      const b = asObject(body);
      if (typeof b.itemId !== "string") return send(res, 400, { error: "itemId required" });
      const gain = player.sell(b.itemId, typeof b.qty === "number" ? b.qty : 1);
      registry.schedulePersist(p.gameId);
      send(res, 200, { player: player.toJSON(), gain });
    }),

    route("POST", "/v1/games/:gameId/players/:playerId/transfer", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const b = asObject(body);
      if (typeof b.to !== "string" || typeof b.amount !== "number") {
        return send(res, 400, { error: "to (player id) and amount (number) required" });
      }
      sim.transfer(p.playerId, b.to, b.amount, typeof b.reason === "string" ? b.reason : "transfer");
      registry.schedulePersist(p.gameId);
      send(res, 200, {
        from: sim.players.get(p.playerId).toJSON(),
        to: sim.players.get(b.to).toJSON(),
      });
    }),

    route("GET", "/v1/games/:gameId/businesses", (_req, res, p) => {
      send(res, 200, { businesses: registry.get(p.gameId).businesses.list() });
    }),

    route("POST", "/v1/games/:gameId/players/:playerId/businesses/:businessId/buy", async (_req, res, p) => {
      const sim = registry.get(p.gameId);
      sim.buyBusiness(p.playerId, p.businessId);
      registry.schedulePersist(p.gameId);
      send(res, 200, { player: sim.players.get(p.playerId).toJSON() });
    }),

    route("POST", "/v1/games/:gameId/players/:playerId/businesses/:businessId/collect", async (_req, res, p) => {
      const sim = registry.get(p.gameId);
      const payout = sim.collectIncome(p.playerId, p.businessId);
      registry.schedulePersist(p.gameId);
      send(res, 200, { payout, player: sim.players.get(p.playerId).toJSON() });
    }),

    route("GET", "/v1/games/:gameId/players/:playerId/missions", (_req, res, p) => {
      const sim = registry.get(p.gameId);
      const player = sim.players.get(p.playerId);
      send(res, 200, {
        missions: sim.missions.list().map((m) => ({
          ...m,
          state: player.missions[m.id] ?? { accepted: false, claimed: false },
          progress: sim.missionProgress(p.playerId, m.id),
        })),
      });
    }),

    route("POST", "/v1/games/:gameId/players/:playerId/missions/:missionId/accept", async (_req, res, p) => {
      const sim = registry.get(p.gameId);
      sim.acceptMission(p.playerId, p.missionId);
      registry.schedulePersist(p.gameId);
      send(res, 200, { ok: true });
    }),

    route("POST", "/v1/games/:gameId/players/:playerId/missions/:missionId/claim", async (_req, res, p) => {
      const sim = registry.get(p.gameId);
      const reward = sim.claimMission(p.playerId, p.missionId);
      registry.schedulePersist(p.gameId);
      send(res, 200, { reward, player: sim.players.get(p.playerId).toJSON() });
    }),

    route("GET", "/v1/games/:gameId/schedules", (_req, res, p) => {
      send(res, 200, { schedules: registry.get(p.gameId).schedules.list() });
    }),

    route("POST", "/v1/games/:gameId/schedules", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const schedule = sim.schedules.define(asObject(body) as never, sim.clock.day);
      registry.schedulePersist(p.gameId);
      send(res, 201, schedule);
    }),

    route("POST", "/v1/games/:gameId/schedules/:scheduleId/cancel", async (_req, res, p) => {
      const sim = registry.get(p.gameId);
      const schedule = sim.schedules.cancel(p.scheduleId);
      registry.schedulePersist(p.gameId);
      send(res, 200, schedule);
    }),

    route("GET", "/v1/games/:gameId/trades", (_req, res, p, url) => {
      const sim = registry.get(p.gameId);
      send(res, 200, { trades: sim.listTrades(url.searchParams.get("playerId") ?? undefined) });
    }),

    route("POST", "/v1/games/:gameId/trades", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const b = asObject(body);
      if (typeof b.from !== "string" || typeof b.to !== "string") {
        return send(res, 400, { error: "from and to (player ids) required" });
      }
      const offer = sim.offerTrade(b.from, b.to, {
        offerCash: typeof b.offerCash === "number" ? b.offerCash : 0,
        offerItems: b.offerItems as Record<string, number> | undefined,
        askCash: typeof b.askCash === "number" ? b.askCash : 0,
        askItems: b.askItems as Record<string, number> | undefined,
      });
      registry.schedulePersist(p.gameId);
      send(res, 201, offer);
    }),

    route("POST", "/v1/games/:gameId/trades/:tradeId/accept", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const b = asObject(body);
      if (typeof b.by !== "string") return send(res, 400, { error: "by (accepting player id) required" });
      const offer = sim.acceptTrade(p.tradeId, b.by);
      registry.schedulePersist(p.gameId);
      send(res, 200, offer);
    }),

    route("POST", "/v1/games/:gameId/trades/:tradeId/decline", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const b = asObject(body);
      if (typeof b.by !== "string") return send(res, 400, { error: "by (player id) required" });
      const offer = sim.declineTrade(p.tradeId, b.by);
      registry.schedulePersist(p.gameId);
      send(res, 200, offer);
    }),

    route("POST", "/v1/games/:gameId/trades/:tradeId/cancel", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const b = asObject(body);
      if (typeof b.by !== "string") return send(res, 400, { error: "by (player id) required" });
      const offer = sim.cancelTrade(p.tradeId, b.by);
      registry.schedulePersist(p.gameId);
      send(res, 200, offer);
    }),

    route("POST", "/v1/games/:gameId/console/give-all", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const b = asObject(body);
      const amount = typeof b.amount === "number" ? b.amount : 10000;
      sim.console.giveAll(amount, typeof b.reason === "string" ? b.reason : "console:give");
      registry.schedulePersist(p.gameId);
      send(res, 200, { ok: true, stats: sim.stats() });
    }),

    route("POST", "/v1/games/:gameId/console/set-price", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const b = asObject(body);
      if (typeof b.key !== "string" || typeof b.multiplier !== "number") {
        return send(res, 400, { error: "key (string) and multiplier (number) required" });
      }
      sim.console.setPrice(b.key, b.multiplier);
      registry.schedulePersist(p.gameId);
      send(res, 200, { ok: true, priceModifiers: sim.priceModifiers });
    }),

    route("POST", "/v1/games/:gameId/console/trigger", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const b = asObject(body);
      if (typeof b.eventId !== "string") return send(res, 400, { error: "eventId required" });
      sim.triggerEvent(b.eventId);
      registry.schedulePersist(p.gameId);
      send(res, 200, { ok: true });
    }),

    route("POST", "/v1/games/:gameId/console/reset-economy", async (_req, res, p) => {
      const sim = registry.get(p.gameId);
      sim.console.resetEconomy();
      registry.schedulePersist(p.gameId);
      send(res, 200, { ok: true });
    }),

    route("POST", "/v1/games/:gameId/pause", async (_req, res, p) => {
      const sim = registry.get(p.gameId);
      sim.pause();
      registry.schedulePersist(p.gameId);
      send(res, 200, { paused: true });
    }),

    route("POST", "/v1/games/:gameId/resume", async (_req, res, p) => {
      const sim = registry.get(p.gameId);
      sim.resume();
      registry.schedulePersist(p.gameId);
      send(res, 200, { paused: false });
    }),

    route("GET", "/v1/games/:gameId/snapshot", (_req, res, p) => {
      send(res, 200, registry.get(p.gameId).snapshot());
    }),
  ];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;

      // CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,x-api-key,authorization",
        });
        res.end();
        return;
      }

      // Dashboard (no auth) + player game (no auth; API calls still need key)
      if (pathname === "/" || pathname === "/dashboard") {
        const html = await readFile(join(here, "dashboard.html"), "utf8").catch(() => fallbackDashboard());
        return sendHtml(res, html);
      }
      if (pathname === "/play") {
        const html = await readFile(join(here, "play.html"), "utf8").catch(() => fallbackDashboard());
        return sendHtml(res, html);
      }

      // SSE realtime stream (auth via query ?apiKey= for browser EventSource)
      if (pathname.startsWith("/v1/games/") && pathname.endsWith("/stream") && req.method === "GET") {
        const parts = pathname.split("/");
        const gameId = parts[3];
        const qKey = url.searchParams.get("apiKey");
        const headerKey = req.headers["x-api-key"];
        const bearer = (req.headers.authorization ?? "").startsWith("Bearer ")
          ? (req.headers.authorization as string).slice(7)
          : null;
        const key = (headerKey as string) ?? bearer ?? qKey;
        if (auth.required && (!key || !auth.apiKeys.has(key))) {
          return send(res, 401, { error: "Missing or invalid API key" });
        }
        try {
          registry.get(gameId);
        } catch {
          return send(res, 404, { error: `Unknown game: ${gameId}` });
        }
        ensureSubscribed(gameId);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });
        res.write(`: connected to ${gameId}\n\n`);
        let set = streams.get(gameId);
        if (!set) {
          set = new Set();
          streams.set(gameId, set);
        }
        set.add(res);
        req.on("close", () => set?.delete(res));
        return;
      }

      // Auth for /v1/*
      if (pathname.startsWith("/v1/")) {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers.set(k, v);
        }
        const fakeReq = new Request("http://localhost/", { headers });
        if (!isAuthorized(fakeReq, auth)) {
          return send(res, 401, { error: "Missing or invalid API key. Send x-api-key header." });
        }
      }

      const body = await readBody(req);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1]);
        });
        if (params.gameId) registry.meter.recordApi(params.gameId);
        // Paused worlds reject mutation with 423; reads, pause, and resume pass through.
        if (
          params.gameId &&
          req.method !== "GET" &&
          !pathname.endsWith("/pause") &&
          !pathname.endsWith("/resume")
        ) {
          try {
            if (registry.get(params.gameId).paused) {
              return send(res, 423, { error: "World is paused for inspection. Resume to mutate." });
            }
          } catch {
            // Unknown game: fall through to normal routing (404).
          }
        }
        await r.handler(req, res, params, url, body);
        return;
      }
      send(res, 404, { error: `Not found: ${req.method} ${pathname}` });
    } catch (err) {
      send(res, errStatus(err), { error: (err as Error).message ?? "Internal error" });
    }
  });

  return server;
}

function fallbackDashboard(): string {
  return "<html><body><h1>simkit dashboard</h1><p>dashboard.html missing.</p></body></html>";
}
