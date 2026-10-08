import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import {
  ActionRefused,
  createSimulation,
  createSimulationFromConfig,
  EntityRegistry,
  parseGameConfig,
  requirements,
  Sim,
} from "../src/index.js";
import { GameRegistry } from "../server/registry.js";
import { createHttpServer } from "../server/http.js";

function campus(): Sim {
  return createSimulation({
    gameId: "campus",
    seed: 5,
    startingCash: 100000,
    locations: [{ id: "campus", travelCost: 0, travelTimeMinutes: 10 }],
    entities: [
      { id: "cs101", kind: "course", name: "CS101", attributes: { capacity: 2, enrolled: 0, fee: 20000 } },
      { id: "art200", kind: "course", name: "ART200", attributes: { capacity: 40, enrolled: 0 } },
      { id: "kiosk", kind: "business", name: "Kiosk" },
    ],
  });
}

describe("entity registry", () => {
  it("defines, looks up by kind, and lists by kind", () => {
    const reg = new EntityRegistry();
    reg.define({ id: "cs101", kind: "course", attributes: { capacity: 30 } });
    reg.define({ id: "kiosk", kind: "business" });
    expect(reg.get("cs101", "course").attributes.capacity).toBe(30);
    expect(reg.list("course").map((e) => e.id)).toEqual(["cs101"]);
    expect(reg.list().length).toBe(2);
  });

  it("treats unknown and wrong-kind ids as 404 request errors", () => {
    const reg = new EntityRegistry();
    reg.define({ id: "kiosk", kind: "business" });
    expect(() => reg.get("ghost")).toThrow(/Unknown entity: ghost/);
    expect(() => reg.get("kiosk", "course")).toThrow(/Unknown course: kiosk/);
    try {
      reg.get("kiosk", "course");
    } catch (err) {
      expect((err as { status: number }).status).toBe(404);
    }
  });

  it("rejects duplicates and missing fields as 400", () => {
    const reg = new EntityRegistry();
    reg.define({ id: "a", kind: "course" });
    expect(() => reg.define({ id: "a", kind: "course" })).toThrow(/already defined/);
    expect(() => reg.define({ id: "b", kind: "" })).toThrow(/must have a kind/);
    expect(() => reg.define({ id: "", kind: "course" })).toThrow(/must have an id/);
  });
});

