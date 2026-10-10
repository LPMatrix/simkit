import { describe, expect, it } from "vitest";
import { ActionRefused, createSimulation, Sim } from "../src/index.js";

/**
 * Framework proof (upgrade plan P0): one scenario exercising the full
 * vertical slice — refusal, successful transition, event/ledger linkage,
 * replay, snapshot/restore — against the public API only.
 */
describe("framework proof slice", () => {
  async function setup(): Promise<{ sim: Sim; playerId: string }> {
    const sim = createSimulation({
      gameId: "proof",
      seed: 42,
      startingCash: 20000,
      locations: [
        { id: "home", travelCost: 0, travelTimeMinutes: 5 },
        { id: "yaba", travelCost: 500, travelTimeMinutes: 30 },
      ],
      jobs: [{ id: "danfo-driver", salary: 150000, workingHours: 10, energyCost: 35 }],
    });
    sim.events.define({
      id: "fuel-crisis",
      probability: 1,
      effect: (ctx) => {
        ctx.priceModifiers.transport = 2;
      },
    });
    const player = await sim.players.create({ name: "Ada", location: "home" });
    player.acceptJob("danfo-driver");
    return { sim, playerId: player.id };
  }

  it("refusal, transition, linkage, replay, and restore hold together", async () => {
    const { sim, playerId } = await setup();
    const player = sim.players.get(playerId);

    // 1. Refusal moves nothing and is recorded with its reason.
    player.adjustEnergy(-95);
    expect(() => player.work()).toThrow(ActionRefused);
    expect(player.wallet.balance).toBe(20000);
    expect(sim.causalRecords().at(-1)).toMatchObject({ actionId: "work", outcome: "refused" });

    // 2. Successful transition: salary lands, linked to its cause.
    player.sleep(8);
    expect(player.work()).toBe(5000);
    const salary = player.wallet.history.at(-1);
    expect(salary).toMatchObject({ type: "credit", amount: 5000 });
    const workCause = sim.causalRecords().at(-1);
    expect(workCause).toMatchObject({ actionId: "work", outcome: "ok" });
    expect(salary?.meta?.causeId).toBe(workCause?.id);

    // 3. Event/ledger linkage: the crisis fires, travel costs more and says why.
    sim.advanceDays(1);
    player.travel("yaba");
    expect(player.wallet.balance).toBe(20000 + 5000 - 1000);
    const travel = sim.causalRecords().at(-1);
    expect(travel?.links[0].label).toContain("EVENT:fuel-crisis");

    // 4. Replay shows the chain; explain names the trigger.
    const trace = sim.replay({ actorId: playerId });
    expect(trace.map((t) => [t.actionId, t.outcome])).toEqual([
      ["accept-job", "ok"],
      ["work", "refused"],
      ["sleep", "ok"],
      ["work", "ok"],
      ["travel", "ok"],
    ]);
    const graph = sim.replayGraph({ actorId: playerId });
    expect(graph.edges.some((e) => e.kind === "modifier")).toBe(true);
    const travelLine = sim.explain(playerId).lines.find((l) => l.category === "travel");
    expect(travelLine?.why?.[0]).toContain("EVENT:fuel-crisis");

    // 5. Snapshot/restore preserves it all, and the world keeps working.
    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.replay({ actorId: playerId })).toHaveLength(5);
    expect(restored.explain(playerId).lines.find((l) => l.category === "travel")?.why?.[0]).toContain(
      "EVENT:fuel-crisis",
    );
    const rp = restored.players.get(playerId);
    rp.travel("home"); // free leg: acts and links without charging
    expect(restored.causalRecords()).toHaveLength(6);
    expect(restored.checkInvariants().every((r) => r.ok)).toBe(true);
  });
});
