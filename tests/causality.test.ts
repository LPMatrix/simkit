import { describe, expect, it } from "vitest";
import { createSimulation, Sim } from "../src/index.js";

function town(): Sim {
  return createSimulation({
    gameId: "causal",
    seed: 6,
    startingCash: 100000,
    locations: [
      { id: "home", travelCost: 0, travelTimeMinutes: 5 },
      { id: "yaba", travelCost: 500, travelTimeMinutes: 30 },
    ],
    jobs: [{ id: "driver", salary: 90000, workingHours: 8 }],
    items: [{ id: "amala", price: 1000, energy: 10 }],
  });
}

describe("modifier links", () => {
  it("links travel to a console price change", async () => {
    const sim = town();
    const p = await sim.players.create({ name: "A", location: "home" });
    sim.console.setPrice("transport", 1.25);
    p.travel("yaba");
    expect(p.wallet.balance).toBe(100000 - 625);
    const record = sim.causalRecords().at(-1);
    expect(record?.links).toEqual([
      { kind: "modifier", label: "transport ×1.25 (console, day 1)", category: "travel", eventSeq: expect.any(Number) },
    ]);
  });

  it("attributes event-driven price changes to the firing event", async () => {
    const sim = town();
    const p = await sim.players.create({ name: "A", location: "home" });
    sim.events.define({
      id: "fuel-crisis",
      probability: 1,
      effect: (ctx) => {
        ctx.priceModifiers.transport = (ctx.priceModifiers.transport ?? 1) * 1.25;
      },
    });
    sim.advanceDays(1); // day 2: crisis fires
    p.travel("yaba");
    const record = sim.causalRecords().at(-1);
    expect(record?.links).toHaveLength(1);
    expect(record?.links[0]).toMatchObject({ kind: "modifier", category: "travel" });
    expect(record?.links[0].label).toContain("EVENT:fuel-crisis");
    const seq = record?.links[0].eventSeq as number;
    expect(sim.eventLog.find((e) => e.seq === seq)?.type).toBe("EVENT:fuel-crisis");
  });

  it("adds no link when prices are unmodified", async () => {
    const sim = town();
    const p = await sim.players.create({ name: "A", location: "home" });
    p.travel("yaba");
    expect(p.wallet.balance).toBe(100000 - 500);
    expect(sim.causalRecords().at(-1)?.links).toEqual([]);
  });

  it("attributes system-hook price changes to the system", async () => {
    const sim = town();
    const p = await sim.players.create({ name: "A", location: "home" });
    sim.use({
      id: "wx",
      onTick: ({ sim: s }) => {
        s.priceModifiers.goods = 1.5;
      },
    });
    sim.advanceDays(1);
    expect(sim.eventLog.some((e) => e.type === "PRICE_UPDATED")).toBe(true);
    p.buy("amala", 1);
    expect(p.wallet.balance).toBe(100000 - 1500);
    expect(sim.causalRecords().at(-1)?.links[0].label).toContain("system wx");
  });

  it("falls back gracefully when the source record is missing", async () => {
    const sim = town();
    const p = await sim.players.create({ name: "A", location: "home" });
    sim.priceModifiers.transport = 2; // set before source tracking existed
    const snap = sim.snapshot();
    delete (snap as { priceSources?: unknown }).priceSources;
    const restored = Sim.restore(JSON.parse(JSON.stringify(snap)));
    const rp = restored.players.get(p.id);
    rp.travel("yaba");
    expect(rp.wallet.balance).toBe(100000 - 1000);
    expect(restored.causalRecords().at(-1)?.links[0].label).toContain("source unknown");
  });
});

describe("trade links", () => {
  it("links acceptance to the proposal cause", async () => {
    const sim = town();
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    const offer = sim.offerTrade(a.id, b.id, { offerCash: 1000, askCash: 100 });
    sim.acceptTrade(offer.id, b.id);
    const accept = sim.causalRecords().at(-1);
    expect(accept?.actionId).toBe("trade-accept");
    const propose = sim.causalRecords().find((c) => c.actionId === "trade-offer");
    expect(accept?.links).toEqual([
      { kind: "trade", causeId: propose?.id, label: expect.stringContaining(offer.id) },
    ]);
  });
});

describe("replayGraph", () => {
  it("returns causes plus referenced event nodes with edges", async () => {
    const sim = town();
    const p = await sim.players.create({ name: "A", location: "home" });
    sim.events.define({
      id: "fuel-crisis",
      probability: 1,
      effect: (ctx) => {
        ctx.priceModifiers.transport = 2;
      },
    });
    sim.advanceDays(1);
    p.travel("yaba");
    const graph = sim.replayGraph({ actorId: p.id });
    const travel = graph.nodes.find((n) => n.actionId === "travel");
    expect(travel?.kind).toBe("cause");
    const edge = graph.edges.find((e) => e.to === travel?.id);
    expect(edge?.kind).toBe("modifier");
    const eventNode = graph.nodes.find((n) => n.id === edge?.from);
    expect(eventNode).toMatchObject({ kind: "event", type: "EVENT:fuel-crisis" });
  });

  it("links trade causes to each other", async () => {
    const sim = town();
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    const offer = sim.offerTrade(a.id, b.id, { offerCash: 100, askCash: 10 });
    sim.acceptTrade(offer.id, b.id);
    const graph = sim.replayGraph();
    expect(graph.edges).toEqual([
      {
        from: expect.stringMatching(/^cause_/),
        to: expect.stringMatching(/^cause_/),
        kind: "trade",
        label: expect.stringContaining(offer.id),
      },
    ]);
    expect(graph.edges[0].from).not.toBe(graph.edges[0].to);
  });
});

describe("explain names the trigger", () => {
  it("answers why a balance is lower by naming the price event", async () => {
    const sim = createSimulation({
      gameId: "why",
      seed: 6,
      startingCash: 200000,
      locations: [
        { id: "home", travelCost: 0, travelTimeMinutes: 5 },
        { id: "yaba", travelCost: 500, travelTimeMinutes: 30 },
      ],
      jobs: [{ id: "driver", salary: 300000, workingHours: 8 }], // 10000/day
    });
    const p = await sim.players.create({ name: "A", location: "home" });
    p.acceptJob("driver");
    p.work(); // +10000, day 1
    sim.events.define({
      id: "fuel-crisis",
      probability: 1,
      effect: (ctx) => {
        ctx.priceModifiers.transport = 2;
      },
    });
    sim.advanceDays(1); // day 2: crisis fires
    p.travel("yaba"); // 500 × 2 = 1000 instead of 500
    const explained = sim.explain(p.id);
    const travel = explained.lines.find((l) => l.category === "travel");
    expect(travel?.net).toBe(-1000);
    expect(travel?.why).toHaveLength(1);
    expect(travel?.why?.[0]).toContain("EVENT:fuel-crisis");
    expect(sim.explain(p.id, { fromDay: 1, toDay: 1 }).lines.find((l) => l.category === "travel")).toBeUndefined();
  });
});

describe("causal persistence", () => {
  it("round-trips links and sources, and keeps linking after restore", async () => {
    const sim = town();
    const p = await sim.players.create({ name: "A", location: "home" });
    sim.console.setPrice("transport", 1.5);
    p.travel("yaba");
    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.causalRecords().at(-1)?.links[0].label).toContain("console");
    const rp = restored.players.get(p.id);
    rp.travel("home");
    expect(rp.wallet.balance).toBe(100000 - 750);
    expect(restored.causalRecords().at(-1)?.links[0].label).toContain("console");
  });
});
