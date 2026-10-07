import type { Pack } from "./worlds.js";

export const JOBS_NIGERIAN_CORE: Pack = {
  id: "jobs-nigerian-core",
  kind: "jobs",
  name: "Nigerian Core Jobs",
  description: "Seven everyday careers: danfo driver, software engineer, trader, doctor, banker, farmer, student.",
  jobs: [
    { id: "danfo-driver", name: "Danfo Driver", salary: 150000, workingHours: 10, energyCost: 35 },
    { id: "software-engineer", name: "Software Engineer", salary: 350000, workingHours: 8, energyCost: 25, requirements: { coding: 50 } },
    { id: "trader", name: "Trader", salary: 200000, workingHours: 9, energyCost: 30 },
    { id: "doctor", name: "Doctor", salary: 500000, workingHours: 12, energyCost: 40, requirements: { medicine: 60 } },
    { id: "banker", name: "Banker", salary: 400000, workingHours: 9, energyCost: 28, requirements: { finance: 40 } },
    { id: "farmer", name: "Farmer", salary: 120000, workingHours: 10, energyCost: 38 },
    { id: "student", name: "Student", salary: 30000, workingHours: 6, energyCost: 20 },
  ],
};
