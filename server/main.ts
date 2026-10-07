import { GameRegistry } from "./registry.js";
import { authFromEnv } from "./auth.js";
import { createHttpServer } from "./http.js";

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.SIMKIT_DATA_DIR ?? "./.simkit-data";

const registry = new GameRegistry(dataDir);
await registry.init();

const server = createHttpServer(registry, authFromEnv());
server.listen(port, () => {
  console.log(`simkit server on http://localhost:${port}`);
  console.log(`dashboard: http://localhost:${port}/dashboard`);
  console.log(`games: ${(registry.list().map((g) => g.gameId) ?? []).join(", ")}`);
});
