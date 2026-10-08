import { describe, expect, it } from "vitest";
import {
  ActionRefused,
  createSimulation,
  createSimulationFromConfig,
  parseGameConfig,
  Sim,
} from "../src/index.js";

function rentSim(): Sim {
  return createSimulation({ gameId: "rent", seed: 4, startingCash: 500000 });
}

describe("schedule definitions", () => {
  it("validates ids, payer, amount, cadence, and policy", async () => {
    const sim = rentSim();
    await sim.players.create({ name: "A" });
    const good = { id: "rent", payer: "player_1", amount: 1000, everyDays: 30 };
    sim.schedules.define(good);
    expect(() => sim.schedules.define(good)).toThrow(/already exists/);
    expect(() => sim.schedules.define({ ...good, id: "" })).toThrow(/must have an id/);
    expect(() => sim.schedules.define({ ...good, id: "x", payer: "" })).toThrow(/must have a payer/);
    expect(() => sim.schedules.define({ ...good, id: "x", amount: 0 })).toThrow(/positive/);
    expect(() => sim.schedules.define({ ...good, id: "x", everyDays: 0 })).toThrow(/positive integer/);
    expect(() => sim.schedules.define({ ...good, id: "x", everyDays: 1.5 })).toThrow(/positive integer/);
    expect(() =>
      sim.schedules.define({ ...good, id: "x", onMiss: "explode" as never }),
    ).toThrow(/one of/);
    expect(() => sim.schedules.define({ ...good, id: "x", startsOn: 0 })).toThrow(/>= 1/);
    expect(() => sim.schedules.get("ghost")).toThrow(/Unknown schedule: ghost/);
  });
});

describe("settlement timing", () => {
  it("charges on cadence: daily, weekly, monthly", async () => {
    const sim = rentSim();
    const p = await sim.players.create({ name: "A" });
    sim.schedules.define({ id: "daily", payer: p.id, amount: 100, everyDays: 1, reason: "fee" });
    sim.schedules.define({ id: "weekly", payer: p.id, amount: 100, everyDays: 7, reason: "fee" });
    sim.schedules.define({ id: "monthly", payer: p.id, amount: 100, everyDays: 30, reason: "fee" });
    sim.advanceDays(7); // days 2..8. Schedules created day 1 are first due on the day-2 tick.
    const paid = (id: string): number =>
      sim.eventLog.filter((e) => e.type === "OBLIGATION_PAID" && (e.data as { scheduleId: string }).scheduleId === id)
        .length;
    expect(paid("daily")).toBe(7);
    expect(paid("weekly")).toBe(2); // day 2 (first due) and day 8
    expect(paid("monthly")).toBe(1); // day 2, then next due day 32
    expect(p.wallet.balance).toBe(500000 - 700 - 200 - 100);
  });

  it("charges once per elapsed period over long jumps, not once per tick", async () => {
    const sim = rentSim();
    const p = await sim.players.create({ name: "A" });
    sim.schedules.define({ id: "rent", payer: p.id, amount: 1000, everyDays: 30, reason: "rent" });
    sim.advanceDays(30); // days 2..31: covers periods starting day 1 and day 31
    expect(p.wallet.history.filter((t) => t.reason === "rent")).toHaveLength(2);
    expect(sim.schedules.get("rent").nextDue).toBe(61);
  });

  it("settles when actions cross midnight, not just on advanceDays", async () => {
    const sim = rentSim();
    const p = await sim.players.create({ name: "A" });
    sim.schedules.define({ id: "daily", payer: p.id, amount: 100, everyDays: 1, reason: "fee" });
    p.sleep(20); // 08:00 + 20h crosses into day 2
    expect(sim.clock.day).toBe(2);
    expect(p.wallet.history.filter((t) => t.reason === "fee")).toHaveLength(1);
  });
});

describe("miss policies", () => {
  async function brokeSim(policy: "skip" | "retry" | "default"): Promise<Sim> {
    const sim = createSimulation({ gameId: `broke-${policy}`, seed: 1, startingCash: 500 });
    const p = await sim.players.create({ name: "A" });
    sim.schedules.define({ id: "rent", payer: p.id, amount: 5000, everyDays: 1, reason: "rent", onMiss: policy });
    return sim;
  }

  it("skip: logs the miss and moves to the next due date", async () => {
    const sim = await brokeSim("skip");
    sim.advanceDays(3);
    const missed = sim.eventLog.filter((e) => e.type === "OBLIGATION_MISSED");
    expect(missed).toHaveLength(3);
    expect(missed[0].data).toMatchObject({ scheduleId: "rent", amount: 5000 });
    expect(sim.schedules.get("rent").nextDue).toBe(5); // 1 + 3 advances... starts day 1, due 1..4
    expect(sim.players.get("player_1").wallet.balance).toBe(500);
  });

  it("retry: stays due and attempts again each day", async () => {
    const sim = await brokeSim("retry");
    sim.advanceDays(2);
    expect(sim.eventLog.filter((e) => e.type === "OBLIGATION_MISSED")).toHaveLength(2);
    expect(sim.schedules.get("rent").nextDue).toBe(1); // never advanced
    expect(sim.schedules.get("rent").active).toBe(true);
  });

  it("default: records the default and cancels", async () => {
    const sim = await brokeSim("default");
    sim.advanceDays(3);
    expect(sim.eventLog.filter((e) => e.type === "OBLIGATION_MISSED")).toHaveLength(1);
    expect(sim.eventLog.filter((e) => e.type === "OBLIGATION_DEFAULTED")).toHaveLength(1);
    expect(sim.schedules.get("rent").active).toBe(false);
  });

  it("a funded retry recovers on the next tick", async () => {
    const sim = await brokeSim("retry");
    sim.advanceDays(1); // missed, still due day 1
    const p = sim.players.get("player_1");
    p.wallet.credit(10000, { reason: "gift", day: 2, time: "08:00" });
    sim.advanceDays(1); // pays now; next due jumps past the caught-up days
    expect(p.wallet.history.filter((t) => t.reason === "rent")).toHaveLength(1);
    expect(sim.schedules.get("rent").nextDue).toBe(4);
  });
});

