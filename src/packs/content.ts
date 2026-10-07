import type { Pack } from "./worlds.js";

export const SYSTEM_STARTUP: Pack = {
  id: "system-startup",
  kind: "system",
  name: "Startup System",
  description: "Lagos startup life: ramen profitability, demo days, server bills, and the seed round dream.",
  jobs: [
    { id: "founder", name: "Startup Founder", salary: 50000, workingHours: 12, energyCost: 40 },
    { id: "intern", name: "Startup Intern", salary: 80000, workingHours: 8, energyCost: 25 },
  ],
  events: [
    { id: "demo-day", name: "Demo Day", probability: 0.03, cooldownDays: 60 },
    { id: "server-bill", name: "AWS Bill Shock", probability: 0.04 },
    { id: "angel-interest", name: "Angel Investor Interest", probability: 0.02, cooldownDays: 45 },
  ],
  missions: [
    {
      id: "ramen-profitable",
      name: "Ramen Profitable",
      description: "Earn ₦500,000 total. Then dream of the seed round.",
      goal: { type: "earn", target: 500000 },
      reward: 50000,
    },
  ],
};

export const ASSETS_VEHICLES: Pack = {
  id: "assets-vehicles",
  kind: "assets",
  name: "Lagos Vehicles",
  description: "Ownable rides from okada to Benz. Status you can park.",
  items: [
    { id: "okada", name: "Okada (motorcycle)", price: 350000, description: "Weave through traffic like a legend." },
    { id: "keke", name: "Keke Napep", price: 1200000, description: "Three wheels, endless hustle." },
    { id: "danfo-bus", name: "Danfo Bus", price: 2500000, description: "The yellow icon itself." },
    { id: "benz", name: "Mercedes Benz", price: 15000000, description: "You've arrived. Everybody knows." },
  ],
};

export const ASSETS_FASHION: Pack = {
  id: "assets-fashion",
  kind: "assets",
  name: "Lagos Fashion",
  description: "Owambe-ready fits: agbada, ankara, and sneakers that cost rent.",
  items: [
    { id: "agbada", name: "Designer Agbada", price: 150000, energy: 5, description: "+5 energy from pure confidence." },
    { id: "ankara", name: "Ankara Set", price: 45000, energy: 3 },
    { id: "sneakers", name: "Limited Sneakers", price: 250000, description: "Costs more than some people's rent." },
  ],
};
