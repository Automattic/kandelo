import { afterEach, expect, it } from "vitest";
import {
  applyNativeChanges, hasNativeRepair, nativeInverse, NativeGlFault, setNativeGlFaultReporter,
  type NativeCall,
} from "../src/webgl/native-recovery";
import type { CheckedGlOwner } from "../src/webgl/program-objects";

type Fault = { op: number; kind: "flags" | "throw" | "post" | "getter"; after?: boolean; flags?: number[] };
function fixture(initialFault?: Fault) {
  const pending: number[] = [], attempts: number[] = [], state = new Map<number, unknown[]>();
  let fault = initialFault, reads = 0, postThrow = false, forward = 0, lost = false;
  const names = ["bindFramebuffer", "readBuffer", "bindBuffer", "pixelStorei", "disable"] as const;
  const raw: Record<string, unknown> = {
    getError() {
      expect(this).toBe(raw); reads++;
      if (postThrow) { postThrow = false; throw Error("post-check refused"); }
      const error = pending.shift() ?? 0;
      // WebGL reports CONTEXT_LOST_WEBGL only for a lost context.
      if (error === 0x9242) lost = true;
      return error;
    },
    isContextLost() { expect(this).toBe(raw); return lost; },
  };
  names.forEach((name, op) => {
    const call = function(this: unknown, ...args: unknown[]) {
      expect(this).toBe(raw); attempts.push(op);
      if (fault?.op === op) {
        if (fault.after || fault.kind === "post") state.set(op, args);
        if (fault.kind === "throw") throw Error("native operation refused");
        if (fault.kind === "post") postThrow = true;
        else pending.push(...(fault.flags ?? [0x501]));
        return;
      }
      state.set(op, args);
    };
    Object.defineProperty(raw, name, { get() {
      expect(this).toBe(raw);
      if (fault?.op === op && fault.kind === "getter") { attempts.push(op); throw Error("native getter refused"); }
      return call;
    } });
  });
  const gl = raw as unknown as WebGL2RenderingContext;
  const owner: CheckedGlOwner = { gl, errors: [] };
  const calls: NativeCall[] = [["bindFramebuffer", 0x8ca8, null], ["readBuffer", 0x8ce0],
    ["bindBuffer", 0x88eb, null], ["pixelStorei", 0x0d05, 4], ["disable", 0x0c11]];
  const groups = [calls.slice(0, 2), calls.slice(2, 3), calls.slice(3)];
  function submit(selected: NativeCall[][] = groups, selectedOwner = owner,
    completion = { submitted: false, complete: false }) {
    const accepted = applyNativeChanges({ ...selectedOwner, shadow: {} }, [{
      apply: () => { forward++; return true; }, restore: nativeInverse(selectedOwner),
    }], { shared: true, finalizer: nativeInverse(selectedOwner, ...selected), completion });
    return { accepted, completion };
  }
  return { gl, owner, calls, groups, pending, attempts, state, submit,
    reads: () => reads, forward: () => forward };
}

afterEach(() => setNativeGlFaultReporter(null));

/** Submit a change whose finalizer the live renderer refuses: the immediate
 * restoration is refused too, which is a fatal NativeGlFault. */
