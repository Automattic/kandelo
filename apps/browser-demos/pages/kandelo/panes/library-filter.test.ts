import assert from "node:assert/strict";
import test from "node:test";

import { filterAndPage, matchesQuery } from "./library-filter.ts";

const names = Array.from({ length: 120 }, (_, i) => `Game ${i} (${i % 2 ? "USA" : "Europe"}).nes`);

test("an empty filter pages through everything", () => {
  const page = filterAndPage(names, "  ", 2, (name) => name, 50);
  assert.equal(page.totalMatches, 120);
  assert.equal(page.pageCount, 3);
  assert.equal(page.items[0], "Game 50 (Europe).nes");
});

test("every word must match, in any case", () => {
  const page = filterAndPage(names, "usa game 1", 1, (name) => name, 50);
  assert.ok(page.items.every((name) => name.includes("USA") && /Game \d*1/.test(name)));
  assert.equal(page.totalMatches, page.items.length);
  assert.ok(matchesQuery("Carpet Shark homebrew", "shark CARPET"));
  assert.ok(!matchesQuery("Carpet Shark", "shark lawn"));
});

test("a page past the end of a narrowed list clamps to its last page", () => {
  const page = filterAndPage(names, "europe", 9, (name) => name, 50);
  assert.equal(page.totalMatches, 60);
  assert.equal(page.page, 2);
  assert.equal(page.items.length, 10);
});

test("no matches is one empty page", () => {
  const page = filterAndPage(names, "zelda", 1, (name) => name);
  assert.deepEqual(page, { items: [], page: 1, pageCount: 1, totalMatches: 0 });
});
