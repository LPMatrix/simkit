import type { PlayerJSON } from "./player.js";

/** Pluggable persistence. In-memory by default; swap for Postgres later. */
export interface Store {
  savePlayer(player: PlayerJSON): Promise<void> | void;
  loadPlayer(id: string): Promise<PlayerJSON | null> | PlayerJSON | null;
  listPlayers(): Promise<PlayerJSON[]> | PlayerJSON[];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class InMemoryStore implements Store {
  private players = new Map<string, PlayerJSON>();

  savePlayer(player: PlayerJSON): void {
    this.players.set(player.id, clone(player));
  }

  loadPlayer(id: string): PlayerJSON | null {
    const p = this.players.get(id);
    return p ? clone(p) : null;
  }

  listPlayers(): PlayerJSON[] {
    return [...this.players.values()].map((p) => clone(p));
  }

  clear(): void {
    this.players.clear();
  }
}
