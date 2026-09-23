import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";

/**
 * The module half of the KFMS arena (census sections 132 and 133).
 *
 * The host's `ForkModuleStateArena` still owns the live path. These pin the
 * module's side of the ownership handoff BEFORE the switch, because the switch
 * cannot be made a method at a time: the module allocates the arena chunks and
 * the host frees them, having rediscovered the addresses by walking a linked
 * list in guest memory. If both free, a fork double-munmaps. If neither does,
 * it leaks.
 */

const OP_ROOT = 0;
const OP_ADOPT = 1;
const OP_RELEASE = 2;
const OP_OWNED = 3;

interface Fm {
  readonly errno: () => number;
  arena(op: number, arg?: number): number;
}

function freshModule(): Fm {
  const buf = readFileSync(resolveBinary("fork_module32.wasm"));
  const memory = new WebAssembly.Memory({
    initial: 256,
    maximum: 16384,
    shared: true,
  });
  const fm = instantiateForkModule({
    module: new WebAssembly.Module(buf),
    memory,
    reserve: () => 8 * 1024 * 1024,
    label: "arena test",
  });
  const exports = fm.exports as Record<string, unknown>;
  // `fm_set_format` is the module's first call of a worker's setup; without it
  // there is no module state at all and every entry here answers EINVAL. That
  // is the right answer for an unset-up module -- mapping it to a valid "no
  // arena" would hide a setup bug behind a plausible number -- so the test does
  // the setup rather than the module relaxing the check.
  (exports.fm_set_format as (pw: number, fixedPrefix: number) => void)(4, 0);
  const call = exports.fm_module_state_arena as (o: number, a: number) => bigint;
  return {
    errno: () => (exports.fm_last_errno as () => number)(),
    arena: (op, arg = 0) => Number(call(op, arg)),
  };
}

/**
 * WHAT THESE DO NOT COVER, and why it is not hidden.
 *
 * ADOPT and RELEASE need module state, and module state is created by
 * `begin_unwind_impl` -- so reaching them means driving a real capture with a
 * live guest, which no test at this layer does. Their LOGIC is covered where it
 * lives, in `ModuleStateWriter`'s own tests (`adopt` refusing a live root, a
 * second adoption and the zero sentinel; `reserve` refusing while adopted),
 * each perturbed until the test written for it failed. What is uncovered is the
 * entry's dispatch onto them.
 *
 * Writing tests that pass without exercising that would be worse than the gap.
 */
describe("module-state arena, module half", () => {
  it("separates a query from a mutation when no fork has begun", () => {
    // A worker where no fork has started unwinding has no module state, and so
    // genuinely has no arena. For the QUERIES that is the truthful answer
    // rather than a default -- the same reasoning `fm_phase` uses for answering
    // idle before any activation exists. A MUTATION against state that does not
    // exist is a caller error, and must not read as a successful no-op.
    const buf = readFileSync(resolveBinary("fork_module32.wasm"));
    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 16384,
      shared: true,
    });
    const fm = instantiateForkModule({
      module: new WebAssembly.Module(buf),
      memory,
      reserve: () => 8 * 1024 * 1024,
      label: "unset-up",
    });
    const exports = fm.exports as Record<string, unknown>;
    const call = exports.fm_module_state_arena as (o: number, a: number) => bigint;
    const errno = exports.fm_last_errno as () => number;
    expect(Number(call(OP_ROOT, 0))).toBe(0);
    expect(errno()).toBe(0);
    expect(Number(call(OP_OWNED, 0))).toBe(0);
    expect(errno()).toBe(0);
    expect(Number(call(OP_ADOPT, 0x4000))).toBe(-1);
    expect(errno()).not.toBe(0);
    expect(Number(call(OP_RELEASE, 0))).toBe(-1);
    expect(errno()).not.toBe(0);
  });

  it("reports no arena before one exists, rather than an address", () => {
    const fm = freshModule();
    expect(fm.arena(OP_ROOT)).toBe(0);
    // Owning nothing is the state a release must be a no-op from. The host's
    // arena distinguishes this with an `ownership` field; here it falls out of
    // whether any chunk was mapped.
    expect(fm.arena(OP_OWNED)).toBe(0);
  });





  it("refuses an operation it does not have", () => {
    // Contract, not guard isolation, and worth being explicit about which. In
    // the configuration this test can reach there is no module state, so the
    // refusal comes from the no-state match rather than from the one that runs
    // once a fork is unwinding. Both are exhaustive over the four operations
    // and refuse everything else the same way, which is why there is no
    // separate `op > 3` pre-check: a pre-check here would be a guard whose
    // removal no test could detect.
    const fm = freshModule();
    expect(fm.arena(4)).toBe(-1);
    expect(fm.errno()).not.toBe(0);
  });
});
