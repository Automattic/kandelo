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
    // shared-corpus arrangement exists to avoid.
    expect(presentable.length).toBeGreaterThanOrEqual(8);
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
