import { describe, expect, it } from "vitest";
import { createSimulation, Sim } from "../src/index.js";

function tradeSim(): Sim {
  return createSimulation({
    gameId: "trades",
    seed: 4,
    startingCash: 20000,
    items: [{ id: "amala", price: 1500, energy: 10 }],
  });
}

describe("trade offers", () => {
  it("swaps cash and items atomically on accept", async () => {
    const sim = tradeSim();
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    a.buy("amala", 2);

    const offer = sim.offerTrade(a.id, b.id, {
      offerCash: 5000,
      offerItems: { amala: 1 },
      askCash: 8000,
    });
    expect(offer.status).toBe("pending");
    expect(sim.listTrades(b.id)).toHaveLength(1);
    expect(sim.listTrades(a.id)).toHaveLength(1);

    const done = sim.acceptTrade(offer.id, b.id);
    expect(done.status).toBe("accepted");
    // A: -5000 +8000 ; B: -8000 +5000
    expect(a.wallet.balance).toBe(20000 - 3000 - 5000 + 8000);
    expect(b.wallet.balance).toBe(20000 - 8000 + 5000);
    expect(a.inventory.count("amala")).toBe(1);
    expect(b.inventory.count("amala")).toBe(1);
    expect(sim.listTrades(b.id)).toHaveLength(0);
  });

  it("rejects empty, self, broke and over-promised offers", async () => {
    const sim = tradeSim();
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    expect(() => sim.offerTrade(a.id, b.id, {})).toThrow(/something/);
    expect(() => sim.offerTrade(a.id, a.id, { offerCash: 10 })).toThrow(/yourself/);
    expect(() => sim.offerTrade(a.id, b.id, { offerCash: 999_999 })).toThrow(/afford/);
    expect(() => sim.offerTrade(a.id, b.id, { offerItems: { amala: 1 } })).toThrow(/don't have/);
    expect(() => sim.offerTrade(a.id, "ghost", { offerCash: 10 })).toThrow(/Unknown player/);
  });

  it("revalidates at accept and enforces counterparty-only accept", async () => {
    const sim = tradeSim();
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    const offer = sim.offerTrade(a.id, b.id, { offerCash: 15000, askCash: 1000 });
    expect(() => sim.acceptTrade(offer.id, a.id)).toThrow(/counterparty/);
    // B spends everything, then can't pay the ask.
    sim.transfer(b.id, a.id, 20000, "drain");
    expect(() => sim.acceptTrade(offer.id, b.id)).toThrow(/no longer afford/);
    expect(sim.trades.get(offer.id).status).toBe("pending"); // nothing moved
    expect(a.wallet.balance).toBe(20000 + 20000);
  });

  it("declines and cancels", async () => {
    const sim = tradeSim();
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    const o1 = sim.offerTrade(a.id, b.id, { offerCash: 100 });
    expect(sim.declineTrade(o1.id, b.id).status).toBe("declined");
    expect(() => sim.acceptTrade(o1.id, b.id)).toThrow(/already declined/);

    const o2 = sim.offerTrade(a.id, b.id, { offerCash: 100 });
    expect(() => sim.cancelTrade(o2.id, b.id)).toThrow(/proposer/);
    expect(sim.cancelTrade(o2.id, a.id).status).toBe("cancelled");
  });

  it("survives snapshot round-trips", async () => {
    const sim = tradeSim();
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    sim.offerTrade(a.id, b.id, { offerCash: 100 });
    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.listTrades(b.id)).toHaveLength(1);
    restored.acceptTrade(restored.listTrades(b.id)[0].id, restored.players.list()[1].id);
    expect(restored.players.get(b.id).wallet.balance).toBe(20100);
  });
});
