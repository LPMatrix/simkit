#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadGameConfigFile } from "./config.js";
import { simulate } from "./simulate.js";

function help(): string {
  return `simkit — simulation tooling

Usage:
  simkit simulate --config <path> [--population N] [--days N] [--seeds N] [--seed-base N] [--json]

Options:
  --config      YAML/JSON world file (required)
  --population  agents per world (default 100)
  --days        simulated days per world (default 30)
  --seeds       worlds to run (default 3)
  --seed-base   first seed; runs use base..base+seeds-1 (default 1)
  --json        print the full report as JSON
`;
}

export function parseSimulateArgs(argv: string[]): {
  config: string;
  population: number;
  days: number;
  seeds: number;
  seedBase: number;
  json: boolean;
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) return undefined;
    return argv[i + 1];
  };
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer, got ${raw}`);
    return n;
  };
  const config = get("--config");
  if (!config) throw new Error("Missing required --config <path>");
  return {
    config,
    population: num("--population", 100),
    days: num("--days", 30),
    seeds: num("--seeds", 3),
    seedBase: num("--seed-base", 1),
    json: argv.includes("--json"),
  };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "simulate" || rest.includes("--help") || rest.includes("-h")) {
    console.log(help());
    process.exit(command === "simulate" ? 0 : 1);
  }
  const opts = parseSimulateArgs(rest);
  const seeds = Array.from({ length: opts.seeds }, (_, i) => opts.seedBase + i);
  const cfg = await loadGameConfigFile(opts.config);
  const report = await simulate({
    world: cfg,
    population: opts.population,
    days: opts.days,
    seeds,
  });
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`\nSimKit population run: ${cfg.gameId} — ${opts.population} agents × ${opts.days} days × ${seeds.length} seeds\n`);
  for (const run of report.runs) {
    const m = run.metrics;
    console.log(
      `seed ${run.seed}: median wealth ₦${Math.round(m.medianWealth).toLocaleString()}` +
        ` | unemployment ${(m.unemploymentRate * 100).toFixed(1)}%` +
        ` | bankruptcy ${(m.bankruptcyRate * 100).toFixed(1)}%` +
        ` | missed ${m.missedObligations}` +
        (run.invariantViolations.length > 0 ? ` | VIOLATIONS: ${run.invariantViolations.join(",")}` : ""),
    );
  }
  const a = report.aggregate;
  console.log(`\nAggregate (${report.runs.length} runs):`);
  console.log(`  median wealth     ₦${Math.round(a.medianWealth).toLocaleString()}`);
  console.log(`  mean wealth       ₦${Math.round(a.meanWealth).toLocaleString()}`);
  console.log(`  money supply      ₦${Math.round(a.moneySupply).toLocaleString()}`);
  console.log(`  unemployment      ${(a.unemploymentRate * 100).toFixed(1)}%`);
  console.log(`  bankruptcy        ${(a.bankruptcyRate * 100).toFixed(1)}%`);
  console.log(`  missed/capita     ${a.missedObligationsPerCapita.toFixed(2)}`);
  console.log(`  refusals/capita   ${a.refusalsPerCapita.toFixed(2)}`);
  console.log(`  runs w/violations ${a.runsWithViolations}`);
  if (a.runsWithViolations > 0) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
