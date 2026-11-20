import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deloPackages } from "../src/packages";
import { deloImageSource, parseDeloRegistry } from "../src/registry";

const source = readFileSync(new URL("../src/binaries.ts", import.meta.url), "utf8");
const registry = parseDeloRegistry(readFileSync(new URL("../src/registry.json", import.meta.url), "utf8"));

test("names every eager local registry file in both mirrors, and nothing else", () => {
  const froms = deloPackages(registry)
    .flatMap((entry) => entry.files)
    .flatMap((file) => {
      if (!("from" in file) || ("type" in file && file.type === "symlink") || ("lazy" in file && file.lazy) || deloImageSource(file.from) !== null) return [];
      return file.from.startsWith("https://") ? [] : [file.from];
    });
  const globbed = [...source.matchAll(/import\.meta\.glob\("\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(globbed, froms.flatMap((from) => [`local-binaries/${from}`, `binaries/${from}`]));
});

test("looks a file up under the path its glob names", () => {
  const mirrors = [...source.match(/const MIRRORS = \[([^\]]+)\]/)![1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const globbed = [...source.matchAll(/import\.meta\.glob\("([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(globbed.filter((path, index) => !path.startsWith(mirrors[index % 2])), []);
});
