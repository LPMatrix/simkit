import { describe, expect, it } from "vitest";
import { ActionRefused, createSimulation, Sim } from "../src/index.js";

function workSim(): Sim {
  return createSimulation({
    gameId: "runtime",
    seed: 3,
    locations: [{ id: "yaba", travelCost: 500, travelTimeMinutes: 30 }],
    jobs: [{ id: "danfo-driver", salary: 150000, workingHours: 8 }],
  });
}

describe("actions: requirements and refusal", () => {
  it("refuses work without a job, moves no money, and records the refusal", async () => {
    const sim = workSim();
    const p = await sim.players.create({ name: "A" });
    const before = p.wallet.balance;

    let caught: unknown;
    try {
      p.work();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ActionRefused);
    expect((caught as ActionRefused).status).toBe(400);
    expect((caught as ActionRefused).reasons).toEqual(["Player has no job. Call acceptJob() first."]);

    expect(p.wallet.balance).toBe(before);
    const record = sim.causalRecords().at(-1);
    expect(record).toMatchObject({ actionId: "work", actorId: p.id, outcome: "refused" });
    expect(sim.eventLog.some((e) => e.type === "ACTION_REFUSED")).toBe(true);
  });

  it("reports every failing requirement, not just the first", async () => {
    const sim = workSim();
    const p = await sim.players.create({ name: "B" });
    p.adjustEnergy(-95); // energy 5 and still no job
    try {
      p.work();
      throw new Error("should have refused");
    } catch (err) {
      expect((err as ActionRefused).reasons).toHaveLength(2);
    }
  });

  it("keeps V1 refusal messages for work", async () => {
    const sim = workSim();
    const p = await sim.players.create({ name: "C" });
    p.acceptJob("danfo-driver");
    p.adjustEnergy(-95);
    expect(() => p.work()).toThrow("Too tired to work. Sleep or eat first.");
  });
});

describe("actions: causal linking", () => {
  it("links every ledger entry and event produced by an action to its cause", async () => {
    const sim = workSim();
    const p = await sim.players.create({ name: "D" });
    p.acceptJob("danfo-driver");
    p.work();

    const record = sim.causalRecords().at(-1);
    expect(record).toMatchObject({ actionId: "work", outcome: "ok", actorId: p.id });
    const salary = p.wallet.history.at(-1);
    expect(salary?.meta?.causeId).toBe(record?.id);

    const trace = sim.replay({ actorId: p.id }).at(-1);
    expect(trace?.transactions.map((t) => t.amount)).toEqual([5000]);
    const types = trace?.events.map((e) => e.type) ?? [];
    expect(types).toEqual(expect.arrayContaining(["PLAYER_WORKED", "WALLET_CREDITED", "ACTION_EXECUTED"]));
  });

  it("does not link ledger entries from outside an action", async () => {
    const sim = workSim();
    const p = await sim.players.create({ name: "E" });
    p.wallet.credit(100, p.stamp("gift")); // direct ledger write, not an action
    expect(p.wallet.history.at(-1)?.meta?.causeId).toBeUndefined();
  });

  it("links travel costs to the travel action", async () => {
    const sim = workSim();
    const p = await sim.players.create({ name: "E2" });
    p.travel("yaba");
    const record = sim.causalRecords().at(-1);
    expect(record).toMatchObject({ actionId: "travel", outcome: "ok" });
    expect(p.wallet.history.at(-1)).toMatchObject({ reason: "travel:home->yaba", amount: 500 });
    expect(p.wallet.history.at(-1)?.meta?.causeId).toBe(record?.id);
  });
});

