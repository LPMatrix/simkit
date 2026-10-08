/** Minimal API-key auth. Swap for JWT / dashboard sessions later. */
export interface AuthConfig {
  apiKeys: Set<string>;
  required: boolean;
}

export function authFromEnv(): AuthConfig {
  const noAuth = process.env.SIMKIT_NO_AUTH === "1";
  const raw =
    process.env.SIMKIT_API_KEYS ?? process.env.SIMKIT_API_KEY ?? "simkit-dev";
  const keys = new Set(
    raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
  return { apiKeys: keys, required: !noAuth };
}

export function isAuthorized(req: Request, cfg: AuthConfig): boolean {
  if (!cfg.required) return true;
  const key = req.headers.get("x-api-key") ?? keyFromBearer(req);
  return key != null && cfg.apiKeys.has(key);
}

function keyFromBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}
