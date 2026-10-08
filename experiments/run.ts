import { readFileSync } from "node:fs";
import { run } from "./spike.js";

// Scores are read from the tags in spike.ts, so the report cannot drift from the code.
const src = readFileSync(new URL("./spike.ts", import.meta.url), "utf8");
const sections = [...src.matchAll(/\/\/ === SECTION: (.+?) ===([\s\S]*?)\/\/ === END: \1 ===/g)]
  .filter((m) => m[1] !== "SCENARIOS");

const rows = sections.map((m) => {
  const body = m[2];
  const count = (tag: string): number => (body.match(new RegExp(`\\[${tag}\\]`, "g")) ?? []).length;
  const ok = count("OK");
  const workaround = count("WORKAROUND");
  const missing = count("MISSING");
  const total = ok + workaround + missing;
  return {
    sim: m[1],
    ok,
    workaround,
    missing,
    total,
    supported: total ? Math.round((ok / total) * 100) : 0,
    loc: body.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length,
  };
});

console.log("\nMECHANIC TAGS (from spike.ts)");
console.log("sim           OK  WORKAROUND  MISSING  total  supported  code-lines");
for (const r of rows) {
  console.log(
    `${r.sim.padEnd(12)} ${String(r.ok).padStart(3)}  ${String(r.workaround).padStart(10)}  ${String(r.missing).padStart(7)}  ${String(r.total).padStart(5)}  ${(r.supported + "%").padStart(9)}  ${String(r.loc).padStart(10)}`,
  );
}
const all = rows.reduce((s, r) => ({ ok: s.ok + r.ok, total: s.total + r.total }), { ok: 0, total: 0 });
const overall = all.total ? Math.round((all.ok / all.total) * 100) : 0;
console.log(`\nOverall supported as-is: ${overall}%  (doc threshold for a real abstraction: 70–80%)`);

await run();
