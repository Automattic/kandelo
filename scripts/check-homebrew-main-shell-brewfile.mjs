#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brewfile = resolve(process.argv[2] ?? `${repoRoot}/homebrew/main-shell.Brewfile`);
const tapName = "kandelo-dev/tap-core";
const formulaRenames = new Map([
  ["file", "file-formula"],
]);

const rootfsPackages = readDependencies(
  `${repoRoot}/packages/registry/rootfs/package.toml`,
);
const shellPackages = readDependencies(
  `${repoRoot}/packages/registry/shell/package.toml`,
).filter((name) => name !== "rootfs");
const expected = [...rootfsPackages, ...shellPackages]
  .map((name) => formulaRenames.get(name) ?? name);
const actual = readBrewfilePackages(brewfile);

assertUnique(expected, "package manifests");
assertUnique(actual, "main-shell Brewfile");
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  throw new Error(
    "main-shell Brewfile does not match rootfs + shell direct dependencies\n" +
      `  missing: ${missing.join(", ") || "(none)"}\n` +
      `  extra: ${extra.join(", ") || "(none)"}\n` +
      "  order must follow rootfs/package.toml then shell/package.toml",
  );
}

console.log(`Homebrew main-shell Brewfile: ${actual.length} direct package roots match package manifests.`);

function readDependencies(path) {
  const source = readFileSync(path, "utf8");
  const match = /(?:^|\n)depends_on\s*=\s*\[([\s\S]*?)\n\]/.exec(source);
  if (!match) throw new Error(`cannot find depends_on array in ${path}`);
  const entries = Array.from(match[1].matchAll(/"([^"]+)"/g), (item) => item[1]);
  if (entries.length === 0) throw new Error(`depends_on array is empty in ${path}`);
  return entries.map((entry) => {
    const at = entry.lastIndexOf("@");
    const name = at > 0 ? entry.slice(0, at) : entry;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw new Error(`unsupported dependency ${JSON.stringify(entry)} in ${path}`);
    }
    return name;
  });
}

function readBrewfilePackages(path) {
  const packages = [];
  let sawTap = false;
  for (const [index, rawLine] of readFileSync(path, "utf8").split("\n").entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === `tap "${tapName}"`) {
      if (sawTap) throw new Error(`duplicate tap declaration in ${path}`);
      sawTap = true;
      continue;
    }
    const match = /^brew "kandelo-dev\/tap-core\/([a-z0-9][a-z0-9._-]*)"$/.exec(line);
    if (!match) throw new Error(`unsupported ${path}:${index + 1}: ${rawLine}`);
    packages.push(match[1]);
  }
  if (!sawTap) throw new Error(`missing tap declaration in ${path}`);
  return packages;
}

function assertUnique(values, label) {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate) throw new Error(`${label} contains duplicate ${duplicate}`);
}
