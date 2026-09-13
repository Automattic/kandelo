import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  getInstalledModule,
  setInstalledModule,
} from "../src/wasm-artifact-module-registry";
import {
  CHANNEL_PAGES,
  computeProcessMemoryLayout,
  DEFAULT_PROCESS_INITIAL_PAGES,
  DEFAULT_PROCESS_THREAD_SLOTS,
  PROCESS_FALLBACK_BRK_BASE,
  type ProcessMemoryLayout,
} from "../src/process-memory";
import { extractHeapBase, extractThreadSlotDeclaration, WASM_PAGE_SIZE } from "../src/constants";
import { PROCESS_MEMORY_MAIN_CHANNEL_PRIMARY_PAGE } from "../src/generated/abi";

/**
 * The TypeScript half of the one-layout contract.
 *
 * `computeProcessMemoryLayout` no longer does the arithmetic: it asks
 * `wasm_posix_shared::process_memory::compute_layout` through the
 * `wa_process_memory_layout` export, which is the same function
 * `crates/host-native` calls. This file is what makes that a checked fact.
 *
 * It checks two different things, and the difference matters:
 *
 *  * **The rule**, against `crates/shared/tests/process-memory-layouts.json` —
 *    expectations derived BY HAND from the documented rule, read by the Rust
 *    test at `crates/shared/tests/process_memory_layout.rs` as well. One
 *    corpus, both hosts.
 *  * **The migration**, against the arithmetic this host used to carry, kept
 *    below as an oracle and run over every program binary in the tree. An
 *    oracle written from the code under test proves nothing; this one is the
 *    independent implementation that was there before, which is the only
 *    second opinion available.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const CORPUS_TEXT = readFileSync(
  new URL(
    "../../crates/shared/tests/process-memory-layouts.json",
    import.meta.url,
  ),
  "utf8",
);

/**
 * Every `heapBase` literal lifted to a string BEFORE `JSON.parse` sees it.
 *
 * What matters on this path is that the value reaches the entry point as a
 * `bigint`. The corpus carries a heap base of 2^63, and as a NUMBER that is
 * not a safe integer, so the host's own `layoutAddressIn` rejects it —
 * `invalid heap base: ...` — before the shared rule ever runs. A loop that
 * only asserted "it threw" would pass on that and call it agreement about a
 * rule it never reached.
 *
 * The text lifting is the narrower half, and its honest status is that
 * removing it changes no verdict in today's corpus: 2^63 is exactly
 * representable as a double, so `JSON.parse` returns the true value and only
 * PRINTS it as 9223372036854776000. That is not luck that generalises — but
 * it nearly does, because the page ceiling is a `u32`, so every heap base a
 * layout can accept is below 2^48 and exactly representable, and every one
 * far above it saturates to the same refusal. What the lifting buys is that
 * exactness is structural rather than argued: a future corpus literal that a
 * double cannot hold would otherwise be rounded on the way in, with nothing
 * failing.
 */
const CORPUS = JSON.parse(
  CORPUS_TEXT.replace(/("heapBase":\s*)(\d+)/g, '$1"$2"'),
) as {
  cases: readonly {
    name: string;
    request: {
      maximumPages: number;
      importedMinimumPages: number;
      requestedMinimumPages: number;
      heapBase: string | null;
      threadSlotCount: number;
    };
    layout: Record<string, number>;
    /** Declared when only a program's bytes can present this case. */
    programBytesOnly?: boolean;
  }[];
  refusals: readonly {
    name: string;
    request: {
      maximumPages: number;
      importedMinimumPages: number;
      requestedMinimumPages: number;
      heapBase: string | null;
      threadSlotCount: number;
    };
    message: string;
  }[];
};

/** A corpus heap base as the entry point wants it, exactly. */
function corpusHeapBase(raw: string | null): bigint | null {
  return raw === null ? null : BigInt(raw);
}

