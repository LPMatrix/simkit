import type { LocationDef } from "./types.js";

export interface Location extends Required<Pick<LocationDef, "id">> {
  name: string;
  travelCost: number;
  travelTimeMinutes: number;
}

/** World graph: locations + travel costs/times. */
export class World {
  private locations = new Map<string, Location>();

  constructor(defs: (string | LocationDef)[] = []) {
    for (const d of defs) this.define(d);
  }

  define(def: string | LocationDef): Location {
    const normalized: Location =
      typeof def === "string"
        ? { id: def, name: def, travelCost: 0, travelTimeMinutes: 30 }
        : {
            id: def.id,
            name: def.name ?? def.id,
            travelCost: def.travelCost ?? 0,
            travelTimeMinutes: def.travelTimeMinutes ?? 30,
          };
    this.locations.set(normalized.id, normalized);
    return normalized;
  }

  get(id: string): Location {
    const loc = this.locations.get(id);
    if (!loc) throw new Error(`Unknown location: ${id}`);
    return loc;
  }

  has(id: string): boolean {
    return this.locations.has(id);
  }

  list(): Location[] {
    return [...this.locations.values()];
  }

  toJSON(): Location[] {
    return this.list();
  }

  static fromJSON(json: Location[]): World {
    const w = new World();
    for (const loc of json) w.define(loc);
    return w;
  }
}
