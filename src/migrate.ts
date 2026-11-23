import { loadConfig } from "./config.ts";
import { makePool, migrate } from "./db.ts";

const cfg = loadConfig();
const pool = makePool(cfg.databaseUrl);
await migrate(pool);
console.log("schema applied");
await pool.end();