// ---------------------------------------------------------------------------
// The oracle: the arithmetic this file's subject used to perform
// ---------------------------------------------------------------------------

interface OracleOptions {
  maxPages: number;
  programBytes?: ArrayBuffer;
  heapBase?: bigint | number | null;
  minPages?: number;
  defaultThreadSlots?: number;
  threadSlots?: number;
}

/**
 * `computeProcessMemoryLayout` as it stood before the shared function replaced
 * it, transcribed verbatim apart from reading the imported-memory minimum
 * through the artifact reader rather than through the hand-rolled LEB128 walk
 * that went with it.
 *
 * Kept HERE rather than in `src/`: it is a second opinion for a test, not a
 * second implementation for a host to accidentally call.
 */
function oracleLayout(options: OracleOptions): ProcessMemoryLayout {
  const maximumPages = options.maxPages;
  if (!Number.isInteger(maximumPages) || maximumPages <= CHANNEL_PAGES) {
    throw new Error(`invalid process maximum pages: ${maximumPages}`);
  }

  const importedMinPages = options.programBytes
    ? importedMemoryMinimumPagesOracle(options.programBytes) ?? 0
    : 0;
  const minPages = Math.max(
    DEFAULT_PROCESS_INITIAL_PAGES,
    options.minPages ?? 0,
    importedMinPages,
  );

  const heapBaseValue = options.heapBase;
  const heapBase = heapBaseValue == null
    ? null
    : typeof heapBaseValue === "bigint"
    ? Number(heapBaseValue)
    : heapBaseValue;
  const firstFreeByte = Math.max(
    heapBase ?? PROCESS_FALLBACK_BRK_BASE,
    minPages * WASM_PAGE_SIZE,
  );
  const controlBase = Math.ceil(firstFreeByte / WASM_PAGE_SIZE) * WASM_PAGE_SIZE;
  const controlBasePage = controlBase / WASM_PAGE_SIZE;

  const declared = options.programBytes
    ? extractThreadSlotDeclaration(options.programBytes)
    : null;
  const hostDefault = options.defaultThreadSlots ?? DEFAULT_PROCESS_THREAD_SLOTS;
  const threadSlotCount = options.threadSlots !== undefined
    ? options.threadSlots
    : declared === null || declared === -1
    ? hostDefault
    : declared;

  const channelPage = controlBasePage + PROCESS_MEMORY_MAIN_CHANNEL_PRIMARY_PAGE;
  const channelOffset = channelPage * WASM_PAGE_SIZE;
  const controlEndPage = channelPage + CHANNEL_PAGES;
  const initialPages = Math.max(minPages, controlEndPage);
  if (initialPages > maximumPages) {
    throw new Error(
      `initial pages ${initialPages} exceed process maximum ${maximumPages}`,
    );
  }

  const brkBase = controlEndPage * WASM_PAGE_SIZE;
  const maxAddr = maximumPages * WASM_PAGE_SIZE;
  return {
    initialPages,
    maximumPages,
    controlBase,
    controlEnd: brkBase,
    channelOffset,
    channelPage,
    brkBase,
    mmapBase: brkBase,
    brkLimit: maxAddr,
    maxAddr,
    threadSlotCount,
  };
}

