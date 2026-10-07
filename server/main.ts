import { GameRegistry } from "./registry.js";
import { authFromEnv } from "./auth.js";
import { createHttpServer } from "./http.js";

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.SIMKIT_DATA_DIR ?? "./.simkit-data";
const sqlitePath = process.env.SIMKIT_SQLITE_PATH; // e.g. "./simkit.db" — durable single-file store

const registry = new GameRegistry(sqlitePath ? null : dataDir, { sqlitePath });
await registry.init();

const server = createHttpServer(registry, authFromEnv());
server.listen(port, () => {
  console.log(`simkit server on http://localhost:${port}`);
  console.log(`dashboard: http://localhost:${port}/dashboard`);
  console.log(`play: http://localhost:${port}/play`);
  console.log(`store: ${sqlitePath ? `sqlite:${sqlitePath}` : `json:${dataDir}`}`);
  console.log(`games: ${(registry.list().map((g) => g.gameId) ?? []).join(", ")}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    registry.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
