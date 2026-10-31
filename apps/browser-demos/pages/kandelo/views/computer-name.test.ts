import assert from "node:assert/strict";
import { test } from "node:test";
import { randomComputerName } from "../../../../../web-libs/kandelo-session/src/computer-name";

test("computer names draw independently from three word sets", context => {
  let choices = new Uint32Array([0, 0, 0]);
  context.mock.method(crypto, "getRandomValues", () => choices);
  assert.equal(randomComputerName(), "bouncy-apricot-alpaca");
  choices = new Uint32Array([31, 0, 0]);
  assert.equal(randomComputerName(), "zippy-apricot-alpaca");
  choices = new Uint32Array([0, 31, 0]);
  assert.equal(randomComputerName(), "bouncy-waffle-alpaca");
  choices = new Uint32Array([0, 0, 31]);
  assert.equal(randomComputerName(), "bouncy-apricot-wombat");
  choices = new Uint32Array([0xffffffff, 0xffffffff, 0xffffffff]);
  assert.equal(randomComputerName(), "zippy-waffle-wombat");
});

test("generated names avoid existing names without retrying randomness", context => {
  context.mock.method(crypto, "getRandomValues", () => new Uint32Array(3));
  assert.equal(randomComputerName(["BOUNCY-APRICOT-ALPACA", "bouncy-apricot-axolotl"]), "bouncy-apricot-badger");
  const names = new Set<string>();
  for (let index = 0; index < 256; index++) names.add(randomComputerName(names));
  assert.equal(names.size, 256);
});

test("computer names are lowercase, URL-friendly three-word suggestions", () => {
  for (let index = 0; index < 64; index++) {
    assert.match(randomComputerName(), /^[a-z]+-[a-z]+-[a-z]+$/);
  }
});
