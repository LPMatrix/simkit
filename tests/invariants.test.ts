import { describe, expect, it } from "vitest";
import { createSimulation, resetTxCounter } from "../src/index.js";
import { lagosScenario } from "./scenarios.js";

describe("invariants", () => {
  it("holds on the reference scenario, including NPC activity", async () => {
    const sim = await lagosScenario(42);
    sim.execute("mama-put", "sleep", { hours: 2 }); // NPC actor with no wallet movement
    const results = sim.checkInvariants();
    expect(results).toEqual([
      { id: "money-conservation", ok: true, detail: expect.any(String) },
      { id: "no-negative-balances", ok: true, detail: expect.any(String) },
      { id: "ledger-complete", ok: true, detail: expect.any(String) },
    ]);
  });

  it("detects broken conservation", async () => {
    resetTxCounter();
    const sim = createSimulation({ gameId: "inv", seed: 1, startingCash: 100 });
    const p = await sim.players.create({ name: "A" });
    expect(sim.checkInvariants().every((r) => r.ok)).toBe(true);
    p.wallet.credit(999, { reason: "minted-out-of-thin-air", day: 1, time: "08:00" });
    p.wallet.balance -= 999; // ledger says issued, balance disagrees
    const conservation = sim.checkInvariants().find((r) => r.id === "money-conservation");
    expect(conservation?.ok).toBe(false);
    expect(conservation?.detail).toContain("balances=");
  });

  it("detects negative balances and malformed entries", async () => {
    resetTxCounter();
    const sim = createSimulation({ gameId: "inv2", seed: 1 });
    const p = await sim.players.create({ name: "A" });
    p.wallet.balance = -5; // bypasses the debit guard, as direct mutation can
    expect(sim.checkInvariants().find((r) => r.id === "no-negative-balances")?.ok).toBe(false);
    p.wallet.balance = 0;
    p.wallet.history.push({
      id: "tx_bad",
      type: "credit",
      amount: 10,
      day: 1,
      time: "08:00",
    }); // no reason
    expect(sim.checkInvariants().find((r) => r.id === "ledger-complete")?.ok).toBe(false);
  });
});
