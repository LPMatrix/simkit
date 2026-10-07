import type { PlayerJSON } from "./player.js";

/**
 * Remote SDK: same ergonomic surface as local `Sim`, backed by the HTTP API.
 * Local-first for tests/offline (`new Sim(...)`), remote for hosted games.
 *
 * ```ts
 * const client = new SimClient({ baseUrl: "http://localhost:8787", apiKey: "simkit-dev", gameId: "lagos-life" });
 * const player = await client.createPlayer({ name: "Mubaraq" });
 * await client.work(player.id);
 * ```
 */
export interface SimClientOptions {
  baseUrl: string;
  apiKey?: string;
  gameId: string;
}

export interface RemotePlayer extends PlayerJSON {}

export class SimClient {
  baseUrl: string;
  apiKey: string;
  gameId: string;

  constructor(opts: SimClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? "simkit-dev";
    this.gameId = opts.gameId;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        ...(init.headers ?? {}),
      },
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data as T;
  }

  stats(): Promise<Record<string, unknown>> {
    return this.req(`/v1/games/${this.gameId}/stats`);
  }

  info(): Promise<Record<string, unknown>> {
    return this.req(`/v1/games/${this.gameId}`);
  }

  async createPlayer(opts: { name: string; location?: string; startingCash?: number }): Promise<RemotePlayer> {
    return this.req<RemotePlayer>(`/v1/games/${this.gameId}/players`, {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }

  listPlayers(): Promise<{ players: RemotePlayer[] }> {
    return this.req(`/v1/games/${this.gameId}/players`);
  }

  getPlayer(id: string): Promise<RemotePlayer> {
    return this.req(`/v1/games/${this.gameId}/players/${id}`);
  }

  private async action(playerId: string, action: string, params: Record<string, unknown> = {}): Promise<{ player: RemotePlayer; result?: unknown }> {
    return this.req(`/v1/games/${this.gameId}/players/${playerId}/actions`, {
      method: "POST",
      body: JSON.stringify({ action, ...params }),
    });
  }

  work(playerId: string): Promise<RemotePlayer> {
    return this.action(playerId, "work").then((r) => r.player);
  }

  travel(playerId: string, to: string): Promise<RemotePlayer> {
    return this.action(playerId, "travel", { to }).then((r) => r.player);
  }

  sleep(playerId: string, hours = 8): Promise<RemotePlayer> {
    return this.action(playerId, "sleep", { hours }).then((r) => r.player);
  }

  eat(playerId: string, cost = 1500): Promise<RemotePlayer> {
    return this.action(playerId, "eat", { cost }).then((r) => r.player);
  }

  acceptJob(playerId: string, jobId: string): Promise<RemotePlayer> {
    return this.action(playerId, "accept-job", { jobId }).then((r) => r.player);
  }

  advance(days = 1): Promise<{ day: number; fired: string[] }> {
    return this.req(`/v1/games/${this.gameId}/advance`, {
      method: "POST",
      body: JSON.stringify({ days }),
    });
  }

  log(limit = 100): Promise<{ log: { type: string; day: number; time: string; playerId?: string }[] }> {
    return this.req(`/v1/games/${this.gameId}/log?limit=${limit}`);
  }

  console = {
    giveAll: (amount = 10000): Promise<unknown> =>
      this.req(`/v1/games/${this.gameId}/console/give-all`, {
        method: "POST",
        body: JSON.stringify({ amount }),
      }),
    trigger: (eventId: string): Promise<unknown> =>
      this.req(`/v1/games/${this.gameId}/console/trigger`, {
        method: "POST",
        body: JSON.stringify({ eventId }),
      }),
    setPrice: (key: string, multiplier: number): Promise<unknown> =>
      this.req(`/v1/games/${this.gameId}/console/set-price`, {
        method: "POST",
        body: JSON.stringify({ key, multiplier }),
      }),
    resetEconomy: (): Promise<unknown> =>
      this.req(`/v1/games/${this.gameId}/console/reset-economy`, { method: "POST" }),
  };
}
