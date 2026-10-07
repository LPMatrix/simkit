/** Relationship score (0+) per NPC, with named levels. */
export class Relationships {
  scores: Record<string, number> = {};

  score(npcId: string): number {
    return this.scores[npcId] ?? 0;
  }

  adjust(npcId: string, delta: number): number {
    const next = Math.max(0, this.score(npcId) + delta);
    this.scores[npcId] = next;
    return next;
  }

  level(npcId: string): string {
    const s = this.score(npcId);
    if (s >= 100) return "family";
    if (s >= 60) return "close-padi";
    if (s >= 30) return "padi";
    if (s >= 10) return "acquaintance";
    return "stranger";
  }

  toJSON(): Record<string, number> {
    return { ...this.scores };
  }

  static fromJSON(json?: Record<string, number> | null): Relationships {
    const r = new Relationships();
    r.scores = { ...(json ?? {}) };
    return r;
  }
}
