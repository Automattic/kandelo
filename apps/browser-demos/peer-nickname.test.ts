import assert from "node:assert/strict";
import test from "node:test";

import {
  NICKNAME_MAX_LENGTH,
  presentableNickname,
} from "./lib/peer-nickname";

test("keeps a plain name, accents included", () => {
  assert.equal(presentableNickname("foo"), "foo");
  assert.equal(presentableNickname("Foo Bar"), "Foo Bar");
  assert.equal(presentableNickname("Zo\u00e9"), "Zo\u00e9");
});

test("strips control characters and surrounding space", () => {
  assert.equal(presentableNickname("\u0000foo\u001bbar"), "foobar");
  assert.equal(presentableNickname("  foo  "), "foo");
  assert.equal(presentableNickname("foo\nbar"), "foobar");
  assert.equal(presentableNickname("foo\u007f"), "foo");
});

test("caps the length", () => {
  const long = "a".repeat(NICKNAME_MAX_LENGTH + 10);
  assert.equal(presentableNickname(long), "a".repeat(NICKNAME_MAX_LENGTH));
});

test("turns a name with nothing to show into no name", () => {
  assert.equal(presentableNickname(""), null);
  assert.equal(presentableNickname("   "), null);
  assert.equal(presentableNickname("\t\n"), null);
});
