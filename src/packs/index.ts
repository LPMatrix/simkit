import type { Sim } from "../sim.js";
import { WORLD_ABUJA, WORLD_ILORIN, WORLD_LAGOS, type Pack } from "./worlds.js";
import { JOBS_NIGERIAN_CORE } from "./jobs.js";
import { SYSTEM_MARKET, SYSTEM_NYSC, SYSTEM_UNIVERSITY } from "./systems.js";

export type { Pack };
export { WORLD_ABUJA, WORLD_ILORIN, WORLD_LAGOS, JOBS_NIGERIAN_CORE, SYSTEM_MARKET, SYSTEM_NYSC, SYSTEM_UNIVERSITY };

/** The marketplace shelf: every installable pack, by id. */
export const PACKS: Record<string, Pack> = {
  [WORLD_LAGOS.id]: WORLD_LAGOS,
  [WORLD_ILORIN.id]: WORLD_ILORIN,
  [WORLD_ABUJA.id]: WORLD_ABUJA,
  [JOBS_NIGERIAN_CORE.id]: JOBS_NIGERIAN_CORE,
  [SYSTEM_NYSC.id]: SYSTEM_NYSC,
  [SYSTEM_UNIVERSITY.id]: SYSTEM_UNIVERSITY,
  [SYSTEM_MARKET.id]: SYSTEM_MARKET,
};

export function listPacks(kind?: Pack["kind"]): Pack[] {
  return Object.values(PACKS).filter((p) => !kind || p.kind === kind);
}

/** Install a pack into a live Sim (additive — never touches players). */
export function installPack(sim: Sim, packId: string): Pack {
  const pack = PACKS[packId];
  if (!pack) throw new Error(`Unknown pack: ${packId}`);
  sim.use(pack);
  return pack;
}
