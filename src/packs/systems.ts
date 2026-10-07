import type { Pack } from "./worlds.js";

export const SYSTEM_NYSC: Pack = {
  id: "system-nysc",
  kind: "system",
  name: "NYSC System",
  description: "National Youth Service year: monthly allowee, CDS days, clearance wahala.",
  jobs: [
    { id: "corper", name: "Corper (NYSC)", salary: 77000, workingHours: 6, energyCost: 22 },
  ],
  events: [
    { id: "nysc-allowee", name: "Allowee Day", probability: 0.04 },
    { id: "nysc-clearance", name: "Clearance Wahala", probability: 0.03, cooldownDays: 20 },
  ],
};

export const SYSTEM_UNIVERSITY: Pack = {
  id: "system-university",
  kind: "system",
  name: "University System",
  description: "Campus life: school fees due, exams season, strike risk.",
  locations: [
    { id: "campus", name: "Campus", travelCost: 200, travelTimeMinutes: 20 },
    { id: "hostel", name: "Hostel", travelCost: 100, travelTimeMinutes: 10 },
  ],
  jobs: [
    { id: "student", name: "Student", salary: 30000, workingHours: 6, energyCost: 20 },
  ],
  events: [
    { id: "school-fees", name: "School Fees Due", probability: 0.03, cooldownDays: 60 },
    { id: "exams", name: "Exams Season", probability: 0.05, cooldownDays: 40 },
    { id: "asu-strike", name: "ASUU Strike", probability: 0.01, cooldownDays: 120 },
  ],
};

export const SYSTEM_MARKET: Pack = {
  id: "system-market",
  kind: "system",
  name: "Market System",
  description: "Balogun-style trading dynamics: market boom, price crash, owambe season.",
  events: [
    { id: "market-boom", name: "Market Boom", probability: 0.04 },
    { id: "price-crash", name: "Price Crash", probability: 0.02, cooldownDays: 30 },
    { id: "owambe", name: "Owambe Season", probability: 0.05 },
  ],
};
