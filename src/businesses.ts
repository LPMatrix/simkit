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
  ownerId: string | null;
  lastCollectedDay: number;
}

/**
 * Player-owned businesses: buy once, collect income per day.
 * Ownership lives on the business so stakes can move between players.
 */
export class BusinessManager {
  private businesses = new Map<string, Business>();

  define(def: BusinessDef): Business {
    if (!def.id) throw new Error("Business must have an id");
    const existing = this.businesses.get(def.id);
    const biz: Business = {
      id: def.id,
      name: def.name ?? existing?.name ?? def.id,
      location: def.location ?? existing?.location,
      cost: def.cost,
      dailyIncome: def.dailyIncome,
      ownerId: existing?.ownerId ?? null,
      lastCollectedDay: existing?.lastCollectedDay ?? 0,
    };
    this.businesses.set(biz.id, biz);
    return biz;
  }

  get(id: string): Business {
    const biz = this.businesses.get(id);
    if (!biz) throw new Error(`Unknown business: ${id}`);
    return biz;
  }

  has(id: string): boolean {
    return this.businesses.has(id);
  }

  list(): Business[] {
    return [...this.businesses.values()];
  }

  ownedBy(playerId: string): Business[] {
    return this.list().filter((b) => b.ownerId === playerId);
  }

  toJSON(): Business[] {
    return this.list();
  }

  static fromJSON(json: Business[]): BusinessManager {
    const m = new BusinessManager();
    for (const biz of json ?? []) {
      m.businesses.set(biz.id, { ...biz });
    }
    return m;
  }
}
