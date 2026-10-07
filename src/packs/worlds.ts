import type { EventDefinition } from "../events.js";
import type { JobDef, LocationDef } from "../types.js";

/** A marketplace pack: installable world, jobs, or system. */
export interface Pack {
  id: string;
  kind: "world" | "jobs" | "system";
  name: string;
  description: string;
  locations?: (string | LocationDef)[];
  jobs?: JobDef[];
  events?: EventDefinition[];
}

export const WORLD_LAGOS: Pack = {
  id: "world-lagos",
  kind: "world",
  name: "Lagos",
  description: "Nigeria's commercial capital: Yaba, Ikeja, Lekki, Surulere, Victoria Island.",
  locations: [
    { id: "yaba", name: "Yaba", travelCost: 500, travelTimeMinutes: 30 },
    { id: "ikeja", name: "Ikeja", travelCost: 1000, travelTimeMinutes: 60 },
    { id: "lekki", name: "Lekki", travelCost: 2000, travelTimeMinutes: 90 },
    { id: "surulere", name: "Surulere", travelCost: 700, travelTimeMinutes: 40 },
    { id: "vi", name: "Victoria Island", travelCost: 2500, travelTimeMinutes: 100 },
  ],
};

export const WORLD_ILORIN: Pack = {
  id: "world-ilorin",
  kind: "world",
  name: "Ilorin",
  description: "Kwara State capital: slower pace, lower costs, university town.",
  locations: [
    { id: "tanke", name: "Tanke", travelCost: 200, travelTimeMinutes: 20 },
    { id: "gra", name: "GRA", travelCost: 400, travelTimeMinutes: 30 },
    { id: "challenge", name: "Challenge", travelCost: 300, travelTimeMinutes: 25 },
    { id: "unilorin", name: "UNILORIN", travelCost: 350, travelTimeMinutes: 35 },
  ],
};

export const WORLD_ABUJA: Pack = {
  id: "world-abuja",
  kind: "world",
  name: "Abuja",
  description: "Federal capital: high salaries, high rents, civil-service careers.",
  locations: [
    { id: "wuse", name: "Wuse", travelCost: 800, travelTimeMinutes: 30 },
    { id: "garki", name: "Garki", travelCost: 800, travelTimeMinutes: 30 },
    { id: "maitama", name: "Maitama", travelCost: 1500, travelTimeMinutes: 45 },
    { id: "gwagwalada", name: "Gwagwalada", travelCost: 1200, travelTimeMinutes: 60 },
  ],
};
