import assert from "node:assert/strict";
import test from "node:test";
import { inspectCtsRetirement } from "./cts-retirement.mjs";

function events() {
  const identity = { pid: 41, realmId: 2, executionId: 7 };
  return [{ kind: "admitted", ...identity }, { kind: "exited", ...identity, status: 0 },
    { kind: "retired", ...identity, leaseDisposition: "quiescent", postCommitFailed: false,
      registration: "removed-or-absent", mainFence: "acknowledged", threadFences: "acknowledged",
      threads: 2, acknowledgedThreads: 2 }];
}
test("accepts an exact cooperative image receipt with acknowledged threads", () => {
  assert.equal(inspectCtsRetirement(events(),41,0).ok,true);
});
test("semantic exit, another child and missing admission never replace retirement", () => {
  for (const rows of [events().slice(0,2), events().slice(1), events().map(event => ({ ...event, pid: 42 }))]) {
    assert.equal(inspectCtsRetirement(rows,41,0).ok,false);
  }
});
for (const [field, value] of [
  ["realmId",3], ["executionId",8], ["leaseDisposition","forced"],
  ["leaseDisposition","unobserved"], ["mainFence","missing"], ["threadFences","missing"],
  ["acknowledgedThreads",1], ["postCommitFailed",true], ["registration","superseded"],
]) test(`rejects ${field}=${value}`, () => {
  const input=events();input[2][field]=value;
  assert.equal(inspectCtsRetirement(input,41,0).ok,false);
});
test("rejects duplicates, reordered receipts and wrong exit status", () => {
  const rows=events();
  for (const input of [[...rows,rows[2]],[rows[0],rows[2],rows[1]]]) {
    assert.equal(inspectCtsRetirement(input,41,0).ok,false);
  }
  assert.equal(inspectCtsRetirement(rows,41,1).ok,false);
});
test("rejects malformed identity and unknown post-commit state", () => {
  for (const field of ["realmId","executionId"]) {
    const rows=events();rows[0][field]=0;
    assert.equal(inspectCtsRetirement(rows,41,0).ok,false);
  }
  const rows=events();delete rows[2].postCommitFailed;
  assert.equal(inspectCtsRetirement(rows,41,0).ok,false);
  assert.equal(inspectCtsRetirement(undefined,41,0).ok,false);
  assert.equal(inspectCtsRetirement([...events(),{ ...events()[0], kind: "unknown" }],41,0).ok,false);
});
