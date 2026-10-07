import { describe, expect, it } from "vitest";
import { createSimulation, WorldCatalog } from "../src/index.js";

describe("world versioning", () => {
  it("applies salary changes to future work, keeps history intact", async () => {
    const sim = createSimulation({
      gameId: "w",
      seed: 1,
      jobs: [{ id: "danfo-driver", salary: 150000, workingHours: 8 }],
    });
    const catalog = new WorldCatalog();
    catalog.define("w", { version: "v1" });
    catalog.define("w", {
      version: "v2",
      jobs: [{ id: "danfo-driver", salary: 210000, workingHours: 8 }],
    });

    const p = await sim.players.create({ name: "A" });
    p.acceptJob("danfo-driver");
    p.work();
    expect(p.wallet.balance).toBe(50000 + 5000); // v1 daily pay

    const res = catalog.migrate(sim, "v2");
    expect(res).toEqual({ from: "v1", to: "v2", remapped: 0 });
    expect(sim.worldVersion).toBe("v2");

    p.work();
    expect(p.wallet.balance).toBe(50000 + 5000 + 7000); // v2 daily pay
    expect(sim.eventLog.some((e) => e.type === "WORLD_MIGRATED")).toBe(true);
  });

  it("remaps holders of removed jobs to fallback, quits the rest", async () => {
    const sim = createSimulation({
      gameId: "x",
      seed: 1,
      jobs: [
        { id: "old-job", salary: 100000 },
        { id: "new-job", salary: 120000 },
      ],
    });
    const catalog = new WorldCatalog();
    catalog.define("x", { version: "v1" });
    catalog.define("x", {
      version: "v2",
      removedJobs: ["old-job"],
      jobFallback: { "old-job": "new-job" },
    });
    catalog.define("x", { version: "v3", removedJobs: ["new-job"] });

    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    a.acceptJob("old-job");
    b.acceptJob("new-job");

    catalog.migrate(sim, "v2");
    expect(a.jobId).toBe("new-job"); // remapped via fallback
    expect(b.jobId).toBe("new-job"); // untouched

    catalog.migrate(sim, "v3");
    expect(a.jobId).toBeNull(); // no fallback → graceful quit
    expect(b.jobId).toBeNull();
  });

  it("rejects unknown versions and backwards migration", async () => {
    const sim = createSimulation({ gameId: "y", seed: 1 });
    const catalog = new WorldCatalog();
    catalog.define("y", { version: "v1" });
    expect(() => catalog.migrate(sim, "v9")).toThrow();
    catalog.define("y", { version: "v2" });
    catalog.migrate(sim, "v2");
    expect(() => catalog.migrate(sim, "v1")).toThrow();
  });
});
