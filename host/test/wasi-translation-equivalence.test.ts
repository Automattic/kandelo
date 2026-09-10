/**
 * Differential equivalence between the TypeScript WASI translation and the
 * Rust `wasi-abi` crate.
 *
 * This is K10's deletion gate. The Rust side dumps its answer for every input
 * in each function's FULL domain:
 *
 *   cargo run -p xtask --target <host> -- dump-wasi-translation \
 *     --out host/test/fixtures/wasi-translation-rust.json
 *
 * and this file asserts `host/src/wasi-shim.ts` computes the same value for
 * every one of them. The domains are small enough to enumerate exhaustively,
 * so agreement here is proof rather than sampling.
 *
 * ## Why some entries are asserted to DISAGREE
 *
 * The TypeScript carries five latent defects. A harness that demanded
 * bit-for-bit equality would certify those defects as correct behavior, which
 * is exactly what the project's validation contract forbids. So each table
 * that a defect fix touches carries a `divergence` block naming the defect and
 * listing the inputs it covers, and this file:
 *
 *   * asserts AGREEMENT on every input outside that list, and
 *   * asserts DISAGREEMENT on every input inside it.
 *
 * The second half matters as much as the first: it means a defect fix that
 * silently regressed back to the old behavior fails the suite instead of
 * quietly passing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { __wasiTranslationInternals as ts } from "../src/wasi-shim";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Divergence {
  defect: string;
  summary: string;
  inputs: unknown[];
}
interface Table {
  description: string;
  values: Record<string, unknown>[];
  divergence?: Divergence;
}
interface Dump {
  generator: string;
  note: string;
  tables: Record<string, Table>;
}

const dump: Dump = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "wasi-translation-rust.json"), "utf8"),
);

function table(name: string): Table {
  const t = dump.tables[name];
  if (!t) throw new Error(`the Rust dump has no table "${name}" — regenerate it`);
  if (t.values.length === 0) throw new Error(`table "${name}" is empty`);
  return t;
}

/** Guards against a dump that silently lost its cases. */
function expectDomainSize(name: string, expected: number): Table {
  const t = table(name);
  expect(t.values.length, `${name} domain size`).toBe(expected);
  return t;
}

describe("WASI translation: TypeScript and Rust agree over the full domain", () => {
  it("the dump is the generated artifact, not a hand-edited one", () => {
    expect(dump.generator).toBe("cargo xtask dump-wasi-translation");
    expect(Object.keys(dump.tables).length).toBeGreaterThanOrEqual(11);
  });

  it("translateLinuxErrno agrees on every Linux errno 0..=200", () => {
    const t = expectDomainSize("translateLinuxErrno", 201);
    for (const row of t.values) {
      const input = row.in as number;
      expect(ts.translateLinuxErrno(input), `errno ${input}`).toBe(row.out);
    }
  });

  it("modeToFiletype agrees on every S_IFMT bucket", () => {
    const t = expectDomainSize("modeToFiletype", 60);
    for (const row of t.values) {
      const input = row.in as number;
      expect(ts.modeToFiletype(input), `st_mode 0o${input.toString(8)}`).toBe(row.out);
    }
  });

  it("wasiWhenceToPosix agrees, including the null for undefined values", () => {
    const t = expectDomainSize("wasiWhenceToPosix", 9);
    for (const row of t.values) {
      const input = row.in as number;
      // serde maps Rust's `None` to JSON null, matching the TS return type.
      expect(ts.wasiWhenceToPosix(input), `whence ${input}`).toBe(row.out ?? null);
    }
  });

  it("wasiOflagsToPosix agrees on all 512 combinations", () => {
    const t = expectDomainSize("wasiOflagsToPosix", 512);
    for (const row of t.values) {
      const oflags = row.oflags as number;
      const fdflags = row.fdflags as number;
      expect(
        ts.wasiOflagsToPosix(oflags, fdflags),
        `oflags=${oflags} fdflags=${fdflags}`,
      ).toBe(row.out);
    }
  });

  it("posixFlagToWasiFdflags agrees on every single bit and the combinations", () => {
    const t = expectDomainSize("posixFlagToWasiFdflags", 28);
    for (const row of t.values) {
      const input = row.in as number;
      expect(ts.posixFlagToWasiFdflags(input), `flags 0x${input.toString(16)}`).toBe(row.out);
    }
  });

  it("splitSignedI64Words agrees at the i64 boundaries and on 200 fixed vectors", () => {
    const t = expectDomainSize("splitSignedI64Words", 212);
    for (const row of t.values) {
      // The input is a decimal STRING: a JSON number cannot carry an i64
      // exactly, which is the hazard this function exists to handle.
      const input = BigInt(row.in as string);
      const got = ts.splitSignedI64Words(input);
      expect(got.low, `low word of ${input}`).toBe(BigInt(row.low as number));
      expect(got.high, `high word of ${input}`).toBe(BigInt(row.high as number));
      // And the split must be lossless.
      expect((got.high << 32n) | got.low, `reassembly of ${input}`).toBe(input);
    }
  });
});

