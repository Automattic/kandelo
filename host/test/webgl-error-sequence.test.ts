import { expect, it } from "vitest";
import { checkedGlCall, checkedGlSequence, type CheckedGlOwner } from "../src/webgl/program-objects";

function fixture() {
  const pending: number[] = [], actions: number[] = [];
  let reads = 0;
  const gl = { getError() { reads++; return pending.shift() ?? 0; } } as WebGL2RenderingContext;
  const owner: CheckedGlOwner = { gl, errors: [] };
  return { gl, owner, pending, actions, reads: () => reads };
}

it("keeps prior flags and checks each accepted operation with one entry drain", () => {
  const f = fixture(); f.pending.push(0x500, 0x505);
  expect(checkedGlSequence(f.owner, [() => f.actions.push(0), () => f.actions.push(1), () => f.actions.push(2)])).toBe(true);
  expect(f.actions).toEqual([0, 1, 2]); expect(f.owner.errors).toEqual([0x500, 0x505]);
  expect(f.reads()).toBe(6); // two prior flags, clean entry, then three post-checks
});

for (const index of [0, 1, 2]) for (const fault of ["native", "throw"] as const)
  it(`stops before dependent calls after ${fault} rejection at step ${index}`, () => {
    const f = fixture();
    const calls = [0, 1, 2].map(step => () => {
      f.actions.push(step);
      if (step !== index) return;
      if (fault === "throw") throw Error("native method refused");
      f.pending.push(0x501);
    });
    expect(checkedGlSequence(f.owner, calls)).toBe(false);
    expect(f.actions).toEqual([0, 1, 2].slice(0, index + 1));
    expect(f.owner.errors).toEqual([fault === "throw" ? 0x502 : 0x501]);
  });

it("refuses non-clearing entry flags without executing or losing their owner", () => {
  const f = fixture(); let reads = 0;
  f.gl.getError = () => { reads++; return 0x502; };
  expect(checkedGlSequence(f.owner, [() => f.actions.push(0)])).toBe(false);
  expect(reads).toBe(32); expect(f.actions).toEqual([]); expect(f.owner.errors).toEqual([0x502]);
});

for (const at of [1, 2]) it(`keeps getError throw at read ${at} visible and stops`, () => {
  const f = fixture(); let reads = 0;
  f.gl.getError = () => { if (++reads === at) throw Error("error read refused"); return 0; };
  expect(checkedGlSequence(f.owner, [() => f.actions.push(0), () => f.actions.push(1)])).toBe(false);
  expect(f.actions).toEqual(at === 1 ? [] : [0]); expect(f.owner.errors).toEqual([0x502]);
});

it("leaves additional failed-step flags for the unchanged inverse entry to drain", () => {
  const f = fixture();
  expect(checkedGlSequence(f.owner, [() => { f.actions.push(0); f.pending.push(0x500, 0x505); }, () => f.actions.push(1)])).toBe(false);
  expect(f.actions).toEqual([0]); expect(f.owner.errors).toEqual([0x500]);
  expect(checkedGlCall(f.owner, () => f.actions.push(2))).toBe(true);
  expect(f.actions).toEqual([0, 2]); expect(f.owner.errors).toEqual([0x500, 0x505]); expect(f.pending).toEqual([]);
});

it("checks loss raised by an operation before any later operation runs", () => {
  const f = fixture();
  expect(checkedGlSequence(f.owner, [() => { f.actions.push(0); f.pending.push(0x9242); }, () => f.actions.push(1)])).toBe(false);
  expect(f.actions).toEqual([0]); expect(f.owner.errors).toEqual([0x9242]);
});

it("never carries a clean-entry assumption into a separate sequence", () => {
  const f = fixture();
  expect(checkedGlSequence(f.owner, [() => f.actions.push(0)])).toBe(true);
  f.pending.push(0x500);
  expect(checkedGlSequence(f.owner, [() => f.actions.push(1)])).toBe(true);
  expect(f.actions).toEqual([0, 1]); expect(f.owner.errors).toEqual([0x500]); expect(f.reads()).toBe(5);
});
