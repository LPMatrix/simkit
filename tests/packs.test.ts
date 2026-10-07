import { describe, expect, it } from "vitest";
import { createSimulation, installPack, listPacks } from "../src/index.js";

describe("marketplace packs", () => {
  it("lists packs by kind", () => {
    expect(listPacks("world").map((p) => p.id)).toEqual(
      expect.arrayContaining(["world-lagos", "world-ilorin", "world-abuja"]),
    );
    expect(listPacks("system").map((p) => p.id)).toContain("system-nysc");
  });

  it("installs worlds, jobs and systems additively", async () => {
    const sim = createSimulation({ gameId: "packs", seed: 1 });
    installPack(sim, "world-ilorin");
    expect(sim.world.has("tanke")).toBe(true);

    installPack(sim, "jobs-nigerian-core");
    expect(sim.jobs.get("doctor").salary).toBe(500000);

    installPack(sim, "system-nysc");
    expect(sim.jobs.get("corper").salary).toBe(77000);
    expect(sim.events.list().map((e) => e.id)).toContain("nysc-allowee");

    // Re-install is idempotent.
    installPack(sim, "system-nysc");
    expect(sim.players.list()).toHaveLength(0);
  });

  it("rejects unknown packs", async () => {
    const sim = createSimulation({ gameId: "packs2", seed: 1 });
    expect(() => installPack(sim, "world-atlantis")).toThrow();
  });
});