describe("payees and sinks", () => {
  it("credits an existing actor payee", async () => {
    const sim = rentSim();
    const payer = await sim.players.create({ name: "Payer" });
    const payee = await sim.players.create({ name: "Payee" });
    sim.schedules.define({ id: "allowance", payer: payer.id, payee: payee.id, amount: 2000, everyDays: 1, reason: "allowance" });
    sim.advanceDays(1);
    expect(payee.wallet.balance).toBe(500000 + 2000);
    expect(payee.wallet.history.at(-1)?.reason).toBe("allowance:from:" + payer.id);
    const paid = sim.eventLog.find((e) => e.type === "OBLIGATION_PAID");
    expect(paid?.data).toMatchObject({ sunk: false, payee: payee.id });
  });

  it("destroys money for sinks and unknown payees", async () => {
    const sim = rentSim();
    const p = await sim.players.create({ name: "A" });
    sim.schedules.define({ id: "burn", payer: p.id, amount: 9000, everyDays: 1, reason: "burn:server" });
    sim.schedules.define({ id: "typo", payer: p.id, payee: "nobody", amount: 100, everyDays: 1 });
    sim.advanceDays(1);
    const econ = sim.economics();
    expect(econ.destroyed).toBe(9100);
    const paid = sim.eventLog.find((e) => e.type === "OBLIGATION_PAID" && (e.data as { scheduleId: string }).scheduleId === "typo");
    expect(paid?.data).toMatchObject({ sunk: true });
  });
});

describe("replay, explain, and persistence", () => {
  it("settlements and misses appear in replay and explain", async () => {
    const sim = createSimulation({ gameId: "vis", seed: 1, startingCash: 10000 });
    const p = await sim.players.create({ name: "A" });
    sim.schedules.define({ id: "fee", payer: p.id, amount: 1000, everyDays: 1, reason: "fee" });
    sim.advanceDays(1); // paid
    p.wallet.debit(9000, { reason: "spree", day: 2, time: "08:00" });
    sim.advanceDays(1); // missed (1000 left... 10000-1000-9000=0, needs 1000 → debit 0? balance 0 < 1000 → refused)
    const trace = sim.replay({ actorId: p.id });
    expect(trace.map((t) => [t.actionId, t.outcome])).toEqual([
      ["settle-obligation", "ok"],
      ["settle-obligation", "refused"],
    ]);
    expect(trace[0].transactions.map((t) => t.reason)).toEqual(["fee"]);
    const explained = sim.explain(p.id);
    expect(explained.lines.find((l) => l.category === "fee")?.debits).toBe(1000);
  });

  it("round-trips nextDue and active flags", async () => {
    const sim = rentSim();
    const p = await sim.players.create({ name: "A" });
    sim.schedules.define({ id: "rent", payer: p.id, amount: 1000, everyDays: 30 });
    sim.advanceDays(2);
    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.schedules.get("rent").nextDue).toBe(sim.schedules.get("rent").nextDue);
    restored.schedules.cancel("rent");
    expect(restored.schedules.get("rent").active).toBe(false);
  });

  it("loads from createSimulation opts and YAML config", () => {
    const a = createSimulation({
      gameId: "opts",
      seed: 1,
      schedules: [{ id: "fee", payer: "player_1", amount: 10, everyDays: 7 }],
    });
    expect(a.schedules.list().map((s) => s.id)).toEqual(["fee"]);
    const cfg = parseGameConfig("gameId: cfg\nschedules:\n  - id: fee\n    payer: player_1\n    amount: 10\n    everyDays: 7\n");
    const { sim } = createSimulationFromConfig(cfg);
    expect(sim.schedules.list().map((s) => s.id)).toEqual(["fee"]);
  });
});

describe("settle-obligation as an action", () => {
  it("is callable directly and validates", async () => {
    const sim = rentSim();
    const p = await sim.players.create({ name: "A" });
    sim.schedules.define({ id: "fee", payer: p.id, amount: 100, everyDays: 1 });
    const result = sim.execute(p.id, "settle-obligation", { scheduleId: "fee" });
    expect(result).toMatchObject({ amount: 100, sunk: true });
    expect(() => sim.execute(p.id, "settle-obligation", { scheduleId: "ghost" })).toThrow(
      /Unknown schedule: ghost/,
    );
    expect(() => sim.execute(p.id, "settle-obligation", {})).toThrow(/scheduleId/);
    sim.schedules.cancel("fee");
    expect(() => sim.execute(p.id, "settle-obligation", { scheduleId: "fee" })).toThrow(/not active/);
  });

  it("refusal is an ActionRefused", async () => {
    const sim = createSimulation({ gameId: "ref", seed: 1, startingCash: 50 });
    const p = await sim.players.create({ name: "A" });
    sim.schedules.define({ id: "fee", payer: p.id, amount: 100, everyDays: 1 });
    try {
      sim.execute(p.id, "settle-obligation", { scheduleId: "fee" });
      throw new Error("should refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(ActionRefused);
    }
  });
});
