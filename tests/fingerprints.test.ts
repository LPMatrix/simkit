import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resetTxCounter, SIMULATION_VERSION, Sim } from "../src/index.js";
import { lagosScenario } from "./scenarios.js";

interface FingerprintFile {
  version: number;
  reason: string;
  cases: { name: string; seed: number; hash: string }[];
}

function loadFingerprints(): FingerprintFile {
  return JSON.parse(readFileSync(new URL("./fingerprints.json", import.meta.url), "utf8"));
}

describe("golden fingerprints", () => {
  it("matches the pinned reference hashes", async () => {
    const file = loadFingerprints();
    expect(file.version).toBe(SIMULATION_VERSION);
    for (const c of file.cases) {
      const sim = await lagosScenario(c.seed);
      expect(
        sim.fingerprint(),
        `fingerprint moved for "${c.name}". If the behavior change is intended: bump SIMULATION_VERSION in src/version.ts, record why in tests/fingerprints.json, and update the hash.`,
      ).toBe(c.hash);
    }
  });

  it("is sensitive to the seed", async () => {
    const a = await lagosScenario(42);
    const b = await lagosScenario(43);
    expect(a.fingerprint()).not.toBe(b.fingerprint());
  });

  it("is stable across identical runs", async () => {
    const a = await lagosScenario(42);
    const b = await lagosScenario(42);
    expect(a.fingerprint()).toBe(b.fingerprint());
  });
});
