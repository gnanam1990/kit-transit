// Staff sign-in authentication. A session is never created from a public
// address alone: the desk requests a one-use, short-lived challenge bound
// to (network, realm, org, device, addr), signs it with the institution key,
// and the API verifies the ed25519 signature AND that sha256(pubkey)[:20]
// bech32-encodes to the claimed address AND that the address still holds an
// active org grant in the projection.

import { createHash, verify as cryptoVerify } from "node:crypto";

// ---- bech32 (BIP-0173, bech32 not bech32m; gno addresses use "g1") --------
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i]!;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0, bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}

/** bech32-encode raw program bytes under the gno "g1" HRP. */
export function bech32Encode(hrp: string, program: Buffer): string {
  const data = convertBits([...program], 8, 5, true);
  const combined = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(combined) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map((d) => CHARSET[d]).join("");
}

/** tm2/gno ed25519 address = first 20 bytes of SHA-256(pubkey), bech32 g1. */
export function addrFromPubkey(pubkey: Buffer): string {
  return bech32Encode("g1", createHash("sha256").update(pubkey).digest().subarray(0, 20));
}

/** Verify an ed25519 signature over the exact challenge signdoc bytes. */
export function verifySignature(signdoc: string, signature: Buffer, pubkey: Buffer): boolean {
  try {
    const key = {
      key: Buffer.concat([
        // ed25519 SPKI DER prefix for a raw 32-byte public key
        Buffer.from("302a300506032b6570032100", "hex"),
        pubkey,
      ]),
      format: "der" as const,
      type: "spki" as const,
    };
    return cryptoVerify(null, Buffer.from(signdoc, "utf8"), key, signature);
  } catch {
    return false;
  }
}

/**
 * The canonical sign doc a staff key signs at login. Amino-canonical field
 * order; the challenge nonce is embedded as the call argument so the signed
 * bytes bind (network, realm, org, device, addr, nonce) together. This is
 * the same doc shape `gnokey sign -offline` produces for an equivalent tx.
 */
export function challengeSigndoc(opts: {
  chainId: string;
  realm: string;
  addr: string;
  nonce: string;
}): string {
  const msg = `{"@type":"/vm.m_call","args":[${JSON.stringify(opts.nonce)}],` +
    `"caller":${JSON.stringify(opts.addr)},"func":"GetKit",` +
    `"pkg_path":${JSON.stringify(opts.realm)},"send":""}`;
  return `{"account_number":"0","chain_id":${JSON.stringify(opts.chainId)},` +
    `"fee":{"amount":[{"amount":"1","denom":"ugnot"}],"gas":"2000000"},` +
    `"memo":"kit-transit staff sign-in","msgs":[${msg}],"sequence":"0"}`;
}
