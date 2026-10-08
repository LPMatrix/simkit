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

  async talk(playerId: string, npcId: string): Promise<{ line: string; score: number; level: string; player: RemotePlayer }> {
    return this.req(`/v1/games/${this.gameId}/players/${playerId}/talk`, {
      method: "POST",
      body: JSON.stringify({ npcId }),
    });
  }

  async buy(playerId: string, itemId: string, qty = 1): Promise<RemotePlayer> {
    const r = await this.req<{ player: RemotePlayer }>(`/v1/games/${this.gameId}/players/${playerId}/buy`, {
      method: "POST",
      body: JSON.stringify({ itemId, qty }),
    });
    return r.player;
  }

  async use(playerId: string, itemId: string): Promise<RemotePlayer> {
    const r = await this.req<{ player: RemotePlayer }>(`/v1/games/${this.gameId}/players/${playerId}/use`, {
      method: "POST",
      body: JSON.stringify({ itemId }),
    });
    return r.player;
  }

  async transfer(fromId: string, to: string, amount: number): Promise<{ from: RemotePlayer; to: RemotePlayer }> {
    return this.req(`/v1/games/${this.gameId}/players/${fromId}/transfer`, {
      method: "POST",
      body: JSON.stringify({ to, amount }),
    });
  }

  async buyBusiness(playerId: string, businessId: string): Promise<RemotePlayer> {
    const r = await this.req<{ player: RemotePlayer }>(
      `/v1/games/${this.gameId}/players/${playerId}/businesses/${businessId}/buy`,
      { method: "POST" },
    );
    return r.player;
  }

  async collectIncome(playerId: string, businessId: string): Promise<{ payout: number; player: RemotePlayer }> {
    return this.req(`/v1/games/${this.gameId}/players/${playerId}/businesses/${businessId}/collect`, {
      method: "POST",
    });
  }

  async hire(
    playerId: string,
    businessId: string,
    employee: { id: string; name?: string; wage: number; role?: string },
  ): Promise<RemotePlayer> {
    const r = await this.action(playerId, "hire", { target: businessId, ...employee });
    return r.player;
  }

  async payroll(
    playerId: string,
    businessId: string,
  ): Promise<{ player: RemotePlayer; total: number; payments: { employeeId: string; amount: number }[] }> {
    const r = await this.action(playerId, "payroll", { target: businessId });
    return { player: r.player, ...(r.result as { total: number; payments: { employeeId: string; amount: number }[] }) };
  }

  async missions(playerId: string): Promise<{ missions: unknown[] }> {
    return this.req(`/v1/games/${this.gameId}/players/${playerId}/missions`);
  }

  async acceptMission(playerId: string, missionId: string): Promise<unknown> {
    return this.req(`/v1/games/${this.gameId}/players/${playerId}/missions/${missionId}/accept`, {
      method: "POST",
    });
  }

  async claimMission(playerId: string, missionId: string): Promise<{ reward: number; player: RemotePlayer }> {
    return this.req(`/v1/games/${this.gameId}/players/${playerId}/missions/${missionId}/claim`, {
      method: "POST",
    });
  }

  async offerTrade(from: string, to: string, terms: { offerCash?: number; offerItems?: Record<string, number>; askCash?: number; askItems?: Record<string, number> }): Promise<Record<string, unknown>> {
    return this.req(`/v1/games/${this.gameId}/trades`, {
      method: "POST",
      body: JSON.stringify({ from, to, ...terms }),
    });
  }

  async listTrades(playerId?: string): Promise<{ trades: Record<string, unknown>[] }> {
    const q = playerId ? `?playerId=${playerId}` : "";
    return this.req(`/v1/games/${this.gameId}/trades${q}`);
  }

  async listSchedules(): Promise<{ schedules: Record<string, unknown>[] }> {
    return this.req(`/v1/games/${this.gameId}/schedules`);
  }

  async defineSchedule(def: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.req(`/v1/games/${this.gameId}/schedules`, {
      method: "POST",
      body: JSON.stringify(def),
    });
  }

  async cancelSchedule(scheduleId: string): Promise<Record<string, unknown>> {
    return this.req(`/v1/games/${this.gameId}/schedules/${scheduleId}/cancel`, {
      method: "POST",
    });
  }

  private async tradeAction(tradeId: string, action: "accept" | "decline" | "cancel", by: string): Promise<Record<string, unknown>> {
    return this.req(`/v1/games/${this.gameId}/trades/${tradeId}/${action}`, {
      method: "POST",
      body: JSON.stringify({ by }),
    });
  }

  acceptTrade(tradeId: string, by: string): Promise<Record<string, unknown>> {
    return this.tradeAction(tradeId, "accept", by);
  }

  declineTrade(tradeId: string, by: string): Promise<Record<string, unknown>> {
    return this.tradeAction(tradeId, "decline", by);
  }

  analytics(): Promise<Record<string, unknown>> {
    return this.req(`/v1/games/${this.gameId}/analytics`);
  }

  economy(): Promise<Record<string, unknown>> {
    return this.req(`/v1/games/${this.gameId}/economy`);
  }

  activation(): Promise<{ playable: boolean; milestones: { id: string; label: string; reached: boolean; day: number | null }[] }> {
    return this.req(`/v1/games/${this.gameId}/activation`);
  }

  leaderboard(metric = "wealth", limit = 10): Promise<{ metric: string; entries: { rank: number; playerId: string; name: string; value: number }[] }> {
    return this.req(`/v1/games/${this.gameId}/leaderboards?metric=${metric}&limit=${limit}`);
  }

  rank(playerId: string, metric = "wealth"): Promise<{ metric: string; rank: number; total: number }> {
    return this.req(`/v1/games/${this.gameId}/players/${playerId}/rank?metric=${metric}`);
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
