import { createSimulation } from "../src/index.js";

/**
 * Lagos Life Mini — reference game proving the whole loop runs on simkit.
 *
 * UI sketch:
 * ₦52,400 | Yaba | Monday 08:00 | Job: Developer | Energy: 78%
 * [ Go to work ] [ Eat ] [ Travel ] [ Sleep ]
 */
async function main(): Promise<void> {
  const sim = createSimulation({
    gameId: "lagos-life-mini",
    currency: "NGN",
    seed: 42,
    startingCash: 50000,
    locations: [
      { id: "yaba", name: "Yaba", travelCost: 500, travelTimeMinutes: 30 },
      { id: "ikeja", name: "Ikeja", travelCost: 1000, travelTimeMinutes: 60 },
      { id: "lekki", name: "Lekki", travelCost: 2000, travelTimeMinutes: 90 },
      { id: "surulere", name: "Surulere", travelCost: 700, travelTimeMinutes: 40 },
    ],
    jobs: [
      { id: "software-developer", name: "Software Developer", salary: 350000, location: "yaba", workingHours: 8, energyCost: 25, requirements: { coding: 50 } },
      { id: "danfo-driver", name: "Danfo Driver", salary: 150000, workingHours: 10, energyCost: 35 },
      { id: "trader", name: "Trader", salary: 200000, workingHours: 9, energyCost: 30 },
    ],
    events: [
      {
        id: "fuel-crisis",
        name: "Fuel Price Increase",
        probability: 0.05,
        effect: (ctx) => {
          ctx.priceModifiers.transport = (ctx.priceModifiers.transport ?? 1) * 1.25;
        },
      },
      { id: "rent-due", name: "Rent Due", probability: 0.03, cooldownDays: 25 },
      { id: "salary-day", name: "Salary Day", probability: 0.04 },
    ],
  });

  const player = await sim.players.create({ name: "Mubaraq", location: "yaba" });
  player.progression.setStat("coding", 60);
  await player.acceptJob("software-developer");

  const fmt = (): string =>
    `₦${player.wallet.balance.toLocaleString()} | ${player.locationId} | Day ${sim.clock.day} ${sim.clock.weekday} ${sim.clock.timeLabel} | Job: ${player.jobId} | Energy: ${player.energy}%`;

  console.log("START", fmt());
  player.work();
  console.log("WORK ", fmt());
  player.eat();
  console.log("EAT  ", fmt());
  player.travel("lekki");
  console.log("MOVE ", fmt());
  player.sleep();
  console.log("SLEEP", fmt());

  sim.console.giveAll(10_000);
  sim.advanceDays(7);
  console.log("WEEK ", fmt());
  console.log("STATS", sim.stats());
  console.log("LOG  ", sim.replayLog().slice(0, 10));
}

void main();
