import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

export async function verifyRestore(
  cfg,
  caseId,
  objectId,
  picture,
  workingDir,
) {
  const source = new URL(cfg.databaseUrl);
  assert.equal(source.hostname, "127.0.0.1");
  assert.match(source.pathname, /^\/kit_qa_projection_[a-f0-9]+$/);
  const name = "kit_qa_restore_" + randomBytes(8).toString("hex");
  const destination = new URL("/" + name, source).href;
  const objectsDir = join(workingDir, "restored");
  const env = {
    ...process.env,
    KIT_DB_URL: source.href,
    KIT_SNAPSHOT_DIR: join(workingDir, "snapshots"),
    KIT_EVIDENCE_DIR: cfg.evidenceDir,
  };
  const command = (args, environment) =>
    execFileSync("sh", ["tools/snapshot.sh", ...args], {
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const backup = command(["dump"], env);
  const admin = new pg.Client({
    connectionString: new URL("/postgres", source).href,
  });
  await admin.connect();
  const restored = new pg.Client({ connectionString: destination });
  try {
    await admin.query("CREATE DATABASE " + name);
    const restoreEnv = {
      ...env,
      KIT_DB_URL: destination,
      KIT_EVIDENCE_DIR: objectsDir,
    };
    command(["restore", backup], restoreEnv);
    await restored.connect();
    assert.equal(
      (await restored.query("SELECT count(*) FROM sessions")).rows[0].count,
      "0",
    );
    assert.equal(
      (await restored.query("SELECT count(*) FROM auth_challenges")).rows[0]
        .count,
      "0",
    );
    assert.equal(
      (
        await restored.query(
          "SELECT case_id FROM evidence_objects WHERE object_id=$1",
          [objectId],
        )
      ).rows[0].case_id,
      caseId,
    );
    assert.equal(
      (
        await restored.query(
          "SELECT available FROM proj_kits WHERE kit_id='camera'",
        )
      ).rows[0].available,
      false,
    );
    assert.deepEqual(
      await readFile(join(objectsDir, objectId + ".bin")),
      picture,
    );
    assert.throws(
      () => command(["restore", backup], restoreEnv),
      /destination database must be empty/,
    );
    return {
      restoredCase: true,
      restoredBytes: picture.length,
      availability: "HELD",
      restoredSessions: 0,
      existingDatabaseProtected: true,
    };
  } finally {
    await restored.end();
    await admin.query("DROP DATABASE IF EXISTS " + name);
    await admin.end();
  }
}
