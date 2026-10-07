export type LeaderboardMetric = "wealth" | "level" | "xp" | "reputation";

export const LEADERBOARD_METRICS: LeaderboardMetric[] = ["wealth", "level", "xp", "reputation"];

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  name: string;
  value: number;
}

interface Scoreable {
  id: string;
  name: string;
  wallet: { balance: number };
  progression: { level: number; xp: number };
  reputation: number;
}

export function metricValue(p: Scoreable, metric: LeaderboardMetric): number {
  switch (metric) {
    case "wealth":
      return p.wallet.balance;
    case "level":
      return p.progression.level;
    case "xp":
      return p.progression.xp;
    case "reputation":
      return p.reputation;
  }
}

/** Dense-ranked leaderboard (ties share a rank), sorted best-first. */
export function buildLeaderboard(
  players: Scoreable[],
  metric: LeaderboardMetric,
  limit = 10,
): LeaderboardEntry[] {
  const sorted = [...players].sort((a, b) => metricValue(b, metric) - metricValue(a, metric));
  const entries: LeaderboardEntry[] = [];
  let rank = 0;
  let last: number | null = null;
  for (const p of sorted.slice(0, Math.max(1, limit))) {
    const value = metricValue(p, metric);
    if (last == null || value !== last) {
      rank += 1;
      last = value;
    }
    entries.push({ rank, playerId: p.id, name: p.name, value });
  }
  return entries;
}
