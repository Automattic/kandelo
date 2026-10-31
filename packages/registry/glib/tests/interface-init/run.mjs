import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const { instance } = await WebAssembly.instantiate(readFileSync(process.argv[2]), {});
for (const which of [8, 9]) {
  assert.throws(() => instance.exports.run_case(which), WebAssembly.RuntimeError,
    `the original static/dynamic adapter must reproduce the two-argument trap: ${which}`);
}
for (const [which, expected, calls] of [
  [0, 11, 1], [1, 22, 1], [2, 33, 1], [3, 0, 0],
  [4, 11, 1], [5, 22, 1], [6, 33, 1], [7, 0, 0],
  [10, 0, 0], [11, 0, 0],
]) {
  assert.equal(instance.exports.run_case(which), expected, `callback case ${which}`);
  assert.equal(instance.exports.calls(), calls, `callback count ${which}`);
}
console.log("interface init: original static/dynamic traps reproduced; 10 repaired cases passed");