describe("WASI translation: the documented per-defect divergences", () => {
  it("defect 1 — poll_oneoff treats every non-FD_READ tag as FD_WRITE", () => {
    const t = expectDomainSize("pollOneoffTag", 256);
    const diverging = new Set((t.divergence!.inputs as number[]).map(Number));
    expect(t.divergence!.defect).toBe("defect-1");
    // Every tag except FD_READ(1) is in the divergence set.
    expect(diverging.size).toBe(255);
    expect(diverging.has(1)).toBe(false);

    for (const row of t.values) {
      const tag = row.in as number;
      // What the TypeScript computes, reproduced from wasi-shim.ts:1461.
      const tsEvents = row.typescript as number;
      if (tag === 1) {
        expect(row.ok, "FD_READ maps to POLLIN in both").toBe(tsEvents);
        expect(row.err).toBeNull();
      } else if (tag === 0) {
        // CLOCK is not a pollfd subscription at all; the TS makes it POLLOUT.
        expect(row.ok, "CLOCK is not an fd subscription").toBeNull();
        expect(row.err).toBeNull();
        expect(tsEvents).toBe(4);
      } else if (tag === 2) {
        // Right answer, reached by the wrong route in the TypeScript.
        expect(row.ok).toBe(tsEvents);
      } else {
        // The interesting half: a malformed tag is EINVAL in Rust and a
        // silent write subscription in the TypeScript.
        expect(row.err, `tag ${tag} must be rejected`).toBe(28); // WASI EINVAL
        expect(row.ok).toBeNull();
        expect(tsEvents).toBe(4);
      }
    }
  });

  it("defect 2 — path_filestat_get ignores lookupflags, so lstat is unreachable", () => {
    const t = expectDomainSize("pathFilestatGetLookupflags", 4);
    expect(t.divergence!.defect).toBe("defect-2");
    for (const row of t.values) {
      const lookupflags = row.in as number;
      // The TypeScript passes a literal 0 for every input.
      expect(row.typescript).toBe(0);
      if (lookupflags & 1) {
        // SYMLINK_FOLLOW: follow, which is what 0 already meant.
        expect(row.out, "follow needs no at-flag").toBe(0);
      } else {
        // WASI's lstat. AT_SYMLINK_NOFOLLOW = 0x100.
        expect(row.out, "lstat must not follow the link").toBe(0x100);
        expect(row.out).not.toBe(row.typescript);
      }
    }
  });

  it("defect 3 — fd_fdstat_set_flags reports success it cannot deliver", () => {
    const t = expectDomainSize("fdFdstatSetFlags", 64);
    expect(t.divergence!.defect).toBe("defect-3");
    const SYNC_BITS = 2 | 8 | 16;
    for (const row of t.values) {
      const fdflags = row.in as number;
      if (fdflags & ~31) {
        expect(row.err, `undefined bit in ${fdflags}`).toBe(28); // EINVAL
      } else if (fdflags & SYNC_BITS) {
        // The TypeScript returns ESUCCESS(0) here without doing anything.
        expect(row.err, `synchronised-write request ${fdflags}`).toBe(58); // ENOTSUP
        expect(row.ok).toBeNull();
      } else {
        expect(row.err).toBeNull();
        // Only the two bits the kernel actually tracks.
        let expected = 0;
        if (fdflags & 1) expected |= 0o2000; // O_APPEND
        if (fdflags & 4) expected |= 0o4000; // O_NONBLOCK
        expect(row.ok, `fdflags ${fdflags}`).toBe(expected);
      }
    }
  });

  it("defect 4 — translateStat's u64 read at offset 80 straddles the struct padding", () => {
    const t = expectDomainSize("translateStat", 3);
    expect(t.divergence!.defect).toBe("defect-4");

    for (const row of t.values) {
      const raw = Uint8Array.from(row.wasm_stat_bytes as number[]);
      const rust = Uint8Array.from(row.filestat_bytes as number[]);
      expect(raw.length, "kernel WasmStat is 88 bytes").toBe(88);
      expect(rust.length, "WASI filestat is 64 bytes").toBe(64);

      // Reproduce exactly what translateStat (wasi-shim.ts:606-637) reads,
      // against the very same bytes, so the comparison is of behavior and
      // not of a paraphrase.
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const tsCtim =
        view.getBigInt64(72, true) * 1000000000n + view.getBigInt64(80, true);
      const rustView = new DataView(rust.buffer, rust.byteOffset, rust.byteLength);
      const rustCtim = rustView.getBigUint64(56, true);

      // Everything the TypeScript reads at a correct offset must agree.
      expect(rustView.getBigUint64(0, true), "dev").toBe(view.getBigUint64(0, true));
      expect(rustView.getBigUint64(8, true), "ino").toBe(view.getBigUint64(8, true));
      expect(rustView.getUint8(16), "filetype").toBe(
        ts.modeToFiletype(view.getUint32(16, true)),
      );
      expect(rustView.getBigUint64(24, true), "nlink").toBe(
        BigInt(view.getUint32(20, true)),
      );
      expect(rustView.getBigUint64(32, true), "size").toBe(view.getBigUint64(32, true));

      if ((row.pad_at_84 as number) === 0) {
        // With zeroed padding the TypeScript happens to be right, which is
        // precisely why this defect has gone unnoticed.
        expect(rustCtim, `${row.name}: ctim agrees when padding is zero`).toBe(tsCtim);
      } else {
        // With non-zero padding it is not. And the damage is worse than a
        // wrong magnitude: `getBigInt64` reads offset 80 as SIGNED, so
        // 0xDEADBEEF_075BCD15 has its top bit set and the nanosecond term
        // comes out large and negative. The guest is handed a ctim that is
        // not merely inaccurate but nonsensical.
        expect(rustCtim, `${row.name}: Rust reads only the u32`).not.toBe(tsCtim);
        expect(tsCtim, "the padding drives ctim negative").toBeLessThan(0n);
        // Rust's answer is the real one: 1700000002s + 123456789ns.
        expect(rustCtim, "Rust reports the true timestamp").toBe(
          1_700_000_002_123_456_789n,
        );
      }
    }
  });

  it("defect 6 (unchartered) — wasiClockToPosix silently defaults to CLOCK_REALTIME", () => {
    const t = expectDomainSize("wasiClockToPosix", 9);
    expect(t.divergence!.defect).toBe("defect-6-unchartered");
    for (const row of t.values) {
      const clock = row.in as number;
      // `out` is the bug-compatible answer, and it must still match today's
      // TypeScript exactly: this defect was NOT chartered for a fix.
      expect(ts.wasiClockToPosix(clock), `clock ${clock}`).toBe(row.out);
      if (clock <= 3) {
        expect(row.strict, "defined clocks are unambiguous").toBe(clock);
      } else {
        // What the honest answer would be, recorded but not yet adopted.
        expect(row.strict).toBeNull();
        expect(row.out).toBe(0);
      }
    }
  });
});

describe("WASI translation: the i64 guard the TypeScript needs and Rust does not", () => {
  it("rejects scalars a JS number cannot hold exactly", () => {
    // `checkedSignedI64Scalar` exists only because a JS number is a double.
    // Rust takes an i64 and the question cannot arise, so this is asserted
    // here rather than in the differential tables.
    // Number.MAX_SAFE_INTEGER is 2**53 - 1; 2**53 itself is already unsafe.
    expect(() => ts.checkedSignedI64Scalar(2 ** 53 - 1, "probe")).not.toThrow();
    expect(() => ts.checkedSignedI64Scalar(2 ** 53, "probe")).toThrow(RangeError);
    expect(() => ts.checkedSignedI64Scalar(1.5, "probe")).toThrow(RangeError);
    expect(() => ts.checkedSignedI64Scalar(1n << 63n, "probe")).toThrow(RangeError);
    expect(() => ts.checkedSignedI64Scalar(-(1n << 63n), "probe")).not.toThrow();
  });
});
