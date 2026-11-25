import pg from "pg";
import { loadConfig } from "../src/config.ts";
import { makePool, migrate, type Pool } from "../src/db.ts";
import type { ChainClient, ChainStatus, EventPage } from "../src/chain.ts";

/**
 * Test database isolation: every test file provisions a uniquely named
 * disposable database, so suites can run in parallel and never touch the
 * configured development database or its data.
 */
function adminUrl(): string {
  return loadConfig().databaseUrl.replace(/\/[^/?]+$/, "/postgres");
}

function urlFor(db: string): string {
  return loadConfig().databaseUrl.replace(/\/[^/?]+$/, `/${db}`);
}

export async function provisionDb(label: string): Promise<Pool> {
  const name = `kittransit_test_${label}_${process.pid}`;
  const admin = new pg.Pool({ connectionString: adminUrl(), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const pool = makePool(urlFor(name));
  await migrate(pool);
  return pool;
}

export async function disposeDb(pool: Pool, label: string): Promise<void> {
  const name = `kittransit_test_${label}_${process.pid}`;
  await pool.end();
  const admin = new pg.Pool({ connectionString: adminUrl(), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Truncate every table inside the file's private database only. */
export async function freshDb(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE checkpoint, epoch_evidence, realm_events, proj_orgs, proj_grants,
      proj_kits, proj_lines, proj_legs, proj_exceptions, proj_claims, proj_ops,
      outbox, outbox_delivery, cases, sessions, evidence_objects, barcode_quarantine,
      catalogue_items RESTART IDENTITY CASCADE`);
}

/** Fake chain for indexer unit tests — canned status + event feed. */
export class FakeChain implements Pick<ChainClient, "status" | "events" | "query"> {
  network = "dev";
  height = 10;
  epoch = "dev@0:genesisfake";
  feed: EventPage = { chainId: "dev", realm: "gno.land/r/kittransit/custody", height: 10, rev: 0, lastSeq: 0, events: [] };
  kits: Record<string, any> = {};
  legs: Record<string, any> = {};
  excs: Record<string, any[]> = {};
  claims: Record<string, any[]> = {};
  orgs: Record<string, any> = {};
  ops: Record<string, any> = {}; // key: "org/opId"

  realmPath(): string {
    return "gno.land/r/kittransit/custody";
  }
  async status(): Promise<ChainStatus> {
    return { network: this.network, height: this.height, epoch: this.epoch };
  }
  async events(afterSeq = 0, limit = 200): Promise<EventPage> {
    const events = this.feed.events.filter((e) => e.seq > afterSeq).slice(0, limit);
    return { ...this.feed, events, lastSeq: this.feed.lastSeq };
  }
  async query(fn: string): Promise<Record<string, unknown>> {
    if (fn.startsWith("GetKit(")) {
      const id = fn.slice(8, -2);
      return this.kits[id] ?? { error: "unknown kit" };
    }
    if (fn.startsWith("GetLeg(")) {
      const id = fn.slice(8, -2);
      return this.legs[id] ?? { error: "unknown leg" };
    }
    if (fn.startsWith("GetExceptions(")) {
      const id = fn.slice(15, -2);
      return { exceptions: this.excs[id] ?? [] };
    }
    if (fn.startsWith("GetClaims(")) {
      const id = fn.slice(11, -2);
      return { claims: this.claims[id] ?? [] };
    }
    if (fn.startsWith("GetOrg(")) {
      const id = fn.slice(8, -2);
      return this.orgs[id] ?? { error: "unknown org" };
    }
    if (fn.startsWith("GetOp(")) {
      // GetOp("A","op-1") — split on the quoted args.
      const args = fn.match(/GetOp\("([^"]*)","([^"]*)"\)/);
      if (args) return this.ops[`${args[1]}/${args[2]}`] ?? { status: "unknown" };
      return { status: "unknown" };
    }
    return { raw: "{}" };
  }
}

export function kitJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: "dev", realm: "gno.land/r/kittransit/custody", height: 10, rev: 1,
    kit: "kit-x", owner: "A", manifestRev: 1, manifestDigest: "d".repeat(64),
    activeLeg: "", available: false, hold: true, needsAssessment: false,
    lines: [
      { id: "body", label: "Camera body", required: 1, issued: 1, held: { A: 1 },
        inTransit: 0, unlocated: 0, quarantine: 0, retired: 0, assessment: "none" },
    ],
    openExceptions: [],
    ...over,
  };
}
