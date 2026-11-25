// Staff sign-in authentication. A session is never created from a public
// address alone: the desk requests a one-use, short-lived challenge bound
// to (network, realm, org, device, addr), signs it with the institution
// key, and the API verifies the signature, that the supplied pubkey
// derives the claimed gno address, and that the address still holds an
// active org grant in the projection.
//
// Key formats match gnokey/tm2:
//   secp256k1 (default): compressed 33-byte pubkey, 64-byte r||s signature
//     over SHA-256(doc); address = RIPEMD160(SHA256(pubkey)).
//   ed25519: 32-byte pubkey, 64-byte signature over doc bytes;
//     address = SHA256(pubkey)[:20].

import { createHash, verify as cryptoVerify } from "node:crypto";

// ---- bech32 (BIP-0173; gno addresses use the "g1" HRP) -------------------
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

// ---- secp256k1 field arithmetic (point decompression only) ---------------
const SECP_P = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F");

function powmod(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = r * b % m;
    b = b * b % m;
    e >>= 1n;
  }
  return r;
}

/** y = sqrt(x^3+7) mod p; choose the root matching the prefix parity bit. */
export function decompressSecp256k1(pub: Buffer): Buffer {
  if (pub.length !== 33 || (pub[0] !== 0x02 && pub[0] !== 0x03)) {
    throw new Error("expected 33-byte compressed secp256k1 pubkey");
  }
  const x = BigInt("0x" + pub.subarray(1).toString("hex"));
  const a = (x * x % SECP_P * x + 7n) % SECP_P;
  let y = powmod(a, (SECP_P + 1n) / 4n, SECP_P);
  if (y * y % SECP_P !== a) throw new Error("invalid secp256k1 point");
  if (Number(y & 1n) !== (pub[0]! & 1)) y = SECP_P - y;
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(x.toString(16).padStart(64, "0"), "hex"),
    Buffer.from(y.toString(16).padStart(64, "0"), "hex"),
  ]);
}

/** tm2/gno address for a supported key: bech32 "g1" of the pubkey hash. */
export function addrFromPubkey(pubkey: Buffer): string {
  if (pubkey.length === 33) {
    // secp256k1: RIPEMD160(SHA256(compressed pubkey)) — gnokey default.
    const sha = createHash("sha256").update(pubkey).digest();
    return bech32Encode("g", createHash("ripemd160").update(sha).digest());
  }
  if (pubkey.length === 32) {
    // ed25519: SHA256(pubkey)[:20].
    return bech32Encode(
      "g1", createHash("sha256").update(pubkey).digest().subarray(0, 20));
  }
  throw new Error("unsupported pubkey length");
}

function secp256k1Spki(uncompressed65: Buffer): Buffer {
  return Buffer.concat([
    // SPKI: SEQ{ SEQ{ ecPublicKey OID, secp256k1 OID }, BIT STRING point }
    Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex"),
    uncompressed65,
  ]);
}

/**
 * Verify a signature over the exact challenge signdoc bytes. secp256k1
 * signatures are tm2 64-byte r||s over SHA-256(doc); ed25519 signs the
 * doc bytes directly.
 */
export function verifySignature(signdoc: string, signature: Buffer, pubkey: Buffer): boolean {
  try {
    if (pubkey.length === 33) {
      const key = {
        key: secp256k1Spki(decompressSecp256k1(pubkey)),
        format: "der" as const,
        type: "spki" as const,
        dsaEncoding: "ieee-p1363" as const,
      };
      return cryptoVerify("sha256", Buffer.from(signdoc, "utf8"), key, signature);
    }
    if (pubkey.length === 32) {
      const key = {
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"), // ed25519 SPKI prefix
          pubkey,
        ]),
        format: "der" as const,
        type: "spki" as const,
      };
      return cryptoVerify(null, Buffer.from(signdoc, "utf8"), key, signature);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The canonical sign doc a staff key signs at login: amino-sorted JSON in
 * the same shape `gnokey sign -offline -account-number 0 -sequence 0`
 * produces for the equivalent unsigned tx. The nonce is embedded as the
 * call argument so the signed bytes bind (network, realm, addr, nonce).
 * `challengeTx` returns the matching unsigned-tx file for gnokey.
 */
export function challengeSigndoc(opts: {
  chainId: string;
  realm: string;
  addr: string;
  nonce: string;
}): string {
  const msg = `{"@type":"/vm.m_call","args":[${JSON.stringify(opts.nonce)}],` +
    `"caller":${JSON.stringify(opts.addr)},"func":"GetKit",` +
    `"max_deposit":"","pkg_path":${JSON.stringify(opts.realm)},"send":""}`;
  return `{"account_number":"0","chain_id":${JSON.stringify(opts.chainId)},` +
    `"fee":{"amount":[{"amount":"1","denom":"ugnot"}],"gas":"2000000"},` +
    `"memo":"kit-transit staff sign-in","msgs":[${msg}],"sequence":"0"}`;
}

/** Unsigned tx (gnokey sign input) whose sign doc is challengeSigndoc. */
export function challengeTx(opts: {
  chainId: string;
  realm: string;
  addr: string;
  nonce: string;
}): object {
  return {
    msg: [{
      "@type": "/vm.m_call",
      caller: opts.addr,
      send: "",
      max_deposit: "",
      pkg_path: opts.realm,
      func: "GetKit",
      args: [opts.nonce],
    }],
    fee: { gas_wanted: "2000000", gas_fee: "1ugnot" },
    signatures: null,
    memo: "kit-transit staff sign-in",
  };
}
