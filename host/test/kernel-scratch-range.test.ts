import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  checkedMemoryRange,
  checkedWasmImportMemoryRange,
} from "../src/kernel-scratch";

/**
 * The TypeScript half of the one-bounds-rule contract.
 *
 * `crates/shared/tests/host-memory-ranges.json` states the rule once;
 * `crates/shared/tests/host_memory_range.rs` fails the Rust host against it
 * and this file fails the TypeScript hosts against the same statement.
 *
 * **Why a shared statement rather than a shared implementation.** The Rust
 * host calls `wasm_posix_shared::host_memory::checked_range` directly. These
 * functions do not: a bounds check runs on the syscall hot path, and reaching
 * the shared function through the artifact module would put a wasm call, an
 * input copy and an output decode on every syscall argument — a cost
 * `docs/agent-guidance/performance.md` does not treat as a refactor. So this
 * host keeps its own arithmetic, and the corpus is what keeps the two
 * arithmetics from meaning different things.
 */

const CORPUS = JSON.parse(
  readFileSync(
    new URL(
      "../../crates/shared/tests/host-memory-ranges.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  cases: readonly {
    name: string;
    addr: number;
    len: number;
    limitPages: number;
    allowAddressZero?: boolean;
    rustOnly?: boolean;
    verdict: "ok" | "null-pointer" | "out-of-bounds" | "end-overflows";
  }[];
};

function memoryOf(pages: number): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: pages });
}

describe("one bounds-check rule", () => {
  const presentable = CORPUS.cases.filter((entry) => !entry.rustOnly);

  it("has cases this host can present", () => {
    // A corpus that drifted to all-`rustOnly` would leave this file asserting
    // nothing while still reporting a pass — the failure mode the whole
    // shared-corpus arrangement exists to avoid. The floor tracks the corpus:
    // raise it when cases are added, never lower it to make a run pass.
    expect(presentable.length).toBeGreaterThanOrEqual(11);
  });

  it("is still read by the Rust half, which is the other half of the claim", () => {
    // The Rust side asserts this file still reads the corpus. This is the
    // mirror, and the pair is the point: "one corpus, both hosts" is a claim
    // about two files, and either one going quiet makes it false while the
    // other stays green.
    //
    // The Rust direction is the one the campaign actually pushes, since its
    // purpose is removing TypeScript. This direction guards the rarer case --
    // a crate restructure that moves or drops the Rust consumer -- and it
    // exists so the pairing needs no argument about which way is likelier.
    const rustHalf = new URL(
      "../../crates/shared/tests/host_memory_range.rs",
      import.meta.url,
    );
    let source: string;
    try {
      source = readFileSync(rustHalf, "utf8");
    } catch (error) {
      // Not a bare ENOENT: a reader who hits this needs to know what it
      // means, not which syscall failed.
      throw new Error(
        `the Rust half of this corpus is unreadable at ${rustHalf.pathname}: `
          + `${error}. If it was deleted on purpose, this corpus is `
          + "single-host now and both this test and the corpus header must "
          + "say so.",
      );
    }
    // The READ, not a mention: `include_str!(...)`. Asserting the filename
    // appears somewhere is satisfied by a doc comment, so a Rust half that
    // stopped reading the corpus but kept its header would have passed.
    // `cargo xtask perturb` kept that mutant alive until this was fixed.
    expect(
      source.includes(`include_str!("host-memory-ranges.json")`),
      "the Rust half no longer reads this corpus, so the bounds rule is checked in "
        + "one host while the corpus still calls itself shared. Say so here "
        + "and in the corpus header, or restore the read.",
    ).toBe(true);
  });

  it("skips a case only for the reason that is true of it", () => {
    // The marker alone is not evidence. A case marked `rustOnly` for a
    // reason this host does not actually have would be skipped in silence,
    // and a skip nobody checked reads exactly like a pass — which is how the
    // layout corpus came to be checked in one host while claiming two.
    //
    // The one reason a JavaScript host cannot present a range case is an
    // address it cannot name exactly. `checkedWasmGuestPointerOffset`
    // refuses anything above Number.MAX_SAFE_INTEGER before a range is
    // considered, and that is a limit `crates/host-native` does not have,
    // because it takes a u64 from a memory64 guest.
    for (const entry of CORPUS.cases.filter((c) => c.rustOnly)) {
      expect(
        entry.addr > Number.MAX_SAFE_INTEGER,
        `${entry.name}: marked rustOnly, but this host can name address `
          + `${entry.addr} perfectly well`,
      ).toBe(true);
    }
  });

  for (const entry of presentable) {
    it(`${entry.name}`, () => {
      const memory = memoryOf(entry.limitPages);
      const allowAddressZero = entry.allowAddressZero ?? false;
      const run = () =>
        checkedMemoryRange(
          memory,
          entry.addr,
          entry.len,
          4,
          "corpus range",
          allowAddressZero,
        );

      if (entry.verdict === "ok") {
        const range = run();
        expect(range.pointer).toBe(entry.addr);
        expect(range.length).toBe(entry.len);
        expect(range.end).toBe(entry.addr + entry.len);
        return;
      }
      // This host reports one refusal for a null pointer and another for
      // everything that leaves the memory; the corpus distinguishes them so a
      // host that collapsed the two would be visible here.
      expect(run).toThrow(
        entry.verdict === "null-pointer"
          ? "uses a null pointer"
          : "is outside its owned range",
      );
    });
  }

  /**
   * The import path normalizes an i32 before it judges a range, and that
   * normalization is not part of the shared rule — it is what a WebAssembly
   * import does to a wasm32 pointer on the way into JavaScript. The rule must
   * still be the one the corpus states once the bits are normalized.
   */
  it("judges a negative i32 import pointer by the same rule, after normalizing it", () => {
    const memory = memoryOf(1);
    // -4 as an i32 is 0xfffffffc: a real wasm32 address, and one far outside
    // a single-page memory.
    expect(() =>
      checkedWasmImportMemoryRange(memory, -4, 1, 4, "import range")
    ).toThrow("is outside its owned range");
    // A positive pointer is unchanged by normalization and keeps its verdict.
    const range = checkedWasmImportMemoryRange(memory, 65532, 4, 4, "import range");
    expect(range.end).toBe(65536);
  });
});
