/** Seeded deterministic RNG (mulberry32). Avoid Math.random() inside simulation. */

export function hashSeedString(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

export class SeededRng {
  private state: number;

  constructor(seed: number | string) {
    this.state = typeof seed === "string" ? hashSeedString(seed) : seed >>> 0;
    if (this.state === 0) this.state = 0xdeadbeef;
  }

  /** Raw next uint32 */
  nextUint32(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Float in [0, 1) */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("Cannot pick from empty array");
    return arr[this.int(0, arr.length - 1)];
  }

  getState(): number {
    return this.state >>> 0;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }
}
