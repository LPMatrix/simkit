export interface ItemDef {
  id: string;
  name?: string;
  /** Buy price in game currency. Sells back at 50%. */
  price: number;
  /** Energy restored on use. */
  energy?: number;
  /** Health restored on use. */
  health?: number;
  /** Custom needs restored on use, by need id. Unknown ids fail at use time. */
  restores?: Record<string, number>;
  description?: string;
}

export interface Item extends ItemDef {
  name: string;
}

export class ItemCatalog {
  private items = new Map<string, Item>();

  define(def: ItemDef): Item {
    if (!def.id) throw new Error("Item must have an id");
    const item: Item = {
      id: def.id,
      name: def.name ?? def.id,
      price: def.price ?? 0,
      energy: def.energy,
      health: def.health,
      restores: def.restores ? { ...def.restores } : undefined,
      description: def.description,
    };
    this.items.set(item.id, item);
    return item;
  }

  get(id: string): Item {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown item: ${id}`);
    return item;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  list(): Item[] {
    return [...this.items.values()];
  }

  toJSON(): Item[] {
    return this.list();
  }

  static fromJSON(json: Item[]): ItemCatalog {
    const c = new ItemCatalog();
    for (const item of json) c.define(item);
    return c;
  }
}

export interface InventoryJSON {
  items: Record<string, number>;
}

/** Player-held items: buy / use / sell. Quantities only — defs live in ItemCatalog. */
export class Inventory {
  items: Record<string, number> = {};

  count(itemId: string): number {
    return this.items[itemId] ?? 0;
  }

  add(itemId: string, qty = 1): void {
    if (qty <= 0) throw new Error("Quantity must be positive");
    this.items[itemId] = this.count(itemId) + qty;
  }

  remove(itemId: string, qty = 1): void {
    if (this.count(itemId) < qty) {
      throw new Error(`Not enough ${itemId}: have ${this.count(itemId)}, need ${qty}`);
    }
    const next = this.count(itemId) - qty;
    if (next === 0) delete this.items[itemId];
    else this.items[itemId] = next;
  }

  toJSON(): InventoryJSON {
    return { items: { ...this.items } };
  }

  static fromJSON(json?: InventoryJSON | null): Inventory {
    const inv = new Inventory();
    inv.items = { ...(json?.items ?? {}) };
    return inv;
  }
}