function refusedSubmit(f: ReturnType<typeof fixture>) {
  const reported: Error[] = [], completion = { submitted: false, complete: false };
  setNativeGlFaultReporter(fault => reported.push(fault));
  let thrown: unknown;
  try { f.submit(undefined, undefined, completion); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(NativeGlFault);
  expect((thrown as Error).message).toMatch(/live renderer refused to restore native state after a rejected change/);
  expect(reported).toEqual([thrown]);
  expect(completion.complete).toBe(false);
  expect(f.forward()).toBe(1); // restoring the inverse never repeats the forward operation
}

it("uses a successful post-check as the next inverse entry without losing pending flags", () => {
  const f = fixture(); f.pending.push(0x500, 0x505);
  expect(f.submit().accepted).toBe(true);
  expect(f.attempts).toEqual([0, 1, 2, 3, 4]);
  expect([...f.state.values()]).toEqual(f.calls.map(call => call.slice(1)));
  expect(f.owner.errors).toEqual([0x500, 0x505]);
  expect(f.reads()).toBe(8); // two pending flags, one clean entry, five post-checks
  expect(hasNativeRepair(f.gl)).toBe(false);
});

it("starts each inverse and error owner with a fresh drain", () => {
  const f = fixture(), peer: CheckedGlOwner = { gl: f.gl, errors: [] };
  expect(f.submit([f.groups[0]]).accepted).toBe(true);
  f.pending.push(0x500);
  expect(f.submit([f.groups[1]], peer).accepted).toBe(true);
  f.pending.push(0x505);
  expect(f.submit([f.groups[2]]).accepted).toBe(true);
  expect(peer.errors).toEqual([0x500]); expect(f.owner.errors).toEqual([0x505]);
  expect(f.attempts).toEqual([0, 1, 2, 3, 4]); expect(f.reads()).toBe(10);
});

for (let op = 0; op < 5; op++) for (const after of [false, true]) for (const kind of ["flags", "throw"] as const)
  it(`keeps independent inverse groups, then faults, after ${kind} ${after ? "after" : "before"} effect at operation ${op}`, () => {
    const f = fixture({ op, kind, after });
    refusedSubmit(f);
    const pass = [0, 1, 2, 3, 4].filter(i => !(op === 0 && i === 1) && !(op === 3 && i === 4));
    // The failed finalizer is immediately replayed; the live renderer's second
    // refusal is the fatal fault.
    expect(f.attempts).toEqual([...pass, ...pass]);
    expect(f.state.has(op)).toBe(after);
    expect(f.owner.errors).toEqual([kind === "flags" ? 0x501 : 0x502]);
  });

for (let op = 0; op < 5; op++) for (const kind of ["post", "getter"] as const)
  it(`revokes clean entry, then faults, after a ${kind} throw at inverse operation ${op}`, () => {
    const f = fixture({ op, kind }); refusedSubmit(f);
    const pass = [0, 1, 2, 3, 4].filter(i => !(op === 0 && i === 1) && !(op === 3 && i === 4));
    expect(f.attempts).toEqual([...pass, ...pass]);
    expect(f.state.has(op)).toBe(kind === "post"); expect(f.owner.errors).toEqual([0x502]);
  });

it("drains every remaining failed-step flag before an independent group, then faults", () => {
  const f = fixture({ op: 0, kind: "flags", flags: [0x500, 0x505, 0x501] });
  refusedSubmit(f);
  expect(f.owner.errors).toEqual([0x500, 0x505, 0x501]); expect(f.pending).toEqual([]);
  expect(f.attempts).toEqual([0, 2, 3, 4, 0, 2, 3, 4]);
});

it("refuses a non-clearing entry once per independent group, then faults", () => {
  const f = fixture(); let reads = 0;
  f.gl.getError = () => { reads++; return 0x502; };
  refusedSubmit(f);
  expect(reads).toBe(2 * 3 * 32); // initial finalizer plus its immediate restoration
  expect(f.attempts).toEqual([]); expect(f.owner.errors).toEqual([0x502]);
});

it("continues independent cleanup after an entry getError throw without losing its owner", () => {
  const f = fixture(), original = f.gl.getError; let first = true;
  f.gl.getError = function() { if (first) { first = false; throw Error("entry refused"); } return original.call(this); };
  expect(f.submit().accepted).toBe(false);
  expect(f.attempts).toEqual([2, 3, 4, 0, 1, 2, 3, 4]);
  expect(f.owner.errors).toEqual([0x502]); expect(hasNativeRepair(f.gl)).toBe(false);
  expect(f.forward()).toBe(1);
});

it("retains context-loss flags, attempts only independent cleanup, and drops the repair of a lost renderer", () => {
  const f = fixture({ op: 0, kind: "flags", flags: [0x9242] });
  setNativeGlFaultReporter(fault => { throw Error(`a lost renderer must not fault: ${fault.message}`); });
  const result = f.submit();
  expect(result.accepted).toBe(false); expect(f.owner.errors).toEqual([0x9242]);
  // A lost renderer has no state left to restore: no replay, no fault.
  expect(f.attempts).toEqual([0, 2, 3, 4]);
  expect(result.completion.complete).toBe(true);
  expect(hasNativeRepair(f.gl)).toBe(false);
});

it("does not query or mutate native state for empty inverse groups", () => {
  const f = fixture(); f.pending.push(0x500);
  expect(f.submit([[], []]).accepted).toBe(true);
  expect(f.reads()).toBe(0); expect(f.attempts).toEqual([]); expect(f.pending).toEqual([0x500]);
  expect(hasNativeRepair(f.gl)).toBe(false);
});
