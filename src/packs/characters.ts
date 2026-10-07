import type { Pack } from "./worlds.js";

/** Lagos street characters + the food, hustle and goals around them. */
export const CHARACTERS_LAGOS: Pack = {
  id: "characters-lagos",
  kind: "characters",
  name: "Lagos Characters",
  description: "Mama Put, a danfo conductor and a tech bro — plus street food, a buka business, and a first-hustle mission.",
  npcs: [
    {
      id: "mama-put",
      name: "Mama Put",
      location: "yaba",
      personality: "no-nonsense buka legend",
      dialogue: ["My amala no dey disappoint.", "You dey chop or you dey look?", "Omo, pay first before story."],
    },
    {
      id: "conductor-tunde",
      name: "Conductor Tunde",
      location: "ikeja",
      personality: "loud, fast, fair",
      dialogue: ["Enter with your change o!", "Hold your bag well-well.", "Oshodi under bridge, who dey go?"],
    },
    {
      id: "tech-bro",
      name: "Tech Bro Emeka",
      location: "lekki",
      personality: "ambitious, always pitching",
      dialogue: ["My startup go blow, just watch.", "Na coding pay my rent.", "Have you tried turning it off and on?"],
    },
  ],
  items: [
    { id: "amala", name: "Amala + Ewedu", price: 1500, energy: 30, health: 3 },
    { id: "gala", name: "Gala + La Casera", price: 800, energy: 15, health: 1 },
    { id: "suya", name: "Suya (full portion)", price: 3000, energy: 40, health: 4 },
  ],
  businesses: [
    { id: "mama-put-buka", name: "Mama Put Buka (franchise)", location: "yaba", cost: 200000, dailyIncome: 8000 },
  ],
  missions: [
    {
      id: "first-100k",
      name: "First ₦100k",
      description: "Earn your first ₦100,000 in Lagos. No excuses.",
      goal: { type: "earn", target: 100000 },
      reward: 10000,
    },
  ],
};
