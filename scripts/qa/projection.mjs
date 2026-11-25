import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const repo = (p) => import(pathToFileURL(resolve(p)).href);
const { makePool, migrate } = await repo("src/db.ts");
const { ChainClient } = await repo("src/chain.ts");
const { indexOnce, readCheckpoint } = await repo("src/indexer.ts");
const { exportCsv } = await repo("src/catalogue.ts");
const [rpc, stage] = process.argv.slice(2);
const url = new URL(process.env.KIT_DB_URL);
assert.equal(url.hostname, "127.0.0.1");
assert.match(url.pathname, /^\/kit_qa_projection_[0-9a-f]+$/);
const pool = makePool(url.href);
try {
  await migrate(pool);
  const chain = new ChainClient(
    "http://" + rpc,
    "gno.land/r/kittransit/custody",
  );
  const expected = await chain.query('GetKit("camera")');
  assert.equal(
    expected.kit,
    "camera",
    "read the deployed realm through product ChainClient",
  );
  const all = await chain.events(0, 200);
  if (process.env.KIT_QA_PAGE_LIMIT) {
    const get = chain.events.bind(chain);
    chain.events = (after) => get(after, 2);
    for (let k = 0; k <= all.events.length; k++) {
      if (!(await indexOnce(pool, chain))) break;
    }
    const stored = (
      await pool.query("SELECT seq FROM realm_events ORDER BY seq")
    ).rows.map((x) => Number(x.seq));
    assert.deepEqual(
      stored,
      all.events.map((e) => e.seq),
      "indexing multiple pages must retain every real event in order",
    );
  }
  const count = await indexOnce(pool, chain);
  const cp = await readCheckpoint(pool);
  const duplicate = await indexOnce(pool, chain);
  if (!process.env.KIT_QA_PAGE_LIMIT) assert.ok(count > 0);
  assert.equal(duplicate, 0);
  const kit = (
    await pool.query("SELECT * FROM proj_kits WHERE kit_id='camera'")
  ).rows[0];
  assert.equal(kit.available, stage === "final");
  assert.equal(kit.available, expected.available);
  const csv = await exportCsv(pool);
  const file = resolve(
    process.env.KIT_QA_OUTPUT,
    "catalogue-" + stage + ".csv",
  );
  await writeFile(file, csv);
  assert.equal(await readFile(file, "utf8"), csv);
  assert.ok(csv.includes(stage === "final" ? "AVAILABLE" : "HELD"));
  const delivery = (
    await pool.query(
      "SELECT state,event_seq,height FROM outbox ORDER BY seq DESC LIMIT 1",
    )
  ).rows[0];
  const source = all.events.find((x) => x.seq === Number(delivery.event_seq));
  if (process.env.KIT_QA_RELEASE_PROVENANCE && stage === "final")
    assert.equal(
      source.kind,
      "release",
      "availability must cite the release event, not an earlier movement",
    );
  console.log(
    JSON.stringify({
      stage,
      deliveryState: delivery.state,
      deliveryAttributedTo: source.kind,
      processed: count,
      duplicate,
      checkpoint: cp.last_seq,
      available: kit.available,
      filename: file.split("/").at(-1),
    }),
  );
} finally {
  await pool.end();
}
