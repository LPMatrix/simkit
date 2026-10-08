import { EntityRegistry, type Entity } from "./entities.js";
import { invalidInput } from "./runtime/action.js";

export interface BusinessDef {
  id: string;
  name?: string;
  location?: string;
  /** Purchase price. */
  cost: number;
  /** Income per game day once owned. */
  dailyIncome: number;
}

export interface Business extends BusinessDef {
  name: string;
  /** Entity id of the owner (a player id today, any entity id in future). */
  ownerId: string | null;
  lastCollectedDay: number;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Player-owned businesses: buy once, collect income per day.
 *
 * A typed view over the entity registry: every business is a `business`
 * entity, and ownership is an `ownerId` attribute holding an entity
 * reference. All reads and writes go through the registry, so there is a
 * single source of truth for businesses.
 */
export class BusinessManager {
  constructor(private entities: EntityRegistry) {}

  define(def: BusinessDef): Business {
    if (!def.id) throw new Error("Business must have an id");
    const existing = this.entities.has(def.id) ? this.entities.get(def.id) : undefined;
    if (existing && existing.kind !== "business") {
      throw invalidInput(`Entity ${def.id} is a ${existing.kind}, not a business`);
    }
    if (existing) {
      if (def.name !== undefined) existing.name = def.name;
      existing.attributes.location = def.location ?? existing.attributes.location ?? null;
      existing.attributes.cost = def.cost;
      existing.attributes.dailyIncome = def.dailyIncome;
      return this.view(existing);
    }
    this.entities.define({
      id: def.id,
      kind: "business",
      name: def.name ?? def.id,
      attributes: {
        location: def.location ?? null,
        cost: def.cost,
        dailyIncome: def.dailyIncome,
        ownerId: null,
        lastCollectedDay: 0,
      },
    });
    return this.view(this.entities.get(def.id));
  }

  /** Live view: writes through to the entity's attributes. */
  private view(entity: Entity): Business {
    return {
      id: entity.id,
      get name(): string {
        return entity.name;
      },
      set name(v: string) {
        entity.name = v;
      },
      get location(): string | undefined {
        return optionalStr(entity.attributes.location);
      },
      set location(v: string | undefined) {
        entity.attributes.location = v ?? null;
      },
      get cost(): number {
        return num(entity.attributes.cost, 0);
      },
      set cost(v: number) {
        entity.attributes.cost = v;
      },
      get dailyIncome(): number {
        return num(entity.attributes.dailyIncome, 0);
      },
      set dailyIncome(v: number) {
        entity.attributes.dailyIncome = v;
      },
      get ownerId(): string | null {
        const v = entity.attributes.ownerId;
        return typeof v === "string" ? v : null;
      },
      set ownerId(v: string | null) {
        entity.attributes.ownerId = v;
      },
      get lastCollectedDay(): number {
        return num(entity.attributes.lastCollectedDay, 0);
      },
      set lastCollectedDay(v: number) {
        entity.attributes.lastCollectedDay = v;
      },
    };
  }

  get(id: string): Business {
    return this.view(this.entities.get(id, "business"));
  }

  has(id: string): boolean {
    return this.entities.has(id, "business");
  }

  list(): Business[] {
    return this.entities.list("business").map((e) => this.view(e));
  }

  ownedBy(ownerId: string): Business[] {
    return this.list().filter((b) => b.ownerId === ownerId);
  }

  toJSON(): Business[] {
    return this.list().map((b) => ({ ...b }));
  }

  /** Legacy import: old snapshots carry a businesses array without entities. */
  importLegacy(json: Business[]): void {
    for (const biz of json ?? []) {
      if (this.entities.has(biz.id)) continue;
      this.entities.define({
        id: biz.id,
        kind: "business",
        name: biz.name,
        attributes: {
          location: biz.location ?? null,
          cost: biz.cost,
          dailyIncome: biz.dailyIncome,
          ownerId: biz.ownerId,
          lastCollectedDay: biz.lastCollectedDay,
        },
      });
    }
  }
}
