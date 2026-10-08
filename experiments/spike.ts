/**
 * Three-simulation reuse spike (research doc §14).
 *
 * Rule: the SDK under src/ is NOT modified for this experiment. Each simulation
 * is written against the public API only. Every mechanic is tagged:
 *
 *   [OK]          supported by SimKit as-is
 *   [WORKAROUND]  possible, but only by bending a primitive (closure over an id,
 *                 direct state mutation, an event standing in for a schedule)
 *   [MISSING]     not expressible with the current primitives
 *
 * `npm run spike` runs the three scenarios and prints the tag counts.
 */
import {
  createSimulation,
  requirements,
  type Sim,
  type Player,
} from "../src/index.js";

// === SECTION: LAGOS LIFE ===
export async function lagosLife(): Promise<{ sim: Sim; player: Player }> {
  const sim = createSimulation({
    gameId: "exp-lagos",
    currency: "NGN",
    seed: 42,
    locations: [
      { id: "yaba", travelCost: 500, travelTimeMinutes: 30 }, // [OK] locations and travel
      { id: "lekki", travelCost: 2000, travelTimeMinutes: 90 }, // [OK]
    ],
    jobs: [{ id: "danfo-driver", salary: 150000, workingHours: 10, energyCost: 35 }], // [OK] jobs
    items: [{ id: "amala", price: 1500, energy: 30 }], // [OK] needs (food)
    npcs: [{ id: "mama-put", location: "yaba", dialogue: ["Pay first."] }], // [OK] relationships
    businesses: [{ id: "buka", location: "yaba", cost: 200000, dailyIncome: 8000 }], // [OK] businesses
    events: [
      {
        id: "fuel-crisis",
        probability: 0.05,
        effect: (ctx) => {
          ctx.priceModifiers.transport = (ctx.priceModifiers.transport ?? 1) * 1.25;
        },
      }, // [OK] market shock, applies to travel prices
    ],
  });
  const player = await sim.players.create({ name: "Mubaraq", location: "yaba" });
  player.acceptJob("danfo-driver"); // [OK]
  // Rent is a recurring obligation, settled through the pipeline.
  sim.schedules.define({ id: "rent", payer: player.id, amount: 160000, everyDays: 30, reason: "rent" }); // [OK] schedule, not a probability-1 event
  // Transport and food are immediate actions.
  return { sim, player };
}
// === END: LAGOS LIFE ===

// === SECTION: STARTUP ===
export async function startup(): Promise<{ sim: Sim; founder: Player }> {
  const sim = createSimulation({
    gameId: "exp-startup",
    seed: 7,
    jobs: [{ id: "founder", salary: 0, workingHours: 12, energyCost: 20 }], // [WORKAROUND] a founder is not paid a salary; the role is a placeholder
    businesses: [{ id: "acme", name: "Acme", cost: 0, dailyIncome: 0 }], // [OK] company as a business
    missions: [{ id: "series-a", goal: { type: "wealth", target: 1000000 }, reward: 0 }], // [OK] milestone
    items: [{ id: "server-credit", price: 0 }], // [MISSING] no cost-of-goods or per-unit consumption model for a service
  });
  const founder = await sim.players.create({ name: "Founder", startingCash: 200000 }); // [OK] seed funding
  founder.acceptJob("founder"); // [OK]
  sim.buyBusiness(founder.id, "acme"); // [OK] company ownership

  // Revenue is a fixed daily income. Nothing links it to market demand.
  sim.businesses.get("acme").dailyIncome = 6000; // [WORKAROUND] revenue set by direct mutation; bypasses the ledger
  // [MISSING] market demand or competition does not change business income.
  // Staff are employee entities hired through the hire action and paid through payroll.
  sim.execute(founder.id, "hire", { target: "acme", id: "eng", name: "Engineer", wage: 8000 }); // [OK]
  sim.execute(founder.id, "hire", { target: "acme", id: "intern", name: "Intern", wage: 3000 }); // [OK]

  // Burn: server bills, every day, through the pipeline (misses are recorded, not silent).
  sim.schedules.define({ id: "burn", payer: founder.id, amount: 9000, everyDays: 1, reason: "burn:server" }); // [OK] schedule with a visible miss policy
  // Angel funding: random inflow.
  sim.events.define({
    id: "angel",
    probability: 0.03,
    cooldownDays: 20,
    effect: (ctx) => ctx.getPlayer(founder.id).wallet.credit(150000, { reason: "funding:angel" }),
  }); // [WORKAROUND] events can only address a player by id captured in a closure
  // Competitor launch: lower the company's income.
  sim.events.define({
    id: "competitor-launch",
    probability: 0.02,
    effect: () => {
      const acme = sim.businesses.get("acme");
      acme.dailyIncome = Math.round(acme.dailyIncome * 0.8);
    },
  }); // [WORKAROUND] direct mutation of business state; not logged, not in the ledger
  return { sim, founder };
}
// === END: STARTUP ===

