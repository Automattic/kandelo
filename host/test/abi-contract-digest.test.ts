import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ABI_CONTRACT_SECTION,
  describeWasmArtifactPolicyFailures,
  readWasmCustomSectionPayload,
} from "../src/constants";

// ---------------------------------------------------------------------------
// Minimal wasm builder: a module exporting `__abi_version` returning `abi`,
// with an optional `kandelo.abi.contract` 32-byte custom section. Self-
// contained so the ABI-contract-digest gate is tested independently of any
// built binary.
// ---------------------------------------------------------------------------

function uleb128(n: number): number[] {
  const r: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    r.push(b);
  } while (n !== 0);
  return r;
}

function sleb128_i32(n: number): number[] {
  const r: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    const signBit = (b & 0x40) !== 0;
    if ((n === 0 && !signBit) || (n === -1 && signBit)) {
      r.push(b);
      return r;
    }
    r.push(b | 0x80);
  }
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb128(payload.length), ...payload];
}

function nameBytes(s: string): number[] {
  const enc = new TextEncoder().encode(s);
  return [...uleb128(enc.length), ...enc];
}

function buildAbiModule(opts: {
  abi: number;
  contractDigest?: Uint8Array | null;
}): ArrayBuffer {
  const bytes: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

  if (opts.contractDigest) {
    bytes.push(
      ...section(0, [
        ...nameBytes(ABI_CONTRACT_SECTION),
        ...opts.contractDigest,
      ]),
    );
  }

  // type: () -> i32
  bytes.push(...section(1, [1, 0x60, 0, 1, 0x7f]));
  // function: one func of type 0
  bytes.push(...section(3, [1, 0]));
  // export: "__abi_version" -> func 0
  bytes.push(...section(7, [1, ...nameBytes("__abi_version"), 0x00, 0]));
  // code: body = 0 locals, i32.const abi, end
  const body = [0x00, 0x41, ...sleb128_i32(opts.abi), 0x0b];
  bytes.push(...section(10, [1, ...uleb128(body.length), ...body]));

  return new Uint8Array(bytes).buffer;
}

const digestOf = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

describe("readWasmCustomSectionPayload", () => {
  it("round-trips a 32-byte kandelo.abi.contract payload", () => {
    const digest = digestOf(0x5a);
    const wasm = buildAbiModule({ abi: 44, contractDigest: digest });
    const read = readWasmCustomSectionPayload(wasm, ABI_CONTRACT_SECTION);
    expect(read).not.toBeNull();
    expect(Array.from(read!)).toEqual(Array.from(digest));
  });

  it("returns null when the section is absent", () => {
    const wasm = buildAbiModule({ abi: 44 });
    expect(readWasmCustomSectionPayload(wasm, ABI_CONTRACT_SECTION)).toBeNull();
  });
});

describe("describeWasmArtifactPolicyFailures ABI-contract-digest gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("REJECTS a mismatched contract digest EVEN WHEN the ABI numbers match", () => {
    const kernelDigest = digestOf(0x11);
    const guestDigest = digestOf(0x22); // different snapshot, SAME abi number
    const wasm = buildAbiModule({ abi: 44, contractDigest: guestDigest });
    const failures = describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: 44,
      expectedAbiContractDigest: kernelDigest,
    });
    expect(failures.some((f) => f.includes("ABI contract digest mismatch"))).toBe(true);
    // The ABI number itself matched, so the number check contributes nothing.
    expect(failures.some((f) => f.startsWith("ABI 44, expected"))).toBe(false);
  });

  it("ACCEPTS a matching contract digest", () => {
    const digest = digestOf(0x33);
    const wasm = buildAbiModule({ abi: 44, contractDigest: digest });
    const failures = describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: 44,
      expectedAbiContractDigest: digest,
    });
    expect(failures).toEqual([]);
  });

  it("WARNS (does not fail) for an UNSTAMPED legacy guest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wasm = buildAbiModule({ abi: 44 }); // no contract section
    const failures = describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: 44,
      expectedAbiContractDigest: digestOf(0x44),
    });
    expect(failures.some((f) => f.includes("ABI contract digest"))).toBe(false);
    expect(failures).toEqual([]);
    // The warning is emitted at most once per worker process; if this is the
    // first unstamped guest observed in this process it fires here.
    if (warn.mock.calls.length > 0) {
      expect(String(warn.mock.calls[0]?.[0])).toContain("kandelo.abi.contract");
    }
  });

  it("does not gate on the digest when no expected digest is supplied", () => {
    const wasm = buildAbiModule({ abi: 44, contractDigest: digestOf(0x99) });
    const failures = describeWasmArtifactPolicyFailures(wasm, { expectedAbi: 44 });
    expect(failures).toEqual([]);
  });
});
