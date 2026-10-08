import assert from "node:assert/strict";
import test from "node:test";

import {
  randomSessionName,
  validSessionName,
} from "./lib/peer-signalling";

test("makes a random name of three words that satisfies the rule", () => {
  for (let index = 0; index < 100; index++) {
    const name = randomSessionName();
    assert.equal(name.split("-").length, 3);
    assert.ok(validSessionName(name), name);
  }
});

test("varies the random name", () => {
  const names = new Set(Array.from({ length: 20 }, randomSessionName));
  assert.ok(names.size > 1);
});
