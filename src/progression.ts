/** Generic progression: skills, xp/levels, achievements. */

export interface ProgressionJSON {
  stats: Record<string, number>;
  xp: number;
  achievements: string[];
}

export class Progression {
  stats: Record<string, number> = {};
  xp = 0;
  achievements: Set<string> = new Set();

  constructor(initial: Partial<ProgressionJSON> = {}) {
    this.stats = { ...(initial.stats ?? {}) };
    this.xp = initial.xp ?? 0;
    this.achievements = new Set(initial.achievements ?? []);
  }

  get level(): number {
    return Math.floor(Math.sqrt(this.xp / 100)) + 1;
  }

  getStat(name: string): number {
    return this.stats[name] ?? 0;
  }

  setStat(name: string, value: number): void {
    this.stats[name] = value;
  }

  addStat(name: string, delta: number): number {
    const next = this.getStat(name) + delta;
    this.stats[name] = next;
    return next;
  }

  addXp(amount: number): number {
    this.xp += amount;
    return this.xp;
  }

  meets(requirements: Record<string, number>): boolean {
    return Object.entries(requirements).every(
      ([skill, min]) => this.getStat(skill) >= min,
    );
  }

  unlock(achievementId: string): boolean {
    if (this.achievements.has(achievementId)) return false;
    this.achievements.add(achievementId);
    return true;
  }

  has(achievementId: string): boolean {
    return this.achievements.has(achievementId);
  }

  toJSON(): ProgressionJSON {
    return {
      stats: { ...this.stats },
      xp: this.xp,
      achievements: [...this.achievements],
    };
  }

  static fromJSON(json: ProgressionJSON): Progression {
    return new Progression(json);
  }
}
