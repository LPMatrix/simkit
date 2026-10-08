import { readFile } from "node:fs/promises";
import { load as yamlLoad } from "js-yaml";
import { createSimulation, Sim } from "./sim.js";
import { PACKS, installPack } from "./packs/index.js";
import type { BusinessDef } from "./businesses.js";
import type { EventDefinition } from "./events.js";
import type { ItemDef } from "./inventory.js";
import type { JobDef, LocationDef } from "./types.js";
import type { MissionDef } from "./missions.js";
import type { NpcDef } from "./npcs.js";
import type { WorldVersionDef } from "./worlds.js";
import type { EntityDef } from "./entities.js";

/**
 * Declarative game configuration (§6 of the plan — configuration over code).
 * A whole world in a YAML/JSON file; the SDK interprets it. The stepping
 * stone toward a no-code SIM Game Builder.
 */
export interface GameConfigFile {
  gameId: string;
  currency?: string;
  seed?: number | string;
  startingCash?: number;
  startingLocation?: string;
  /** Marketplace pack ids, installed in order before inline defs. */
  packs?: string[];
  locations?: (string | LocationDef)[];
  jobs?: JobDef[];
  events?: EventDefinition[];
  npcs?: NpcDef[];
  items?: ItemDef[];
  businesses?: BusinessDef[];
  missions?: MissionDef[];
  entities?: EntityDef[];
  worldVersions?: WorldVersionDef[];
}

/** Parse YAML (or JSON) config text with actionable validation errors. */
export function parseGameConfig(text: string): GameConfigFile {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Game config is empty");
  let raw: unknown;
  try {
    raw = trimmed.startsWith("{") ? (JSON.parse(text) as unknown) : yamlLoad(text);
  } catch (err) {
    throw new Error(`Invalid game config: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Game config must be a YAML/JSON object");
  }
  const cfg = raw as GameConfigFile;
  if (!cfg.gameId || typeof cfg.gameId !== "string") {
    throw new Error('Game config requires a "gameId" string');
  }
  for (const packId of cfg.packs ?? []) {
    if (!PACKS[packId]) throw new Error(`Unknown pack in config: ${packId}`);
  }
  return cfg;
}

/** Build a live Sim from parsed config (packs first, then inline defs win). */
export function createSimulationFromConfig(cfg: GameConfigFile): {
  sim: Sim;
  worldVersions: WorldVersionDef[];
} {
  const sim = createSimulation({
    gameId: cfg.gameId,
    currency: cfg.currency,
    seed: cfg.seed,
    startingCash: cfg.startingCash,
    startingLocation: cfg.startingLocation,
    locations: cfg.locations,
    jobs: cfg.jobs,
    events: cfg.events,
    npcs: cfg.npcs,
    items: cfg.items,
    businesses: cfg.businesses,
    missions: cfg.missions,
    entities: cfg.entities,
  });
  for (const packId of cfg.packs ?? []) installPack(sim, packId);
  return { sim, worldVersions: cfg.worldVersions ?? [] };
}

export async function loadGameConfigFile(path: string): Promise<GameConfigFile> {
  return parseGameConfig(await readFile(path, "utf8"));
}
