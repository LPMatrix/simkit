import { invalidInput } from "./runtime/action.js";

/** Scalar attribute values only, so entities serialize cleanly and compare predictably. */
export type AttributeValue = number | string | boolean | null;

export interface EntityDef {
  id: string;
  /** What kind of thing this is: "course", "business", "vehicle", anything a game needs. */
  kind: string;
  name?: string;
  attributes?: Record<string, AttributeValue>;
}

export interface Entity {
  id: string;
  kind: string;
  name: string;
  attributes: Record<string, AttributeValue>;
}

/**
 * Generic store for simulated things that are not players. Actions reach them
 * through `targetKind` (see ActionDef) rather than through bespoke managers.
 */
export class EntityRegistry {
  private byId = new Map<string, Entity>();

  define(def: EntityDef): Entity {
    if (!def.id || typeof def.id !== "string") throw invalidInput("Entity must have an id");
    if (!def.kind || typeof def.kind !== "string") throw invalidInput(`Entity ${def.id} must have a kind`);
    if (this.byId.has(def.id)) throw invalidInput(`Entity already defined: ${def.id}`);
    const entity: Entity = {
      id: def.id,
      kind: def.kind,
      name: def.name ?? def.id,
      attributes: { ...(def.attributes ?? {}) },
    };
    this.byId.set(entity.id, entity);
    return entity;
  }

  /** Look up an entity, optionally requiring a kind. Unknown or wrong-kind ids are request errors (404). */
  get(id: string, kind?: string): Entity {
    const entity = this.byId.get(id);
    if (!entity || (kind !== undefined && entity.kind !== kind)) {
      throw Object.assign(new Error(`Unknown ${kind ?? "entity"}: ${id}`), { status: 404 });
    }
    return entity;
  }

  has(id: string, kind?: string): boolean {
    const entity = this.byId.get(id);
    return !!entity && (kind === undefined || entity.kind === kind);
  }

  list(kind?: string): Entity[] {
    return [...this.byId.values()].filter((e) => kind === undefined || e.kind === kind);
  }

  toJSON(): Entity[] {
    return this.list().map((e) => ({ ...e, attributes: { ...e.attributes } }));
  }

  static fromJSON(json: Entity[] | undefined): EntityRegistry {
    const registry = new EntityRegistry();
    for (const e of json ?? []) {
      registry.byId.set(e.id, { ...e, attributes: { ...e.attributes } });
    }
    return registry;
  }
}
