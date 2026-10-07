import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { GameRegistry } from "../server/registry.js";
import { SqliteGameStore } from "../server/sqlite.js";

describe("SqliteGameStore", () => {
  it("round-trips snapshots", () => {
    const store = new SqliteGameStore(":memory:");
    expect(store.listGames()).toEqual([]);
    store.saveSnapshot("g1", '{"gameId":"g1"}');
    store.saveSnapshot("g1", '{"gameId":"g1","v":2}'); // upsert
    expect(store.loadSnapshot("g1")).toBe('{"gameId":"g1","v":2}');
    expect(store.listGames()).toEqual(["g1"]);
    expect(store.loadSnapshot("missing")).toBeNull();
    store.deleteSnapshot("g1");
    expect(store.listGames()).toEqual([]);
    store.close();
  });

  it("registry persists and reloads games across restarts", async () => {
    const path = join(tmpdir(), `simkit-test-${Date.now()}.db`);
    try {
      const a = new GameRegistry(null, { sqlitePath: path });
      await a.init();
      const player = await a.get("lagos-life").players.create({ name: "Durable" });
      await a.persist("lagos-life");
      a.close();

      const b = new GameRegistry(null, { sqlitePath: path });
      await b.init();
      expect(b.get("lagos-life").players.get(player.id).name).toBe("Durable");
      b.close();
    } finally {
      rmSync(path, { force: true });
    }
  });
});
