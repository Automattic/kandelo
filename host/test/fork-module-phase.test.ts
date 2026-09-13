import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";

/**
 * The fork lifecycle phase machine, which the module owns.
 *
 * It used to live in `ForkProcessContinuationCoordinator` as a TypeScript
 * `requirePhase(expected, operation)` in front of every coarse module call.
 * That put the rule -- "you cannot seal a capture you never began" -- in the
 * layer being sequenced rather than the layer doing the work, so every host
 * reimplemented it, and a host that got it wrong called the module out of order
 * with no way to be refused. These tests are the refusal.
 *
 * # Why there is no phase accessor to assert against
 *
 * The obvious test reads an `fm_phase()` export and asserts a number. I wrote
 * that first and removed it: it adds an `fm_*` entry to a surface the campaign
 * is driving toward five, and it does so for a caller that is a test. So every
 * assertion here is BEHAVIOURAL -- a refused call is followed by a legal one,
 * which can only succeed if the refusal left the phase where it was. That is
 * also the stronger claim. An accessor can agree with a broken machine.
 *
 * # Why EBUSY
 *
 * The module answers `EBUSY` for a wrong-phase call and for nothing else. It
 * answers `EINVAL` at over two hundred sites, so a test asserting EINVAL would
 * pass against a module with no phase machine at all -- any argument check
 * firing for an unrelated reason satisfies it.
 */

const EBUSY = 16;

interface Fm {
  readonly errno: () => number;
  readonly exports: Record<string, unknown>;
  call(name: string, ...args: number[]): number;
}

function freshModule(): Fm {
  const buf = readFileSync(resolveBinary("fork_module32.wasm"));
  const module = new WebAssembly.Module(buf);
  const memory = new WebAssembly.Memory({
    initial: 256,
    maximum: 16384,
    shared: true,
  });
  const base = 8 * 1024 * 1024;
  const fm = instantiateForkModule({
    module,
    memory,
    ptrWidth: 4,
    reserve: () => base,
    label: "phase test",
  });
  const exports = fm.exports as Record<string, unknown>;
  return {
    exports,
    errno: () => (exports.fm_last_errno as () => number)(),
    call(name, ...args) {
      return Number((exports[name] as (...a: number[]) => number)(...args) ?? 0);
    },
  };
}

/**
 * A call that is legal from idle and fails for its OWN reason, not the phase's.
 *
 * Used after a refusal to prove the module is still idle. Its argument failure
 * is the point: a real capture would need a live guest, but reaching the
 * argument check at all means the phase gate let it through.
 */
function idleIsStillReachable(fm: Fm): boolean {
  fm.call("fm_parent_begin_capture", 0, 0, 0, 0);
  return fm.errno() !== EBUSY;
}

describe("fork module lifecycle phase", () => {
  it("refuses to seal a capture that never began", () => {
    const fm = freshModule();
    fm.call("fm_parent_seal_capture", 0);
    expect(fm.errno()).toBe(EBUSY);
    // The refusal must not itself advance the phase. A guard that rejects the
    // call but moves the state anyway lets the NEXT out-of-order call through,
    // and asserting only the errno above would not notice.
    expect(idleIsStillReachable(fm)).toBe(true);
  });

  it("refuses to replay from idle", () => {
    const fm = freshModule();
    fm.call("fm_parent_replay", 0);
    expect(fm.errno()).toBe(EBUSY);
    expect(idleIsStillReachable(fm)).toBe(true);
  });

  it("refuses to finish a replay that never began", () => {
    const fm = freshModule();
    fm.call("fm_parent_finish", 0);
    expect(fm.errno()).toBe(EBUSY);
    expect(idleIsStillReachable(fm)).toBe(true);
  });

  it("refuses an abort finish from idle", () => {
    const fm = freshModule();
    fm.call("fm_parent_finish", 1);
    expect(fm.errno()).toBe(EBUSY);
    expect(idleIsStillReachable(fm)).toBe(true);
  });

  it("guards the two finish arguments with DIFFERENT phase sets", () => {
    // This one is a source assertion rather than a behavioural one, and the
    // reason is worth stating because I tried the behavioural version first and
    // it could not fail.
    //
    // `fm_parent_finish(0)` is legal from parent-replay or child-replay;
    // `fm_parent_finish(1)` only from abort-replay. Telling those apart from
    // OUTSIDE requires standing in parent-replay and calling finish(1) -- and
    // reaching parent-replay needs a real capture over a live guest, which this
    // unit test does not have. Called from idle, both arguments are refused
    // whether or not the branch exists, so a test that called finish(1) from
    // idle and claimed to prove the abort branch was proving nothing. It passed
    // with the branch collapsed.
    //
    // The end-to-end coverage of the abort branch is
    // `fork-module-kernel-abort.test.ts`, which drives a real ENOMEM child
    // launch failure through abort replay. What is pinned here is only that the
    // two branches remain distinct in the source.
    const source = readFileSync(
      new URL("../../crates/fork-module/src/lib.rs", import.meta.url),
      "utf8",
    );
    // Bounded at the NEXT export, not by a character count. A fixed window
    // spills into the following function's doc comment, and a guard mentioned
    // there would satisfy this pin without `fm_parent_finish` containing it.
    const from = source.indexOf('pub extern "C" fn fm_parent_finish');
    const rest = source.slice(from);
    const end = rest.indexOf("#[unsafe(no_mangle)]");
    expect(end).toBeGreaterThan(0);
    const finish = rest.slice(0, end);
    expect(finish).toMatch(/require_phase\(PHASE_ABORT_REPLAY\)/);
    expect(finish).toMatch(
      /require_phase_either\(PHASE_PARENT_REPLAY, PHASE_CHILD_REPLAY\)/,
    );
  });

  it("refuses an abort-seal outside capture", () => {
    const fm = freshModule();
    fm.call("fm_parent_abort_seal");
    expect(fm.errno()).toBe(EBUSY);
    expect(idleIsStillReachable(fm)).toBe(true);
  });

  it("distinguishes a wrong-phase refusal from every other failure", () => {
    // The point of EBUSY. Without this, every assertion above would pass
    // against a module whose entry points simply reject their arguments.
    const fm = freshModule();
    fm.call("fm_parent_begin_capture", 0, 0, 0, 0);
    expect(fm.errno()).not.toBe(EBUSY);
    expect(fm.errno()).not.toBe(0);
  });

  it("accepts abort from idle, so a teardown can never be refused", () => {
    // `fm_abort` is the path a failed fork unwinds through. A teardown that can
    // itself be refused leaves the process stuck in the phase it is trying to
    // leave, so this one is legal everywhere -- including idle, where there is
    // nothing to tear down.
    const fm = freshModule();
    fm.call("fm_abort");
    expect(fm.errno()).not.toBe(EBUSY);
    expect(idleIsStillReachable(fm)).toBe(true);
  });

  it("names one wrong-phase errno, used for nothing else in the module", () => {
    // If EBUSY ever acquires a second meaning here, the tests above stop being
    // able to tell a phase refusal from that other thing, and they will keep
    // passing while they do it.
    const source = readFileSync(
      new URL("../../crates/fork-module/src/lib.rs", import.meta.url),
      "utf8",
    );
    const uses = source.match(/Errno::EBUSY/g) ?? [];
    // Exactly the two guards: `require_phase` and `require_phase_either`.
    expect(uses.length).toBe(2);
  });
});