describe("targeted actions", () => {
  it("requires a target for targetKind actions", async () => {
    const sim = campus();
    const s = await sim.players.create({ name: "S" });
    expect(() => sim.execute(s.id, "enrol")).toThrow(/target \(string\) is required/);
    expect(() => sim.execute(s.id, "enrol", { target: "ghost" })).toThrow(/Unknown course: ghost/);
    expect(() => sim.execute(s.id, "enrol", { target: "kiosk" })).toThrow(/Unknown course: kiosk/);
  });

  it("enrols, charges the fee through the ledger, and takes a seat", async () => {
    const sim = campus();
    const s = await sim.players.create({ name: "S" });
    sim.execute(s.id, "enrol", { target: "cs101" });

    expect(s.enrolments.cs101).toBe(true);
    expect(sim.entities.get("cs101").attributes.enrolled).toBe(1);
    expect(s.wallet.balance).toBe(100000 - 20000);
    const record = sim.causalRecords().at(-1);
    expect(record).toMatchObject({ actionId: "enrol", outcome: "ok", inputs: { target: "cs101" } });
    expect(s.wallet.history.at(-1)).toMatchObject({ reason: "tuition:cs101", amount: 20000 });
    expect(s.wallet.history.at(-1)?.meta?.causeId).toBe(record?.id);
  });

  it("refuses double enrolment, full courses, and unaffordable fees", async () => {
    const sim = campus();
    const a = await sim.players.create({ name: "A" });
    const b = await sim.players.create({ name: "B" });
    const c = await sim.players.create({ name: "C", startingCash: 5000 });
    sim.entities.define({ id: "dear", kind: "course", attributes: { fee: 999999 } });
    sim.execute(a.id, "enrol", { target: "cs101" });

    expect(() => sim.execute(a.id, "enrol", { target: "cs101" })).toThrow(/Already enrolled in CS101/);
    sim.execute(b.id, "enrol", { target: "cs101" }); // seat 2 of 2
    expect(() => sim.execute(c.id, "enrol", { target: "cs101" })).toThrow(/is full/);
    expect(() => sim.execute(c.id, "enrol", { target: "dear" })).toThrow(/Insufficient funds/);

    const refused = sim.causalRecords().filter((r) => r.outcome === "refused").map((r) => r.reasons[0]);
    expect(refused).toEqual(expect.arrayContaining([
      "Already enrolled in CS101",
      "CS101 is full",
    ]));
  });

  it("a developer-defined action can target a course", async () => {
    const sim = campus();
    sim.defineAction({
      id: "study",
      targetKind: "course",
      requires: [
        {
          id: "enrolled",
          check: ({ actor, target }) => (actor.enrolments[target!.id] ? null : `Not enrolled in ${target!.name}`),
        },
        requirements.hasEnergy(15, "Too tired to study."),
      ],
      execute({ actor, target }) {
        actor.hooks.advanceMinutes(240);
        actor.adjustEnergy(-15);
        actor.progression.addStat(`grade:${target!.id}`, 2);
      },
    });
    const s = await sim.players.create({ name: "S" });
    expect(() => sim.execute(s.id, "study", { target: "art200" })).toThrow(/Not enrolled in ART200/);
    sim.execute(s.id, "enrol", { target: "art200" });
    sim.execute(s.id, "study", { target: "art200" });
    expect(s.progression.getStat("grade:art200")).toBe(2);
    expect(sim.replay({ actorId: s.id }).find((t) => t.actionId === "study")?.inputs).toEqual({ target: "art200" });
  });

  it("refusals carry the target-aware message", async () => {
    const sim = campus();
    const s = await sim.players.create({ name: "S" });
    try {
      sim.execute(s.id, "enrol", { target: "cs101" });
      sim.execute(s.id, "enrol", { target: "cs101" });
      throw new Error("should refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(ActionRefused);
      expect((err as ActionRefused).reasons).toEqual(["Already enrolled in CS101"]);
    }
  });
});

describe("entities persist and load from config", () => {
  it("survives snapshot round-trips with enrolments and seat counts", async () => {
    const sim = campus();
    const s = await sim.players.create({ name: "S" });
    sim.execute(s.id, "enrol", { target: "cs101" });
    const restored = Sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.entities.get("cs101", "course").attributes.enrolled).toBe(1);
    expect(restored.players.get(s.id).enrolments.cs101).toBe(true);
    expect(restored.entities.list("business").map((e) => e.id)).toEqual(["kiosk"]);
  });

  it("loads course entities from a YAML config", () => {
    const cfg = parseGameConfig(`
gameId: yaml-campus
entities:
  - id: phy101
    kind: course
    name: PHY101
    attributes:
      capacity: 25
      enrolled: 0
`);
    const { sim } = createSimulationFromConfig(cfg);
    expect(sim.entities.get("phy101", "course").name).toBe("PHY101");
  });
});

describe("entities over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  const apiKey = "entity-key";

  beforeAll(async () => {
    const registry = new GameRegistry(null);
    await registry.init();
    await registry.create({ gameId: "uni", seed: 3, locations: [{ id: "campus", travelCost: 0, travelTimeMinutes: 5 }] });
    server = createHttpServer(registry, { apiKeys: new Set([apiKey]), required: true });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("defines a course, enrols through the generic action endpoint, and reports 404 for unknown targets", async () => {
    const headers = { "x-api-key": apiKey, "content-type": "application/json" };
    const created = await fetch(`${baseUrl}/v1/games/uni/entities`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "course", id: "bio101", name: "BIO101", attributes: { capacity: 10, enrolled: 0 } }),
    });
    expect(created.status).toBe(201);

    const list = await (await fetch(`${baseUrl}/v1/games/uni/entities?kind=course`, { headers })).json();
    expect(list.entities.map((e: { id: string }) => e.id)).toEqual(["bio101"]);

    const p = await (await fetch(`${baseUrl}/v1/games/uni/players`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ngozi", location: "campus" }),
    })).json();

    const enrol = await fetch(`${baseUrl}/v1/games/uni/players/${p.id}/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "enrol", target: "bio101" }),
    });
    expect(enrol.status).toBe(200);
    expect((await enrol.json()).player.enrolments).toEqual({ bio101: true });

    const missing = await fetch(`${baseUrl}/v1/games/uni/players/${p.id}/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "enrol", target: "nope" }),
    });
    expect(missing.status).toBe(404);

    const again = await fetch(`${baseUrl}/v1/games/uni/players/${p.id}/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "enrol", target: "bio101" }),
    });
    expect(again.status).toBe(400); // refusal
  });
});
