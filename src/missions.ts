export type MissionGoal =
  | { type: "earn"; target: number }
  | { type: "wealth"; target: number }
  | { type: "level"; target: number }
  | { type: "relationship"; npc: string; target: number }
  | { type: "own"; item: string; count: number };

export interface MissionDef {
  id: string;
  name?: string;
  description?: string;
  goal: MissionGoal;
  /** Cash reward on completion. */
  reward: number;
  xp?: number;
}

export interface Mission extends MissionDef {
  name: string;
}

export interface MissionState {
  accepted: boolean;
  claimed: boolean;
}

/** Structured goals with cash + XP rewards. Progress reads live player state. */
export class MissionManager {
  private missions = new Map<string, Mission>();

  define(def: MissionDef): Mission {
    if (!def.id) throw new Error("Mission must have an id");
    const mission: Mission = {
      id: def.id,
      name: def.name ?? def.id,
      description: def.description,
      goal: def.goal,
      reward: def.reward ?? 0,
      xp: def.xp ?? 20,
    };
    this.missions.set(mission.id, mission);
    return mission;
  }

  get(id: string): Mission {
    const mission = this.missions.get(id);
    if (!mission) throw new Error(`Unknown mission: ${id}`);
    return mission;
  }

  has(id: string): boolean {
    return this.missions.has(id);
  }

  list(): Mission[] {
    return [...this.missions.values()];
  }

  toJSON(): Mission[] {
    return this.list();
  }

  static fromJSON(json: Mission[]): MissionManager {
    const m = new MissionManager();
    for (const mission of json ?? []) m.define(mission);
    return m;
  }
}
