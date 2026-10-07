import { DatabaseSync } from "node:sqlite";

/**
 * Durable single-file persistence (§11 of the plan, single-node edition).
 * Whole-sim snapshots as JSON rows — readable, portable, zero dependencies.
 * Postgres remains the scale-out answer; the `Store` interface is the seam.
 */
export class SqliteGameStore {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        game_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  saveSnapshot(gameId: string, json: string): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (game_id, data, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (game_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(gameId, json, Date.now());
  }

  loadSnapshot(gameId: string): string | null {
    const row = this.db
      .prepare(`SELECT data FROM snapshots WHERE game_id = ?`)
      .get(gameId) as { data: string } | undefined;
    return row?.data ?? null;
  }

  listGames(): string[] {
    const rows = this.db.prepare(`SELECT game_id FROM snapshots ORDER BY game_id`).all() as {
      game_id: string;
    }[];
    return rows.map((r) => r.game_id);
  }

  deleteSnapshot(gameId: string): void {
    this.db.prepare(`DELETE FROM snapshots WHERE game_id = ?`).run(gameId);
  }

  close(): void {
    this.db.close();
  }
}
