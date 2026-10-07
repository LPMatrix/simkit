import { describe, expect, it } from "vitest";
import { Meter } from "../server/metering.js";

describe("usage metering", () => {
  it("defaults to free tier and reports usage", () => {
    const meter = new Meter();
    meter.recordApi("g");
    meter.recordEvents("g", 10);
    const report = meter.report("g", 3);
    expect(report.plan).toBe("free");
    expect(report.usage).toMatchObject({ players: 3, apiCalls: 1, simulationEvents: 10 });
  });

  it("enforces player caps with 429 and lifts them on upgrade", () => {
    const meter = new Meter();
    expect(() => meter.checkPlayerCap("g", 1000)).toThrowError(/cap reached/);
    try {
      meter.checkPlayerCap("g", 1000);
    } catch (err) {
      expect((err as { status: number }).status).toBe(429);
    }
    meter.setPlan("g", "developer");
    expect(() => meter.checkPlayerCap("g", 1000)).not.toThrow();
  });

  it("rejects unknown tiers", () => {
    const meter = new Meter();
    expect(() => meter.setPlan("g", "ultra" as never)).toThrow();
  });
});