/** The imported memory's minimum, read the way the oracle's era read it. */
function importedMemoryMinimumPagesOracle(bytes: ArrayBuffer): number | null {
  const buf = new Uint8Array(bytes);
  if (
    buf.length < 8 || buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73
    || buf[3] !== 0x6d
  ) {
    return null;
  }
  let off = 8;
  const uleb = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = buf[off++];
      result |= (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
  };
  const skipLimits = (): void => {
    const flags = uleb();
    uleb();
    if ((flags & 0x01) !== 0) uleb();
  };
  while (off < buf.length) {
    const sectionId = buf[off++];
    const sectionSize = uleb();
    const sectionEnd = off + sectionSize;
    if (sectionId !== 2) {
      off = sectionEnd;
      continue;
    }
    const importCount = uleb();
    for (let i = 0; i < importCount; i++) {
      // NOT `off += uleb()`. A compound assignment reads its left operand
      // BEFORE evaluating the right, and `uleb()` advances `off` past the
      // length prefix as a side effect — so `off += uleb()` discards that
      // advance and loses one byte per name. Across 68 imports that is 136
      // bytes of drift, and this walk read `kind 103` where `env.memory`
      // should have been, returning null for a program that imports 533
      // pages. It agreed with the Rust reader only for programs whose
      // imports it never had to walk.
      const moduleNameLength = uleb();
      off += moduleNameLength;
      const fieldNameLength = uleb();
      off += fieldNameLength;
      const kind = buf[off++];
      if (kind === 0x00) uleb();
      else if (kind === 0x01) {
        off += 1;
        skipLimits();
      } else if (kind === 0x02) {
        uleb();
        return uleb();
      } else if (kind === 0x03) off += 2;
      else if (kind === 0x04) {
        off += 1;
        uleb();
      } else return null;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------

function programBinaries(): { path: string; bytes: ArrayBuffer }[] {
  const found: { path: string; bytes: ArrayBuffer }[] = [];
  for (const arch of ["wasm32", "wasm64"]) {
    const dir = `${REPO_ROOT}local-binaries/programs/${arch}`;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".wasm")) continue;
      const file = readFileSync(`${dir}/${name}`);
      found.push({
        path: `${arch}/${name}`,
        bytes: file.buffer.slice(
          file.byteOffset,
          file.byteOffset + file.byteLength,
        ) as ArrayBuffer,
      });
    }
  }
  return found;
}