describe("replay", () => {
  it("filters by actor and inclusive day window", async () => {
    const sim = workSim();
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    a.acceptJob("danfo-driver");
    b.acceptJob("danfo-driver");
    a.work(); // day 1
    sim.advanceDays(2);
    b.work(); // day 3

    const works = (t: { actionId: string }[]) => t.filter((c) => c.actionId === "work");
    expect(works(sim.replay({ actorId: a.id }))).toHaveLength(1);
    expect(works(sim.replay({ actorId: b.id, fromDay: 3, toDay: 3 }))).toHaveLength(1);
    expect(works(sim.replay({ fromDay: 2 }))).toHaveLength(1);
    expect(works(sim.replay())).toHaveLength(2);
    // accept-job is also an action, so the unfiltered window includes it.
    expect(sim.replay({ actorId: a.id })).toHaveLength(2);
  });

  it("includes refused attempts in the causal record", async () => {
    const sim = workSim();
    const p = await sim.players.create({ name: "F" });
    expect(() => p.work()).toThrow();
    const trace = sim.replay({ actorId: p.id });
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ outcome: "refused", transactions: [] });
  });
});

describe("explain", () => {
  it("breaks net money down by category", async () => {
    const sim = workSim();
    const p = await sim.players.create({ name: "G", location: "home" });
    p.acceptJob("danfo-driver");
    p.work(); // +5000 salary
    p.eat(1500); // -1500 food
    p.travel("yaba"); // -500 travel

    const e = sim.explain(p.id);
    expect(e.balance).toBe(50000 + 5000 - 1500 - 500);
    expect(e.net).toBe(50000 + 3000); // genesis funding plus activity
    const byCat = Object.fromEntries(e.lines.map((l) => [l.category, l.net]));
    expect(byCat).toEqual({ genesis: 50000, salary: 5000, food: -1500, travel: -500 });
    expect(e.lines[0].category).toBe("genesis"); // largest movement first
  });

  it("respects the day window", async () => {
    const sim = workSim();
    const p = await sim.players.create({ name: "H" });
    p.acceptJob("danfo-driver");
    p.work(); // credited on day 1
    sim.advanceDays(1);
    p.work(); // credited on day 3 (advanceDays keeps time-of-day, work adds 8h)
    expect(sim.explain(p.id, { toDay: 1 }).net).toBe(55000); // genesis + first paycheck
    expect(sim.explain(p.id, { fromDay: 3 }).net).toBe(5000);
    expect(sim.explain(p.id, { fromDay: 2, toDay: 2 }).net).toBe(0);
    expect(sim.explain(p.id).net).toBe(60000);
  });
});

describe("developer-defined actions", () => {
  it("runs custom requirements and effects through the same pipeline", async () => {
    const sim = workSim();
    sim.defineAction({
      id: "bribe-official",
      description: "Pay for a favour.",
      requires: [
        {
          id: "reputation",
          check: ({ actor }) =>
            actor.reputation >= 10 ? null : `Need reputation 10 (have ${actor.reputation})`,
        },
        {
          id: "cash",
          check: ({ actor }) => (actor.wallet.balance >= 1000 ? null : "Need ₦1,000"),
        },
      ],
      execute({ actor }) {
        actor.wallet.debit(1000, actor.stamp("bribe"));
        return "done";
      },
    });
    const p = await sim.players.create({ name: "I" });

    expect(() => sim.execute(p.id, "bribe-official")).toThrow("Need reputation 10 (have 0)");
    p.adjustReputation(10);
    const before = p.wallet.balance;
    expect(sim.execute(p.id, "bribe-official")).toBe("done");
    expect(p.wallet.balance).toBe(before - 1000);
    expect(p.wallet.history.at(-1)?.meta?.causeId).toBe(sim.causalRecords().at(-1)?.id);
  });

  it("rejects duplicate and unknown actions", async () => {
    const sim = workSim();
    expect(() => sim.defineAction({ id: "work", execute: () => null })).toThrow(/already defined/);
    const p = await sim.players.create({ name: "J" });
    expect(() => sim.execute(p.id, "teleport")).toThrow(/Unknown action/);
    expect(sim.listActions().map((a) => a.id)).toContain("work");
  });
});

