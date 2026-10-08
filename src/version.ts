/**
 * Simulation version and canonical encoding for golden fingerprints.
 *
 * Bump SIMULATION_VERSION whenever a change alters simulation outcomes, and
 * record why in tests/fingerprints.json. The fingerprint test fails on any
 * unexplained drift.
 */
export const SIMULATION_VERSION = 2;

/** Deterministic encoding: object keys sorted recursively, so structurally
 * identical states hash identically regardless of insertion order.
 * `undefined` follows JSON semantics: dropped from objects, null in arrays. */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) as string;
}
