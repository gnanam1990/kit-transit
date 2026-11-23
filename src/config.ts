// Central configuration. Every knob is env-overridable; defaults target the
// isolated local dev stack (gnodev + docker postgres). No secrets are read
// from or written to the repo.

export interface Config {
  databaseUrl: string;
  rpcUrl: string;           // gnodev tm2 RPC, e.g. http://127.0.0.1:26657
  realm: string;            // gno.land/r/kittransit/custody
  evidenceDir: string;      // private object bucket (never web-served)
  webDir: string;           // static staff desk
  apiPort: number;
  sessionTtlSec: number;
  pollMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: env.KIT_DB_URL ??
      "postgres://kittransit:kittransit-local-dev@127.0.0.1:5433/kittransit",
    rpcUrl: env.KIT_RPC_URL ?? "http://127.0.0.1:26657",
    realm: env.KIT_REALM ?? "gno.land/r/kittransit/custody",
    evidenceDir: env.KIT_EVIDENCE_DIR ?? ".local/evidence",
    webDir: env.KIT_WEB_DIR ?? "web",
    apiPort: Number(env.KIT_API_PORT ?? 8080),
    sessionTtlSec: Number(env.KIT_SESSION_TTL_SEC ?? 8 * 3600),
    pollMs: Number(env.KIT_POLL_MS ?? 1000),
  };
}