describe("persistence of causal records", () => {
  it("survives snapshot round-trips", async () => {
    const sim = workSim();
    const p = await sim.players.create({ name: "K" });
    p.acceptJob("danfo-driver");
    p.work();
    expect(() => sim.execute(p.id, "work")).not.toThrow(); // second shift, energy still ok

    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.causalRecords()).toHaveLength(sim.causalRecords().length);
    // accept-job + two work shifts
    expect(restored.replay({ actorId: p.id })).toHaveLength(3);
    // New causes continue the sequence rather than colliding.
    restored.execute(p.id, "work");
    const ids = restored.causalRecords().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("migrated actions: refusals keep their semantics", () => {
  function shopSim(): Sim {
    return createSimulation({
      gameId: "shop",
      seed: 2,
      startingCash: 2000,
      locations: [{ id: "yaba", travelCost: 500, travelTimeMinutes: 30 }],
      jobs: [
        { id: "driver", salary: 90000, workingHours: 8 },
        { id: "surgeon", salary: 900000, workingHours: 8, requirements: { medicine: 60 } },
      ],
      items: [{ id: "amala", price: 1500, energy: 30 }],
    });
  }

  it("buy refuses with ActionRefused when broke, leaving cash and stock unchanged", async () => {
    const sim = shopSim();
    const p = await sim.players.create({ name: "L" });
    expect(() => p.buy("amala", 2)).toThrow(ActionRefused); // 3000 > 2000
    expect(p.wallet.balance).toBe(2000);
    expect(p.inventory.count("amala")).toBe(0);
    expect(sim.causalRecords().at(-1)).toMatchObject({ actionId: "buy", outcome: "refused" });
  });

  it("buy rejects non-positive quantities without recording a refusal", async () => {
    const sim = shopSim();
    const p = await sim.players.create({ name: "M" });
    const before = sim.causalRecords().length;
    expect(() => p.buy("amala", 0)).toThrow(/positive whole number/);
    expect((() => { try { p.buy("amala", 0); } catch (e) { return (e as { status: number }).status; } })()).toBe(400);
    expect(sim.causalRecords().length).toBe(before);
  });

  it("unknown ids stay request errors (not refusals)", async () => {
    const sim = shopSim();
    const p = await sim.players.create({ name: "N" });
    expect(() => p.buy("ghost")).toThrow(/Unknown item/);
    expect(() => p.travel("atlantis")).toThrow(/Unknown location/);
    expect(() => p.acceptJob("astronaut")).toThrow(/Unknown job/);
    expect(() => sim.execute(p.id, "teleport")).toThrow(/Unknown action/);
  });

  it("use and sell refuse without stock", async () => {
    const sim = shopSim();
    const p = await sim.players.create({ name: "O" });
    expect(() => p.use("amala")).toThrow(/Not enough amala: have 0, need 1/);
    expect(() => p.sell("amala", 1)).toThrow(ActionRefused);
    expect(p.wallet.balance).toBe(2000);
  });

  it("eat refuses when the player cannot pay", async () => {
    const sim = shopSim();
    const p = await sim.players.create({ name: "P" });
    expect(() => p.eat(5000)).toThrow(/Insufficient funds/);
    expect(p.energy).toBe(100);
  });

  it("accept-job refuses unmet skill requirements with the V1 message", async () => {
    const sim = shopSim();
    const p = await sim.players.create({ name: "Q" });
    expect(() => p.acceptJob("surgeon")).toThrow("Player does not meet requirements for job surgeon");
    expect(p.jobId).toBeNull();
  });

  it("sleep, quit-job and job changes produce causal records and log events", async () => {
    const sim = shopSim();
    const p = await sim.players.create({ name: "R" });
    p.acceptJob("driver");
    p.quitJob();
    p.sleep(2);
    expect(p.jobId).toBeNull();
    const types = sim.replay({ actorId: p.id }).map((t) => t.actionId);
    expect(types).toEqual(["accept-job", "quit-job", "sleep"]);
    const sleepTrace = sim.replay({ actorId: p.id }).at(-1);
    expect(sleepTrace?.events.map((e) => e.type)).toEqual(["PLAYER_SLEPT", "ACTION_EXECUTED"]);
  });

  it("quit-job when unemployed is a recorded no-op", async () => {
    const sim = shopSim();
    const p = await sim.players.create({ name: "S" });
    p.quitJob();
    expect(sim.causalRecords().at(-1)).toMatchObject({ actionId: "quit-job", outcome: "ok" });
    expect(sim.eventLog.some((e) => e.type === "JOB_QUIT")).toBe(false);
  });
});

describe("social, multiplayer, business and mission actions", () => {
  function socialSim(): Sim {
    return createSimulation({
      gameId: "social",
      seed: 8,
      startingCash: 20000,
      locations: [{ id: "yaba", travelCost: 0, travelTimeMinutes: 10 }],
      npcs: [{ id: "mama", name: "Mama", location: "yaba", dialogue: ["Eat!"] }],
      items: [{ id: "amala", price: 1500, energy: 30 }],
      businesses: [{ id: "buka", name: "Buka", cost: 5000, dailyIncome: 500 }],
      missions: [{ id: "earn-5k", goal: { type: "earn", target: 5000 }, reward: 1000 }],
    });
  }

  it("records talk, transfer and business actions with ledger links", async () => {
    const sim = socialSim();
    const a = await sim.players.create({ name: "A", location: "yaba" });
    const b = await sim.players.create({ name: "B", location: "yaba" });

    sim.talk(a.id, "mama");
    sim.transfer(a.id, b.id, 1000, "gift");
    sim.buyBusiness(a.id, "buka");
    sim.advanceDays(2);
    expect(sim.collectIncome(a.id, "buka")).toBe(1000);

    const actions = sim.replay({ actorId: a.id }).map((t) => t.actionId);
    expect(actions).toEqual(["talk", "transfer", "business-buy", "business-collect"]);
    const transfer = sim.replay({ actorId: a.id }).find((t) => t.actionId === "transfer");
    expect(transfer?.transactions.map((t) => t.reason).sort()).toEqual(
      [`gift:to:${b.id}`, `gift:from:${a.id}`].sort(),
    );
    expect(transfer?.transactions[0].meta?.causeId).toBe(transfer?.id);
    expect(sim.explain(a.id).lines.map((l) => l.category)).toEqual(
      expect.arrayContaining(["business-income", "gift", "business"]),
    );
  });

  it("records refused social actions with their reasons", async () => {
    const sim = socialSim();
    const a = await sim.players.create({ name: "C", location: "home" });
    expect(() => sim.talk(a.id, "mama")).toThrow(/travel there first/);
    expect(() => sim.transfer(a.id, a.id, 10)).toThrow(/yourself/);
    const other = await sim.players.create({ name: "C2", location: "home" });
    expect(() => sim.transfer(a.id, other.id, 0)).toThrow(/positive/);
    const refused = sim.causalRecords().filter((c) => c.outcome === "refused");
    expect(refused.map((c) => c.actionId)).toEqual(["talk"]);
  });

  it("trade acceptance is attributed to the accepting player", async () => {
    const sim = socialSim();
    const a = await sim.players.create({ name: "D" });
    const b = await sim.players.create({ name: "E" });
    a.buy("amala", 1);
    const offer = sim.offerTrade(a.id, b.id, { offerItems: { amala: 1 }, askCash: 500 });
    sim.acceptTrade(offer.id, b.id);

    const accepted = sim.replay({ actorId: b.id }).find((t) => t.actionId === "trade-accept");
    // The counterparty pays the proposer's ask: b debits, a credits.
    expect(accepted?.transactions.map((t) => t.reason).sort()).toEqual(
      [`trade:${offer.id}:to:${a.id}`, `trade:${offer.id}:from:${b.id}`].sort(),
    );
    // Documented limitation: replay filters by actor, so the proposer's view omits the accept.
    expect(sim.replay({ actorId: a.id }).some((t) => t.actionId === "trade-accept")).toBe(false);
  });

  it("refuses a trade that became unaffordable, and leaves it pending", async () => {
    const sim = socialSim();
    const a = await sim.players.create({ name: "F" });
    const b = await sim.players.create({ name: "G" });
    const offer = sim.offerTrade(a.id, b.id, { offerCash: 15000, askCash: 1000 });
    sim.transfer(b.id, a.id, 19500, "drain"); // b keeps 500, below the 1000 ask
    expect(() => sim.acceptTrade(offer.id, b.id)).toThrow(/no longer afford/);
    expect(sim.trades.get(offer.id).status).toBe("pending");
    expect(sim.causalRecords().at(-1)).toMatchObject({ actionId: "trade-accept", outcome: "refused" });
  });

  it("mission claim is refused until complete and can only happen once", async () => {
    const sim = socialSim();
    const a = await sim.players.create({ name: "H" });
    expect(() => sim.claimMission(a.id, "earn-5k")).toThrow(/not accepted/);
    sim.acceptMission(a.id, "earn-5k");
    expect(() => sim.claimMission(a.id, "earn-5k")).toThrow(/not complete/);
    a.wallet.credit(5000, a.stamp("hustle"));
    expect(sim.claimMission(a.id, "earn-5k")).toBe(1000);
    expect(() => sim.claimMission(a.id, "earn-5k")).toThrow(/already claimed/);
    // Refused attempts are recorded too; only successful ones are listed here.
    const ok = sim.replay({ actorId: a.id }).filter((t) => t.outcome === "ok").map((t) => t.actionId);
    expect(ok).toEqual(["mission-accept", "mission-claim"]);
  });

  it("talking across midnight ticks daily events like any other action", async () => {
    const sim = createSimulation({
      gameId: "midnight",
      seed: 1,
      locations: [{ id: "yaba", travelCost: 0, travelTimeMinutes: 10 }],
      npcs: [{ id: "mama", location: "yaba", dialogue: ["Hi"] }],
      events: [{ id: "always", probability: 1 }],
    });
    const p = await sim.players.create({ name: "I", location: "yaba" });
    p.hooks.advanceMinutes(15 * 60 + 45); // 08:00 → 23:45; talking for 15 minutes crosses midnight
    const day = sim.clock.day;
    sim.talk(p.id, "mama");
    expect(sim.clock.day).toBe(day + 1);
    expect(sim.eventLog.some((e) => e.type === "EVENT:always")).toBe(true);
  });
});

describe("market modifiers apply to prices", () => {
  it("transport and goods modifiers change what travel and shopping cost", async () => {
    const sim = createSimulation({
      gameId: "market",
      seed: 1,
      startingCash: 10000,
      locations: [{ id: "yaba", travelCost: 500, travelTimeMinutes: 10 }],
      items: [{ id: "amala", price: 1000 }],
    });
    const p = await sim.players.create({ name: "M", location: "home" });
    sim.console.setPrice("transport", 1.25);
    p.travel("yaba");
    expect(p.wallet.balance).toBe(10000 - 625); // 500 × 1.25
    sim.console.setPrice("goods", 2);
    p.buy("amala", 1);
    expect(p.wallet.balance).toBe(10000 - 625 - 2000);
    expect(sim.economics().inflationPct).toBeGreaterThan(0);
  });
});

describe("event effects that fail are visible", () => {
  it("logs EVENT_EFFECT_FAILED and keeps ticking when an effect throws", async () => {
    const sim = createSimulation({ gameId: "events-fail", seed: 1, startingCash: 1000 });
    const p = await sim.players.create({ name: "Rent", location: "home" });
    sim.events.define({
      id: "rent-due",
      probability: 1,
      cooldownDays: 30,
      effect: (ctx) => ctx.getPlayer(p.id).wallet.debit(5000, { reason: "rent" }),
    });
    expect(() => sim.advanceDays(3)).not.toThrow();
    const failures = sim.eventLog.filter((e) => e.type === "EVENT_EFFECT_FAILED");
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].data).toMatchObject({ eventId: "rent-due", error: expect.stringContaining("Insufficient") });
    expect(p.wallet.balance).toBe(1000); // nothing charged
    expect(p.wallet.history.some((t) => t.reason === "rent")).toBe(false);
  });
});
