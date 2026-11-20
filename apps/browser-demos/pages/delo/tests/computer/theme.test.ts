import assert from "node:assert/strict";
import test from "node:test";

import { DELO_THEME_KEY, nextDeloTheme, readDeloTheme, writeDeloTheme } from "../../src/computer/theme";

const storage = (value: string | null) => ({ getItem: (key: string) => key === DELO_THEME_KEY ? value : null });

test("reads a stored theme", () => {
  assert.equal(readDeloTheme(storage("wordpress-light")), "wordpress-light");
  assert.equal(readDeloTheme(storage("wordpress-dark")), "wordpress-dark");
});

test("falls back to the WordPress light theme", () => {
  assert.equal(readDeloTheme(storage(null)), "wordpress-light");
  assert.equal(readDeloTheme(storage("foo")), "wordpress-light");
  assert.equal(readDeloTheme({ getItem: () => { throw new Error("blocked"); } }), "wordpress-light");
});

test("writes a theme under delo.theme, and ignores storage that is unavailable", () => {
  const stored = new Map<string, string>();
  writeDeloTheme({ setItem: (key, value) => stored.set(key, value) }, "wordpress-dark");
  assert.deepEqual([...stored], [[DELO_THEME_KEY, "wordpress-dark"]]);
  assert.doesNotThrow(() => writeDeloTheme({ setItem: () => { throw new Error("blocked"); } }, "wordpress-dark"));
});

test("cycles through every theme", () => {
  assert.equal(nextDeloTheme("wordpress-light"), "wordpress-dark");
  assert.equal(nextDeloTheme("wordpress-dark"), "wordpress-light");
});
