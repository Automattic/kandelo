import { expect, it } from "vitest";
import { checkedGlCall, checkedGlGroups, checkedGlSequence, clearGlErrors, type CheckedGlOwner } from "../src/webgl/program-objects";

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

it("checks dependency groups once each and runs no group after a refused one", () => {
  for (const [failAt, expected] of [[-1, [0, 1, 2, 3]], [0, [0, 1]], [1, [0, 1]], [2, [0, 1, 2]], [3, [0, 1, 2, 3]]] as const) {
    const f = fixture(); f.pending.push(0x500);
    const step = (n: number) => () => { f.actions.push(n); if (n === failAt) f.pending.push(0x502); };
    const accepted = checkedGlGroups(f.owner, [[step(0), step(1)], [], [step(2)], [step(3)]]);
    expect(accepted).toBe(failAt < 0);
    expect(f.actions).toEqual(expected);
    // Prior flag, entry drain, one read per group that ran.
    const groups = failAt < 0 ? 3 : failAt <= 1 ? 1 : failAt === 2 ? 2 : 3;
    expect(f.reads()).toBe(2 + groups);
    expect(f.owner.errors).toEqual(failAt < 0 ? [0x500] : [0x500, 0x502]);
  }
});

it("stops a group at a throw and starts from a caller's clean entry without draining", () => {
  const f = fixture();
  expect(checkedGlGroups(f.owner, [[() => f.actions.push(0), () => { throw Error("refused"); }, () => f.actions.push(2)],
    [() => f.actions.push(3)]])).toBe(false);
  expect(f.actions).toEqual([0]); expect(f.owner.errors).toEqual([0x502]);
  const g = fixture();
  expect(checkedGlGroups(g.owner, [[() => g.actions.push(0)]], true)).toBe(true);
  expect(g.reads()).toBe(1);
});

it("drains every pending flag into its owner, and refuses flags that never clear", () => {
  const f = fixture(); f.pending.push(0x500, 0x505);
  expect(clearGlErrors(f.owner)).toBe(true);
  expect(f.owner.errors).toEqual([0x500, 0x505]); expect(f.reads()).toBe(3);
  const g = fixture(); g.gl.getError = () => 0x502;
  expect(clearGlErrors(g.owner)).toBe(false); expect(g.owner.errors).toEqual([0x502]);
});
