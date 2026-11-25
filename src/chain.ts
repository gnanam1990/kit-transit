// Minimal gnodev tm2 RPC client. Reads only — the API never signs or
// broadcasts; staff sign locally and the chain client observes results.

export interface ChainStatus {
  network: string;   // node_info.network (chain id)
  height: number;    // latest block height
  epoch: string;     // chain identity used for epoch detection
}

export interface RealmEvent {
  seq: number;
  height: number;
  kind: string;
  kit: string;
  leg: string;
  line: string;
  org: string;
  data: string;
}

export interface EventPage {
  chainId: string;
  realm: string;
  height: number;
  rev: number;
  lastSeq: number;
  events: RealmEvent[];
}

export class ChainClient {
  constructor(
    private rpcUrl: string,
    private realm: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async rpc(method: string, params: Record<string, unknown>): Promise<any> {
    const res = await this.fetchImpl(`${this.rpcUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
    const j = (await res.json()) as any;
    if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }

  /** GET-style RPC endpoints (tm2 serves status/abci_query over HTTP GET too). */
  private async rpcGet(path: string): Promise<any> {
    const res = await this.fetchImpl(`${this.rpcUrl}/${path}`);
    if (!res.ok) throw new Error(`rpc ${path} http ${res.status}`);
    const j = (await res.json()) as any;
    if (j.error) throw new Error(`rpc ${path}: ${JSON.stringify(j.error)}`);
    return j.result;
  }

  realmPath(): string { return this.realm; }

  async status(): Promise<ChainStatus> {
    const r = await this.rpcGet("status");
    const network = r?.node_info?.network ?? "";
    const height = Number(r?.sync_info?.latest_block_height ?? 0);
    // Epoch = chain identity + genesis identity. gnodev in-memory chains
    // report the network name; the earliest block hash pins the instance.
    const epoch = `${network}@${r?.sync_info?.earliest_block_height ?? "0"}:${
      r?.sync_info?.earliest_block_hash ?? r?.node_info?.id ?? "0"}`;
    return { network, height, epoch };
  }

  /** Evaluate a read-only realm function via vm/qeval. */
  async qeval(expr: string): Promise<string> {
    const data = Buffer.from(`${this.realm}.${expr}`, "utf8").toString("base64");
    const r = await this.rpcGet(`abci_query?path="vm/qeval"&data="${data}"`);
    const raw = r?.response?.ResponseBase?.Data ?? r?.response?.data ?? "";
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    // gno qeval responses look like `("...json..." string)` or `("..." )`.
    const m = decoded.match(/^\("((?:[^"\\]|\\.)*)"/s);
    if (m) return JSON.parse(`"${m[1]}"`) as string;
    return decoded;
  }

  async events(afterSeq: number, limit = 200): Promise<EventPage> {
    const raw = await this.qeval(`GetEvents(${afterSeq},${limit})`);
    return JSON.parse(raw) as EventPage;
  }

  async query(fn: string): Promise<Record<string, unknown>> {
    const raw = await this.qeval(fn);
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { raw };
    }
  }
}