describe("one process memory layout", () => {
  it("places every corpus case where the hand-derived rule says", () => {
    // A heap base is NOT a program-bytes-only fact: `heapBase` is an option
    // this entry point takes and honours, which is how a caller places a
    // layout for a process whose program it has not read. Only an imported
    // memory's minimum needs a real binary, and the corpus declares those
    // cases rather than leaving this filter to infer them — a skip nobody
    // declared reads exactly like a pass.
    const skipped = CORPUS.cases.filter((entry) => entry.programBytesOnly);
    const reachable = CORPUS.cases.filter((entry) => !entry.programBytesOnly);
    // Every declared skip is declared for the one reason that is true of it.
    for (const entry of skipped) {
      expect(entry.request.importedMinimumPages).toBeGreaterThan(0);
    }
    // A corpus edit that dropped cases, or marked one skipped to quiet a
    // failure, would otherwise leave this assertion running over a short list
    // and still report a pass. The floor tracks the corpus: raise it when
    // cases are added, never lower it to make a run pass.
    expect(reachable.length).toBeGreaterThanOrEqual(8);
    for (const entry of reachable) {
      const layout = computeProcessMemoryLayout({
        ptrWidth: 4,
        maxPages: entry.request.maximumPages,
        minPages: entry.request.requestedMinimumPages,
        heapBase: corpusHeapBase(entry.request.heapBase),
        threadSlots: entry.request.threadSlotCount,
      });
      expect({ name: entry.name, ...layout }).toEqual({
        name: entry.name,
        ...entry.layout,
      });
    }
  });

  it("agrees with the arithmetic it replaced, for every program in the tree", () => {
    const programs = programBinaries();
    // A tree with no programs would make this test pass by measuring nothing,
    // which is the failure mode the whole file exists to avoid.
    expect(programs.length).toBeGreaterThan(20);

    for (const program of programs) {
      for (const maxPages of [16384, 4096]) {
        for (const defaultThreadSlots of [DEFAULT_PROCESS_THREAD_SLOTS, 8]) {
          const heapBase = extractHeapBase(program.bytes);
          const expected = oracleLayout({
            maxPages,
            programBytes: program.bytes,
            heapBase,
            defaultThreadSlots,
          });
          const actual = computeProcessMemoryLayout({
            ptrWidth: 4,
            maxPages,
            programBytes: program.bytes,
            heapBase,
            defaultThreadSlots,
          });
          expect({ program: program.path, maxPages, ...actual }).toEqual({
            program: program.path,
            maxPages,
            ...expected,
          });
        }
      }
    }
  });

  it("refuses a page count the wire would silently change", () => {
    // The encoder writes four bytes of whatever it is handed, so a
    // non-integer would arrive truncated and a negative one enormous — a
    // layout placed from a number nobody asked for. The replaced arithmetic
    // opened with this check and it had to survive the move to Rust.
    expect(() => computeProcessMemoryLayout({ ptrWidth: 4, maxPages: 16384.5 }))
      .toThrow("invalid process maximum pages: 16384.5");
    expect(() => computeProcessMemoryLayout({ ptrWidth: 4, maxPages: -1 }))
      .toThrow("invalid process maximum pages: -1");
    expect(() =>
      computeProcessMemoryLayout({ ptrWidth: 4, maxPages: 16384, threadSlots: -3 })
    ).toThrow("invalid process thread slot count: -3");
  });

  /**
   * The load-time surface check deliberately does NOT require this entry
   * point, so that a module staged before it existed still installs and the
   * build that replaces it can run (see `installWasmArtifactModule`). That
   * makes this the only thing standing between a stale module and a silently
   * wrong answer, so it has to be seen refusing one.
   */
  it("names the rebuild when the installed module predates this entry point", () => {
    const real = getInstalledModule() as Record<string, unknown> | null;
    expect(real).not.toBeNull();
    const withoutLayout: Record<string, unknown> = { ...real };
    delete withoutLayout.wa_process_memory_layout;
    setInstalledModule(withoutLayout);
    try {
      expect(() => computeProcessMemoryLayout({ ptrWidth: 4, maxPages: 16384 }))
        .toThrow("predates this entry point");
    } finally {
      setInstalledModule(real);
    }
    // And the real module still answers, so the stand-in was the only change.
    expect(
      computeProcessMemoryLayout({ ptrWidth: 4, maxPages: 16384 }).channelPage,
    ).toBe(257);
  });

  it("refuses every corpus refusal, with the message the rule gives", () => {
    // This replaces two hand-written refusals that restated corpus entries 0
    // and 1 in the test file. Five are now driven from the corpus the Rust
    // side reads, which is what "one rule, both hosts" has to mean for the
    // reject half as well as the accept half.
    expect(CORPUS.refusals.length).toBeGreaterThanOrEqual(5);
    for (const refusal of CORPUS.refusals) {
      // Not `.toThrow(refusal.message)` alone. A refusal is only evidence
      // about the rule if the rule is what refused: `layoutAddressIn`
      // rejects an out-of-range heap base with `invalid heap base: ...`
      // BEFORE the request reaches the shared function, and a loop that
      // only asserted "it threw" would pass on that and call it agreement.
      let thrown: unknown;
      expect(() => {
        try {
          computeProcessMemoryLayout({
            ptrWidth: 4,
            maxPages: refusal.request.maximumPages,
            minPages: refusal.request.requestedMinimumPages,
            heapBase: corpusHeapBase(refusal.request.heapBase),
            threadSlots: refusal.request.threadSlotCount,
          });
        } catch (error) {
          thrown = error;
          throw error;
        }
      }).toThrow(refusal.message);
      // `includes`, not `startsWith`: the driver prefixes its errors with
      // the export name, so a prefix test here could never fire — a guard
      // that cannot fail, which is the hazard this lane keeps filing.
      expect(
        `${(thrown as Error).message}`.includes("invalid heap base"),
        `${refusal.name}: refused by the host's own argument check, not by `
          + "the rule under test",
      ).toBe(false);
    }
  });
});
