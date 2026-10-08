import { createSimulation, resetTxCounter, Sim } from "../src/index.js";

/** Canonical reference scenario. Any behavior change moves its fingerprint. */
export async function lagosScenario(seed: number): Promise<Sim> {
  resetTxCounter();
  const sim = createSimulation({
    gameId: "lagos-life",
    currency: "NGN",
    seed,
    startingCash: 50000,
    locations: [
      { id: "yaba", travelCost: 500, travelTimeMinutes: 30 },
      { id: "ikeja", travelCost: 1000, travelTimeMinutes: 60 },
      { id: "lekki", travelCost: 2000, travelTimeMinutes: 90 },
    ],
    jobs: [{ id: "danfo-driver", salary: 150000, workingHours: 10, energyCost: 35 }],
    items: [{ id: "amala", price: 1500, energy: 30 }],
    npcs: [{ id: "mama-put", location: "yaba", dialogue: ["Pay first.", "Next!"] }],
    events: [
      {
        id: "fuel-crisis",
        probability: 0.05,
        effect: (ctx) => {
          ctx.priceModifiers.transport = (ctx.priceModifiers.transport ?? 1) * 1.25;
        },
      },
    ],
  });
  const ada = await sim.players.create({ name: "Ada", location: "yaba" });
  ada.acceptJob("danfo-driver");
  for (let d = 0; d < 30; d++) {
    if (ada.energy < 40) ada.sleep(8);
    try {
      ada.work();
    } catch {
      // refusal recorded; the scenario continues
    }
    sim.advanceDays(1);
  }
  ada.eat();
  ada.buy("amala", 1);
  sim.talk(ada.id, "mama-put");
  return sim;
}

