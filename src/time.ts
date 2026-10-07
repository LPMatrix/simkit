export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export interface GameTimeJSON {
  day: number;
  minuteOfDay: number;
}

/** Independent simulation clock. World progresses in game-time, not real-time. */
export class GameClock {
  day: number;
  minuteOfDay: number;

  constructor(day = 1, minuteOfDay = 8 * 60) {
    this.day = day;
    this.minuteOfDay = minuteOfDay;
  }

  get weekday(): Weekday {
    return WEEKDAYS[(this.day - 1) % 7];
  }

  get hour(): number {
    return Math.floor(this.minuteOfDay / 60);
  }

  get minute(): number {
    return this.minuteOfDay % 60;
  }

  get timeLabel(): string {
    const h = String(this.hour).padStart(2, "0");
    const m = String(this.minute).padStart(2, "0");
    return `${h}:${m}`;
  }

  label(): string {
    return `Day ${this.day} (${this.weekday}) ${this.timeLabel}`;
  }

  advanceMinutes(minutes: number): void {
    if (minutes < 0) throw new Error("Cannot go back in game time");
    this.minuteOfDay += minutes;
    while (this.minuteOfDay >= 24 * 60) {
      this.minuteOfDay -= 24 * 60;
      this.day += 1;
    }
  }

  advanceHours(hours: number): void {
    this.advanceMinutes(Math.round(hours * 60));
  }

  advanceDays(days: number): void {
    this.advanceMinutes(days * 24 * 60);
  }

  sleep(hours = 8): void {
    this.advanceHours(hours);
  }

  toJSON(): GameTimeJSON {
    return { day: this.day, minuteOfDay: this.minuteOfDay };
  }

  static fromJSON(json: GameTimeJSON): GameClock {
    return new GameClock(json.day, json.minuteOfDay);
  }
}
