import assert from "node:assert/strict";
import test from "node:test";
import { deloComputerName, deloNameProblem, deloRandomName } from "../src/name";

const KEBAB = "a computer name is kebab-case: lowercase letters and digits, joined by single hyphens, such as brave-cookie-otter";

test("accepts a free kebab-case name of 1 to 120 characters", () => {
  assert.equal(deloNameProblem("foo", ["bar"]), null);
  assert.equal(deloNameProblem("foo-bar-2", ["bar"]), null);
  assert.equal(deloNameProblem("a".repeat(120), []), null);
});

test("refuses an empty, long, not kebab-case or taken name", () => {
  assert.equal(deloNameProblem("", []), "Computer names must contain 1–120 characters");
  assert.equal(deloNameProblem("a".repeat(121), []), "Computer names must contain 1–120 characters");
  for (const name of ["foo bar", "Foo", "foo_bar", "foo--bar", "-foo", "foo-"]) assert.equal(deloNameProblem(name, []), KEBAB);
  assert.equal(deloNameProblem("foo", ["Foo"]), "a computer is already named foo");
});

test("draws a free kebab-case name, and skips one another computer holds in either form", () => {
  assert.match(deloRandomName([]), /^[a-z]+-[a-z]+-[a-z]+$/);
  const name = deloRandomName([]);
  const spaced = name.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  for (let draw = 0; draw < 200; draw++) {
    assert.notEqual(deloRandomName([name]), name);
    assert.notEqual(deloRandomName([spaced]), name);
  }
});

test("names a computer by its title in kebab-case", () => {
  assert.equal(deloComputerName("foo-bar"), "foo-bar");
  assert.equal(deloComputerName("Foo Bar Baz"), "foo-bar-baz");
  assert.equal(deloComputerName("  Foo  _Bar!  "), "foo-bar");
});
