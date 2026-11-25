import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  open,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { loadConfig } from "../src/config.ts";

process.umask(0o077);
const [operation, input] = process.argv.slice(2);
const cfg = loadConfig();
const db = new pg.Client({ connectionString: cfg.databaseUrl });
const objectsPath = resolve(cfg.evidenceDir);

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function postgresEnvironment() {
  const uri = new URL(cfg.databaseUrl);
  const env = {
    ...process.env,
    PGHOST: uri.hostname,
    PGPORT: uri.port || "5432",
    PGDATABASE: decodeURIComponent(uri.pathname.slice(1)),
    PGUSER: decodeURIComponent(uri.username),
    PGPASSWORD: decodeURIComponent(uri.password),
  };
  for (const [key, name] of [
    ["sslmode", "PGSSLMODE"],
    ["sslrootcert", "PGSSLROOTCERT"],
    ["sslcert", "PGSSLCERT"],
    ["sslkey", "PGSSLKEY"],
  ]) {
    if (uri.searchParams.has(key)) env[name] = uri.searchParams.get(key);
  }
  return env;
}

async function postgres(command, args, archive) {
  const dump = command === "pg_dump";
  const file = await open(archive, dump ? "wx" : "r");
  try {
    const env = postgresEnvironment();
    let executable = command;
    let argv = args;
    if (process.env.KIT_PG_CONTAINER) {
      // In the documented Compose install, use the exact server-version client.
      assert.equal(env.PGHOST, "127.0.0.1");
      assert.equal(env.PGPORT, "5433");
      argv = [
        "exec",
        "-i",
        "-e",
        "PGUSER",
        "-e",
        "PGPASSWORD",
        "-e",
        "PGDATABASE",
        process.env.KIT_PG_CONTAINER,
        command,
        ...args,
      ];
      executable = "docker";
    }
    await new Promise((accept, reject) => {
      const proc = spawn(executable, argv, {
        env,
        stdio: dump
          ? ["ignore", file.fd, "inherit"]
          : [file.fd, "inherit", "inherit"],
      });
      proc.on("error", reject);
      proc.on("close", (code) =>
        code === 0 ? accept() : reject(new Error(command + " exited " + code)),
      );
    });
  } finally {
    await file.close();
  }
}

async function copyVerifiedObjects(rows, source, target) {
  const ids = new Set();
  for (const item of rows) {
    assert.match(item.object_id, /^obj-[a-f0-9]{16}(?:-[a-f0-9]{8})?$/);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!ids.has(item.object_id), "duplicate evidence id");
    ids.add(item.object_id);
    const filename = item.object_id + ".bin";
    const dst = join(target, filename);
    await copyFile(join(source, filename), dst);
    assert.equal(
      await digest(dst),
      item.sha256,
      "evidence digest mismatch: " + item.object_id,
    );
  }
}

async function backup() {
  const base = resolve(process.env.KIT_SNAPSHOT_DIR || ".local/snapshots");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "kit-"));
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snap = (await db.query("SELECT pg_export_snapshot() AS id")).rows[0]
      .id;
    const rows = (
      await db.query(
        "SELECT object_id,sha256 FROM evidence_objects ORDER BY object_id",
      )
    ).rows;
    const archive = join(dir, "database.dump");
    await postgres(
      "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--snapshot=" + snap,
        "--exclude-table-data=public.sessions",
        "--exclude-table-data=public.auth_challenges",
      ],
      archive,
    );
    const assets = join(dir, "objects");
    await mkdir(assets);
    await copyVerifiedObjects(rows, objectsPath, assets);
    await db.query("COMMIT");
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(
        { version: 1, databaseSha256: await digest(archive), objects: rows },
        null,
        2,
      ) + "\n",
    );
    console.log(dir);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function restore() {
  assert.ok(
    input && process.env.KIT_DB_URL && process.env.KIT_EVIDENCE_DIR,
    "Set KIT_DB_URL to a fresh database and KIT_EVIDENCE_DIR to a new directory",
  );
  const archive = join(resolve(input), "database.dump");
  const manifest = JSON.parse(
    await readFile(join(resolve(input), "manifest.json"), "utf8"),
  );
  assert.equal(manifest.version, 1);
  assert.equal(
    await digest(archive),
    manifest.databaseSha256,
    "database archive digest mismatch",
  );
  // Hold the database-local lock across the external pg_restore session.
  assert.ok(
    (await db.query("SELECT pg_try_advisory_lock(658311091) AS locked")).rows[0]
      .locked,
    "another restore is running",
  );
  const existing = await db.query(
    "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' LIMIT 1",
  );
  assert.equal(existing.rowCount, 0, "destination database must be empty");
  await mkdir(objectsPath, { recursive: false });
  try {
    await copyVerifiedObjects(
      manifest.objects,
      join(resolve(input), "objects"),
      objectsPath,
    );
    await postgres(
      "pg_restore",
      [
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
        "--dbname",
        postgresEnvironment().PGDATABASE,
      ],
      archive,
    );
  } catch (error) {
    await rm(objectsPath, { recursive: true, force: true });
    throw error;
  }
  console.log(
    "Restored database and " +
      manifest.objects.length +
      " evidence objects. Staff must sign in again.",
  );
}
try {
  await db.connect();
  if (operation === "dump") await backup();
  else if (operation === "restore") await restore();
  else throw new Error("Unknown snapshot operation");
} finally {
  await db.end();
}
