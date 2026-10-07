export type CurrencyCode = string;

export interface SimConfig {
  gameId: string;
  /** e.g. "NGN" */
  currency?: CurrencyCode;
  /** Deterministic seed. Same seed + same actions = same event sequence. */
  seed?: number | string;
  startingCash?: number;
  startingEnergy?: number;
  startingLocation?: string;
}

export interface CreatePlayerOptions {
  name: string;
  startingCash?: number;
  location?: string;
}

export interface LocationDef {
  id: string;
  name?: string;
  /** Cost in game currency to travel TO this location */
  travelCost?: number;
  /** Minutes it takes to travel TO this location */
  travelTimeMinutes?: number;
}

export interface JobDef {
  id: string;
  name?: string;
  salary: number;
  /** Monthly salary in game currency */
  location?: string;
  workingHours?: number;
  energyCost?: number;
  requirements?: Record<string, number>;
}

export interface TransactionMeta {
  reason?: string;
  day?: number;
  time?: string;
  [key: string]: unknown;
}
