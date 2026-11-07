import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GLES2_NEGATIVE_STATE_CASES } from "./cts-qpa.mjs";
import { CTS_SUITES, buildPlan, chunkCases, chunkFileName, families, familyOf, filterChunks, loadInventory,
  parseInventory, selectCases } from "./cts-plan.mjs";

const inventories = { gles2: loadInventory("gles2"), egl: loadInventory("egl") };
const coverage = readFileSync(new URL("../../docs/graphics/cts-coverage-v1.md", import.meta.url), "utf8");

test("inventories match the pinned executable case lists", () => {
  for (const suite of ["gles2", "egl"]) {
    assert.equal(inventories[suite].length, CTS_SUITES[suite].cases);
    assert.equal(new Set(inventories[suite]).size, inventories[suite].length);
    assert.match(coverage, new RegExp(CTS_SUITES[suite].sha256));
  }
  const upstream = JSON.parse(readFileSync(new URL("../../packages/registry/graphics-cts/upstream.json", import.meta.url), "utf8"));
  assert.equal(upstream.revision, "a119e62de3bb38dae67f05abee8acd011e0c729c");
});

test("rejects an altered inventory", () => {
  const text = inventories.egl.join("\n") + "\n";
  assert.throws(() => parseInventory("egl", text.replace("dEQP-EGL.info.vendor\n", "")), /SHA256/);
  assert.throws(() => parseInventory("vulkan", text), /Unknown CTS suite/);
});

test("families are exactly the coverage map's families and counts", () => {
  const documented = new Map([...coverage.matchAll(/^\| `(dEQP-[A-Z0-9]+\.[^`*]+?)(?:\.\*)?` \| ([\d,]+) \|/gm)]
    .map(match => [match[1], Number(match[2].replace(/,/g, ""))]));
  const derived = new Map();
  for (const suite of ["gles2", "egl"]) {
    for (const [family, cases] of families(inventories[suite])) derived.set(family, cases.length);
  }
  assert.equal(derived.size, 92);
  assert.deepEqual([...derived].sort(), [...documented].sort());
});

test("legacy selectors keep their exact earlier case sets", () => {
  const negativeApi = JSON.parse(readFileSync(new URL("./cts-gles2-negative-api.json", import.meta.url), "utf8"));
  const colorClear = JSON.parse(readFileSync(new URL("./cts-gles2-color-clear.json", import.meta.url), "utf8"));
  assert.deepEqual(selectCases("gles2", inventories.gles2, "negative-state"), GLES2_NEGATIVE_STATE_CASES);
  assert.deepEqual(selectCases("gles2", inventories.gles2, "negative-api"), negativeApi.cases);
  assert.deepEqual(selectCases("gles2", inventories.gles2, "color-clear"), colorClear.cases);
  assert.throws(() => selectCases("egl", inventories.egl, "color-clear"), /GLES2 selector/);
});

test("selectors union families, groups and all in inventory order", () => {
  const cases = inventories.gles2;
  assert.equal(selectCases("gles2", cases, "all").length, cases.length);
  const union = selectCases("gles2", cases, "functional.fbo, dEQP-GLES2.info.vendor,functional.fbo");
  assert.equal(union.length, 711 + 1);
  assert.deepEqual(union, cases.filter(path => union.includes(path)));
  assert.equal(selectCases("gles2", cases, "info").length, 6);
  assert.equal(selectCases("egl", inventories.egl, "functional.sharing").length, 1272);
  for (const bad of ["", " , ", "functional.nonexistent", "vulkan"]) assert.throws(() => selectCases("gles2", cases, bad));
});

test("exact cases compose with families without broadening the selection", () => {
  const a = "dEQP-EGL.performance.make_current.complex.contexts_100_pbuffers_100_release";
  const b = "dEQP-EGL.performance.make_current.complex.contexts_100_windows_10_release";
  assert.deepEqual(selectCases("egl", inventories.egl, a), [a]);
  assert.deepEqual(selectCases("egl", inventories.egl, `${b},${a.slice("dEQP-EGL.".length)},${a}`),
    inventories.egl.filter(path => path === a || path === b));
  const selected = selectCases("egl", inventories.egl, `${a},info`);
  assert.deepEqual(selected, inventories.egl.filter(path => path === a || path.startsWith("dEQP-EGL.info.")));
});

test("exact-case selection rejects unknown leaves and partial names", () => {
  for (const name of ["performance.make_current.complex.contexts_100",
    "performance.make_current.complex.contexts_100_pbuffers_100_release.invalid",
    "dEQP-GLES2.info.vendor"]) {
    assert.throws(() => selectCases("egl", inventories.egl, name), /matches no egl case/);
  }
});

test("chunks are bounded, family-pure, complete and stable", () => {
  for (const suite of ["gles2", "egl"]) {
    const plan = buildPlan({ suite, selector: "all", cases: inventories[suite] });
    const flat = plan.chunks.flatMap(chunk => chunk.cases);
    assert.deepEqual(flat, inventories[suite]);
    assert.equal(new Set(plan.chunks.map(chunk => chunk.id)).size, plan.chunks.length);
    for (const chunk of plan.chunks) {
      assert.ok(chunk.cases.length >= 1 && chunk.cases.length <= plan.chunkSize);
      assert.ok(chunk.cases.every(path => familyOf(path) === chunk.family));
      assert.match(chunk.id, /#\d{3}$/);
      assert.match(chunkFileName(chunk.id), /^[A-Za-z0-9._-]+$/);
    }
  }
  const chunks = chunkCases(["dEQP-EGL.a.b.1", "dEQP-EGL.a.b.2", "dEQP-EGL.a.b.3", "dEQP-EGL.a.c.1", "dEQP-EGL.info.x"], 2);
  assert.deepEqual(chunks.map(chunk => [chunk.id, chunk.cases.length]),
    [["dEQP-EGL.a.b#000", 2], ["dEQP-EGL.a.b#001", 1], ["dEQP-EGL.a.c#000", 1], ["dEQP-EGL.info.x#000", 1]]);
  assert.throws(() => chunkCases(["dEQP-EGL.a.b.1"], 0));
});

test("chunk filtering reruns only named chunks", () => {
  const plan = buildPlan({ suite: "egl", selector: "functional.sharing", chunkSize: 100, cases: inventories.egl });
  const one = filterChunks(plan, plan.chunks[3].id);
  assert.deepEqual(one.chunks, [plan.chunks[3]]);
  assert.equal(one.caseCount, plan.chunks[3].cases.length);
  assert.throws(() => filterChunks(plan, "nope#000"), /Unknown CTS chunk/);
});
