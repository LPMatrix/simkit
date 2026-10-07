export interface NpcDef {
  id: string;
  name?: string;
  /** NPCs stay put — players must travel to them to talk. */
  location?: string;
  personality?: string;
  dialogue?: string[];
}

export interface Npc extends NpcDef {
  name: string;
  dialogue: string[];
}

/** Non-player characters: local flavor, talk targets, relationship anchors. */
export class NpcManager {
  private npcs = new Map<string, Npc>();

  define(def: NpcDef): Npc {
    if (!def.id) throw new Error("NPC must have an id");
    const npc: Npc = {
      id: def.id,
      name: def.name ?? def.id,
      location: def.location,
      personality: def.personality,
      dialogue: def.dialogue?.length ? [...def.dialogue] : ["..."],
    };
    this.npcs.set(npc.id, npc);
    return npc;
  }

  get(id: string): Npc {
    const npc = this.npcs.get(id);
    if (!npc) throw new Error(`Unknown NPC: ${id}`);
    return npc;
  }

  has(id: string): boolean {
    return this.npcs.has(id);
  }

  list(): Npc[] {
    return [...this.npcs.values()];
  }

  at(locationId: string): Npc[] {
    return this.list().filter((n) => n.location === locationId);
  }

  toJSON(): Npc[] {
    return this.list();
  }

  static fromJSON(json: Npc[]): NpcManager {
    const m = new NpcManager();
    for (const npc of json) m.define(npc);
    return m;
  }
}
