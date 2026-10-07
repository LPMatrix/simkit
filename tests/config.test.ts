import { describe, expect, it } from "vitest";
import {
  createSimulationFromConfig,
  installPack,
  listPacks,
  loadGameConfigFile,
  parseGameConfig,
} from "../src/index.js";

const YAML = `
gameId: test-config
currency: NGN
seed: 11
startingCash: 30000
startingLocation: tanke
packs: [world-ilorin, jobs-nigerian-core]
jobs:
  - id: okada-rider
    salary: 90000
worldVersions:
  - version: v1
  - version: v2
    jobs:
      - id: okada-rider
        salary: 110000
`;

describe("game config files", () => {
  it("parses YAML and builds a playable sim", async () => {
    const cfg = parseGameConfig(YAML);
    expect(cfg.gameId).toBe("test-config");
    const { sim, worldVersions } = createSimulationFromConfig(cfg);
    expect(sim.world.has("tanke")).toBe(true); // from pack
    expect(sim.jobs.get("okada-rider").salary).toBe(90000); // inline def
    expect(sim.jobs.get("doctor").salary).toBe(500000); // from jobs pack
    expect(worldVersions.map((v) => v.version)).toEqual(["v1", "v2"]);

    const p = await sim.players.create({ name: "Config" });
    expect(p.locationId).toBe("tanke"); // startingLocation
    expect(p.wallet.balance).toBe(30000); // startingCash
    p.acceptJob("okada-rider");
    p.work();
    expect(p.wallet.balance).toBe(30000 + 3000);
  });

  it("parses JSON too", () => {
    const cfg = parseGameConfig('{"gameId":"json-game","packs":[]}');
    expect(cfg.gameId).toBe("json-game");
  });

  it("loads the ilorin example file", async () => {
    const cfg = await loadGameConfigFile("examples/ilorin-life.yaml");
    expect(cfg.gameId).toBe("ilorin-life");
    const { sim } = createSimulationFromConfig(cfg);
    expect(sim.world.has("unilorin")).toBe(true);
    const p = await sim.players.create({ name: "Ilorin" });
    expect(p.locationId).toBe("tanke");
  });

  it("rejects bad configs with clear errors", () => {
    expect(() => parseGameConfig("")).toThrow(/empty/);
    expect(() => parseGameConfig("- just\n- a\n- list")).toThrow(/must be a YAML\/JSON object/);
    expect(() => parseGameConfig("currency: NGN")).toThrow(/gameId/);
    expect(() => parseGameConfig("gameId: x\npacks: [world-atlantis]")).toThrow(/Unknown pack/);
    expect(() => parseGameConfig("gameId: x: : :")).toThrow(/Invalid game config/);
  });
});

describe("new marketplace packs", () => {
  it("startup, vehicles and fashion install", async () => {
    expect(listPacks("assets").map((p) => p.id).sort()).toEqual(["assets-fashion", "assets-vehicles"]);
    expect(listPacks("system").map((p) => p.id)).toContain("system-startup");
    const { createSimulation } = await import("../src/index.js");
    const sim = createSimulation({ gameId: "content", seed: 1 });
    installPack(sim, "system-startup");
    installPack(sim, "assets-vehicles");
    installPack(sim, "assets-fashion");
    expect(sim.jobs.get("founder").salary).toBe(50000);
    expect(sim.items.get("danfo-bus").price).toBe(2500000);
    expect(sim.items.get("agbada").price).toBe(150000);
    expect(sim.missions.get("ramen-profitable").reward).toBe(50000);
  });
});
