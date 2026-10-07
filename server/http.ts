import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameRegistry } from "./registry.js";
import { isAuthorized, type AuthConfig } from "./auth.js";

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
  if (err instanceof Error && /Unknown (game|player|location|job|event)/.test(err.message)) return 404;
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

    route("GET", "/v1/games/:gameId", (_req, res, p) => {
      const sim = registry.get(p.gameId);
      ensureSubscribed(p.gameId);
      send(res, 200, {
        gameId: sim.gameId,
        currency: sim.currency,
        clock: { day: sim.clock.day, weekday: sim.clock.weekday, time: sim.clock.timeLabel },
        world: sim.world.list(),
        jobs: sim.jobs.list(),
        events: sim.events.list(),
        priceModifiers: sim.priceModifiers,
        stats: sim.stats(),
      });
    }),

    route("GET", "/v1/games/:gameId/stats", (_req, res, p) => {
      send(res, 200, registry.get(p.gameId).stats());
    }),

    route("POST", "/v1/games/:gameId/players", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
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

    // Generic action endpoint: { action, ...params }
    route("POST", "/v1/games/:gameId/players/:playerId/actions", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const player = sim.players.get(p.playerId);
      const b = asObject(body);
      const action = b.action as string;
      let result: unknown = null;
      switch (action) {
        case "work":
          result = { pay: player.work() };
          break;
        case "travel":
          if (typeof b.to !== "string") return send(res, 400, { error: "to (location id) required" });
          player.travel(b.to);
          break;
        case "sleep":
          player.sleep(typeof b.hours === "number" ? b.hours : 8);
          break;
        case "eat":
          player.eat(
            typeof b.cost === "number" ? b.cost : 1500,
            typeof b.energyGain === "number" ? b.energyGain : 25,
          );
          break;
        case "accept-job":
        case "acceptJob":
          if (typeof b.jobId !== "string") return send(res, 400, { error: "jobId required" });
          player.acceptJob(b.jobId);
          break;
        case "quit-job":
        case "quitJob":
          player.quitJob();
          break;
        default:
          return send(res, 400, { error: `Unknown action: ${action}` });
      }
      await sim.players.save(player.id).catch(() => {});
      registry.schedulePersist(p.gameId);
      send(res, 200, { player: player.toJSON(), result });
    }),

    route("POST", "/v1/games/:gameId/advance", async (_req, res, p, _url, body) => {
      const sim = registry.get(p.gameId);
      const b = asObject(body);
      const days = typeof b.days === "number" ? Math.max(1, Math.min(30, Math.floor(b.days))) : 1;
      const fired = sim.advanceDays(days);
      registry.schedulePersist(p.gameId);
      send(res, 200, { day: sim.clock.day, time: sim.clock.timeLabel, fired });
    }),

    route("GET", "/v1/games/:gameId/log", (_req, res, p, url) => {
      const sim = registry.get(p.gameId);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
      const log = sim.eventLog.slice(-limit);
      send(res, 200, { log });
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

      // Dashboard (no auth) + static
      if (pathname === "/" || pathname === "/dashboard") {
        const html = await readFile(join(here, "dashboard.html"), "utf8").catch(() => fallbackDashboard());
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
