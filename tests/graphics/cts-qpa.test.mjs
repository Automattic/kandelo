import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseCtsQpa } from "./cts-qpa.mjs";

const record = (name, status = "Pass") => `#beginTestCaseResult ${name}\n`
  + `<TestCaseResult CasePath="${name}" Version="0.3.4">`
  + `<Result StatusCode="${status}">${status}</Result></TestCaseResult>\n`
  + "#endTestCaseResult\n";

test("preserves actual failed and unsupported outcomes", () => {
  const result = parseCtsQpa(record("a") + record("b", "Fail") + record("c", "NotSupported"), ["a", "b", "c"]);
  assert.deepEqual(result.counts, { Pass: 1, Fail: 1, NotSupported: 1 });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.incomplete, []);
});

test("reports absent, extra and duplicate cases independently", () => {
  const result = parseCtsQpa(record("a") + record("a") + record("extra"), ["a", "b"]);
  assert.deepEqual(result.missing, ["b"]);
  assert.deepEqual(result.unexpected, ["extra"]);
  assert.deepEqual(result.duplicates, ["a"]);
});

for (const [name, text] of [
  ["truncated result", record("a").replace("#endTestCaseResult", "")],
  ["unclosed XML", record("a").replace("</TestCaseResult>", "")],
  ["mismatched XML identity", record("a").replace('CasePath="a"', 'CasePath="b"')],
  ["multiple results", record("a").replace("</TestCaseResult>", '<Result StatusCode="Pass">Pass</Result></TestCaseResult>')],
]) {
  test(`refuses ${name} as completed evidence`, () => {
    const result = parseCtsQpa(text, ["a"]);
    assert.deepEqual(result.incomplete, ["a"]);
    assert.deepEqual(result.missing, ["a"]);
    assert.equal(result.rows.length, 0);
  });
}

test("refuses an empty or duplicate expected selection", () => {
  assert.throws(() => parseCtsQpa("", []));
  assert.throws(() => parseCtsQpa(record("a"), ["a", "a"]));
});

test("negative API inventory matches the pinned upstream revision and group", () => {
  const inventory = JSON.parse(readFileSync(new URL("./cts-gles2-negative-api.json", import.meta.url), "utf8"));
  const upstream = JSON.parse(readFileSync(new URL("../../packages/registry/graphics-cts/upstream.json", import.meta.url), "utf8"));
  assert.equal(inventory.upstreamRevision, upstream.revision);
  assert.match(inventory.inventorySha256, /^[a-f0-9]{64}$/);
  assert.equal(inventory.caseFilter, "dEQP-GLES2.functional.negative_api.*");
  assert.equal(inventory.cases.length, 246);
  assert.equal(new Set(inventory.cases).size, inventory.cases.length);
  assert.ok(inventory.cases.every(name => typeof name === "string" && name.startsWith("dEQP-GLES2.functional.negative_api.")));
});
