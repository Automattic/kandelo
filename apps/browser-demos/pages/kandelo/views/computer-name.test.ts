import assert from "node:assert/strict";
import { test } from "node:test";
import { randomComputerName } from "../../../../../web-libs/kandelo-session/src/computer-name";

test("computer names draw independently from three word sets", context => {
  let choices = new Uint32Array([0, 0, 0]);
  context.mock.method(crypto, "getRandomValues", () => choices);
  assert.equal(randomComputerName(), "Bouncy Apricot Alpaca");
  choices = new Uint32Array([31, 0, 0]);
  assert.equal(randomComputerName(), "Zippy Apricot Alpaca");
  choices = new Uint32Array([0, 31, 0]);
  assert.equal(randomComputerName(), "Bouncy Waffle Alpaca");
  choices = new Uint32Array([0, 0, 31]);
  assert.equal(randomComputerName(), "Bouncy Apricot Wombat");
  choices = new Uint32Array([0xffffffff, 0xffffffff, 0xffffffff]);
  assert.equal(randomComputerName(), "Zippy Waffle Wombat");
});

test("generated names avoid existing names without retrying randomness", context => {
  context.mock.method(crypto, "getRandomValues", () => new Uint32Array(3));
  assert.equal(randomComputerName(["Bouncy Apricot Alpaca", "Bouncy Apricot Axolotl"]), "Bouncy Apricot Badger");
  const names = new Set<string>();
  for (let index = 0; index < 256; index++) names.add(randomComputerName(names));
  assert.equal(names.size, 256);
});

test("computer names are capitalized, space-separated three-word suggestions", () => {
  for (let index = 0; index < 64; index++) {
    assert.match(randomComputerName(), /^[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+$/);
  }
});
