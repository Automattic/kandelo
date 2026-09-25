import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";

/**
 * Sizing a vfork BORROWED child's private workspace, which the module now owns.
 *
 * It used to be `ForkProcessContinuationCoordinator.borrowedReplayWorkspace`
 * `Requirements()`, which reached into every activation's frame format for its
 * fixed prefix and into the capture session for the reference-scratch
 * high-water. Both are module bookkeeping; the host was reading them through a
 * JS mirror. These tests pin the two properties that mirror kept getting to
 * decide for itself: that the answer is refused before it can be an undercount,
 * and that the two halves are measured differently on purpose.
 */

const EBUSY = 16;
const FIELD_PREFIX = 0;
const FIELD_SCRATCH = 1;

interface Fm {
  readonly errno: () => number;
  call(name: string, ...args: number[]): number;
  workspace(field: number): bigint;
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
    label: "borrowed workspace test",
  });
  const exports = fm.exports as Record<string, unknown>;
  return {
    errno: () => (exports.fm_last_errno as () => number)(),
    call(name, ...args) {
      return Number((exports[name] as (...a: number[]) => number)(...args) ?? 0);
    },
    workspace: exports.fm_borrowed_replay_workspace as (f: number) => bigint,
  };
}

describe("borrowed replay workspace sizing", () => {
  it("refuses to size a workspace before the capture has sealed", () => {
    // The guard that matters most, because failing it is SILENT. A fresh module
    // is idle: no activation has registered and no scratch has been reserved,
    // so an answer here would be 0 for both fields -- a perfectly plausible
    // number that reserves nothing, and the child then rewinds into the parked
    // parent's prefix. Refusing is the only safe answer off-phase.
    const fm = freshModule();
    expect(Number(fm.workspace(FIELD_PREFIX))).toBe(-1);
    expect(fm.errno()).toBe(EBUSY);
    expect(Number(fm.workspace(FIELD_SCRATCH))).toBe(-1);
    expect(fm.errno()).toBe(EBUSY);
  });

  it("refuses a field it does not have, and says so differently", () => {
    // EINVAL rather than EBUSY: an unknown field is a host that asked the wrong
    // question, not a host that asked at the wrong time, and a caller that
    // retries after a seal must not be told to retry forever.
    const fm = freshModule();
    expect(Number(fm.workspace(2))).toBe(-1);
    expect(fm.errno()).not.toBe(EBUSY);
  });

  it("does not advance the phase by refusing", () => {
    // A guard that rejects the call but moves the state anyway lets the NEXT
    // out-of-order call through, and asserting the errno alone would not see it.
    //
    // The witness has to be a call legal ONLY from idle, reached AFTER the
    // refusal. Asserting that some other out-of-order call is still refused
    // does not work: if the refusal moved the phase to sealed-parent, a seal is
    // refused from there too, for a different reason, and the test passes while
    // the machine is wrong. This version was written the weak way first and
    // caught nothing when the perturbation was applied.
    const fm = freshModule();
    fm.workspace(FIELD_PREFIX);
    // Legal from idle and fails for its OWN reason (it needs a live guest), so
    // reaching that failure at all proves the phase gate let it through.
    fm.call("fm_parent_begin_capture", 0, 0);
    expect(fm.errno()).not.toBe(EBUSY);
  });
});