// === SECTION: UNIVERSITY ===
export async function university(): Promise<{ sim: Sim; student: Player }> {
  const sim = createSimulation({
    gameId: "exp-uni",
    seed: 9,
    startingCash: 50000, // [OK]
    entities: [
      { id: "cs101", kind: "course", name: "CS101", attributes: { capacity: 40, enrolled: 0 } },
    ], // [OK] a course is a generic entity, not a job
    locations: [
      { id: "campus", travelCost: 0, travelTimeMinutes: 10 }, // [OK]
      { id: "hostel", travelCost: 0, travelTimeMinutes: 5 }, // [OK]
    ],
    npcs: [{ id: "roommate", location: "hostel", dialogue: ["Did you eat?"] }], // [OK] social
    items: [{ id: "textbook", price: 8000 }], // [OK] purchases
  });
  const student = await sim.players.create({ name: "Student", location: "hostel" });
  sim.execute(student.id, "enrol", { target: "cs101" }); // [OK] enrolment is an action on a course entity

  // Study is a custom action on a course: requirement, time, energy, and a progression stat.
  sim.defineAction({
    id: "study",
    description: "Study the enrolled course.",
    targetKind: "course",
    requires: [
      {
        id: "enrolled",
        check: ({ actor, target }) =>
          actor.enrolments[target!.id] ? null : `Not enrolled in ${target!.name}`,
      },
      requirements.hasEnergy(15, "Too tired to study."),
    ],
    execute({ actor, target }) {
      actor.hooks.advanceMinutes(240);
      actor.adjustEnergy(-15);
      actor.progression.addStat(`grade:${target!.id}`, 2);
    },
  }); // [OK] custom action on a generic entity, through the pipeline

  // Tuition every 60 days, hostel rent monthly: both recurring obligations.
  sim.schedules.define({ id: "tuition", payer: student.id, amount: 40000, everyDays: 60, reason: "tuition" }); // [OK] schedule
  sim.schedules.define({ id: "hostel-rent", payer: student.id, amount: 15000, everyDays: 30, reason: "rent:hostel" }); // [OK] schedule
  // Exam every 30 days: pass if the grade is high enough. Reads a progression stat.
  sim.events.define({
    id: "exam",
    probability: 1,
    condition: (ctx) => ctx.day % 30 === 0,
    effect: () => {
      const passed = student.progression.getStat("grade:cs101") >= 20;
      student.progression.setStat("passed:cs101", passed ? 1 : 0);
    },
  }); // [WORKAROUND] event effects get a restricted player view with no progression access; a closure is used
  // [MISSING] grades decay, courses have credits or prerequisites, and there is no transcript concept.
  // [MISSING] stipends need payer-less (minting) schedules; obligations always debit someone.
  return { sim, student };
}
// === END: UNIVERSITY ===

// === SECTION: SCENARIOS ===
export async function run(): Promise<void> {
  const L = await lagosLife();
  for (let d = 0; d < 30; d++) {
    if (L.player.energy < 30) L.player.sleep(8);
    try {
      L.player.work();
    } catch {
      // refusal is recorded; the scenario keeps going
    }
    L.sim.advanceDays(1);
  }
  L.player.eat();
  L.player.travel("lekki");

  const S = await startup();
  for (let d = 0; d < 60; d++) {
    S.sim.advanceDays(1);
    if (d % 7 === 6) {
      try {
        S.sim.collectIncome(S.founder.id, "acme");
      } catch {
        // nothing to collect yet
      }
      try {
        S.sim.execute(S.founder.id, "payroll", { target: "acme" });
      } catch {
        // unaffordable payroll is refused and recorded
      }
    }
  }

  const U = await university();
  for (let d = 0; d < 60; d++) {
    if (U.student.energy < 30) U.student.sleep(8);
    try {
      U.sim.execute(U.student.id, "study", { target: "cs101" });
    } catch {
      // refusal recorded
    }
    U.sim.advanceDays(1);
  }

  const failed = (sim: Sim): number => sim.eventLog.filter((e) => e.type === "EVENT_EFFECT_FAILED").length;
  console.log("\nSCENARIO RESULTS");
  console.log("Failed event effects (silent before the fix, logged after):",
    { lagos: failed(L.sim), startup: failed(S.sim), university: failed(U.sim) });
  console.log("Lagos Life  balance:", L.player.wallet.balance, "refusals:",
    L.sim.causalRecords().filter((c) => c.outcome === "refused").length);
  console.log("Startup     balance:", S.founder.wallet.balance, "income events:",
    S.sim.eventLog.filter((e) => e.type === "BUSINESS_INCOME").length,
    "burn debits recorded:", S.founder.wallet.history.filter((t) => t.reason === "burn:server").length,
    "payroll runs:", S.sim.eventLog.filter((e) => e.type === "PAYROLL_PAID").length);
  console.log("University  grade:", U.student.progression.getStat("grade:cs101"),
    "passed:", U.student.progression.getStat("passed:cs101"),
    "balance:", U.student.wallet.balance);
  console.log("University  explain:", JSON.stringify(U.sim.explain(U.student.id).lines.map((l) => [l.category, l.net])));
  console.log("Startup     explain:", JSON.stringify(S.sim.explain(S.founder.id).lines.map((l) => [l.category, l.net])));
}
// === END: SCENARIOS ===
