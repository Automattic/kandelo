#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brewfile = resolve(process.argv[2] ?? `${repoRoot}/homebrew/main-shell.Brewfile`);
const lockPath = resolve(
  process.argv[3] ?? `${repoRoot}/homebrew/main-shell-migration-lock.json`,
);
const metadataPath = process.argv[4] ? resolve(process.argv[4]) : undefined;
const tapName = "kandelo-dev/tap-core";

const rootfsPackages = readDependencies(
  `${repoRoot}/packages/registry/rootfs/package.toml`,
);
const shellPackages = readDependencies(
  `${repoRoot}/packages/registry/shell/package.toml`,
).filter(({ name }) => name !== "rootfs");
const registryPackages = [...rootfsPackages, ...shellPackages];
const lock = readMigrationLock(lockPath);
const expectedFormulae = lock.packages.map(({ formula }) => formula.name);
const actualFormulae = readBrewfilePackages(brewfile);

assertUnique(registryPackages.map(({ name }) => name), "package manifests");
assertUnique(expectedFormulae, "migration lock Formulae");
assertUnique(actualFormulae, "main-shell Brewfile");
assertExactSequence(
  lock.packages.map(({ registry }) => registry),
  registryPackages,
  "migration lock registry identities do not match rootfs + shell dependencies",
  ({ name, version }) => `${name}@${version}`,
);
assertExactSequence(
  actualFormulae,
  expectedFormulae,
  "main-shell Brewfile does not match the migration lock",
  (value) => value,
);
validateReviewedSubstitutions(lock);
if (metadataPath !== undefined) validateTapMetadata(lock, metadataPath);

console.log(
  `Homebrew main-shell contract: ${actualFormulae.length} registry roots match ` +
    "the reviewed migration lock and Brewfile.",
);

function readMigrationLock(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value) || value.schema !== 1 || value.tap_name !== tapName) {
    throw new Error(`invalid main-shell migration lock schema or tap identity: ${path}`);
  }
  if (!Array.isArray(value.packages) || !Array.isArray(value.reviewed_substitutions)) {
    throw new Error(`main-shell migration lock packages/substitutions must be arrays: ${path}`);
  }
  if (
    !isRecord(value.consumer) ||
    value.consumer.profile !== "main-shell" ||
    value.consumer.max_vfs_byte_length !== 512 * 1024 * 1024
  ) {
    throw new Error(`main-shell migration lock must declare the 512 MiB consumer profile: ${path}`);
  }
  const packages = value.packages.map((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.registry) || !isRecord(entry.formula)) {
      throw new Error(`invalid migration lock package ${index}`);
    }
    const registry = readIdentity(entry.registry, `packages[${index}].registry`);
    const formula = readIdentity(entry.formula, `packages[${index}].formula`);
    for (const field of ["revision", "bottle_rebuild"]) {
      if (!Number.isInteger(entry.formula[field]) || entry.formula[field] < 0) {
        throw new Error(`packages[${index}].formula.${field} must be a non-negative integer`);
      }
    }
    return {
      registry,
      formula: {
        ...formula,
        revision: entry.formula.revision,
        bottle_rebuild: entry.formula.bottle_rebuild,
      },
    };
  });
  return { ...value, packages };
}

function readIdentity(value, label) {
  if (
    typeof value.name !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value.name) ||
    typeof value.version !== "string" ||
    value.version.length === 0
  ) {
    throw new Error(`${label} must contain a valid name and non-empty version`);
  }
  return { name: value.name, version: value.version };
}

function validateReviewedSubstitutions(lock) {
  const expected = [];
  for (const { registry, formula } of lock.packages) {
    if (registry.name !== formula.name) {
      expected.push({
        kind: "formula_identity",
        registry: `${registry.name}@${registry.version}`,
        formula: `${tapName}/${formula.name}@${formula.version}`,
      });
    }
    if (registry.version !== formula.version) {
      expected.push({
        kind: "version",
        registry: `${registry.name}@${registry.version}`,
        formula: `${tapName}/${formula.name}@${formula.version}`,
      });
    }
  }
  const actual = lock.reviewed_substitutions.map((entry, index) => {
    if (
      !isRecord(entry) ||
      (entry.kind !== "formula_identity" && entry.kind !== "version") ||
      typeof entry.registry !== "string" ||
      typeof entry.formula !== "string" ||
      typeof entry.reason !== "string" ||
      entry.reason.length === 0
    ) {
      throw new Error(`reviewed_substitutions[${index}] is invalid`);
    }
    return { kind: entry.kind, registry: entry.registry, formula: entry.formula };
  });
  assertExactSequence(
    actual,
    expected,
    "reviewed migration substitutions are incomplete or stale",
    ({ kind, registry, formula }) => `${kind}:${registry}->${formula}`,
  );
}

function validateTapMetadata(lock, path) {
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(metadata) || metadata.tap_name !== tapName || !Array.isArray(metadata.packages)) {
    throw new Error(`tap metadata has the wrong identity or package shape: ${path}`);
  }
  const byName = new Map(metadata.packages.map((pkg) => [pkg?.name, pkg]));
  for (const { formula } of lock.packages) {
    const pkg = byName.get(formula.name);
    if (!isRecord(pkg)) {
      throw new Error(`tap metadata is missing locked Formula ${formula.name}`);
    }
    const expectedVersion = formula.revision === 0
      ? formula.version
      : `${formula.version}_${formula.revision}`;
    if (
      pkg.full_name !== `${tapName}/${formula.name}` ||
      pkg.version !== expectedVersion ||
      pkg.formula_revision !== formula.revision ||
      pkg.bottle_rebuild !== formula.bottle_rebuild
    ) {
      throw new Error(
        `tap metadata Formula drift for ${formula.name}: expected ` +
          `${expectedVersion} revision ${formula.revision} rebuild ${formula.bottle_rebuild}`,
      );
    }
  }
}

function readDependencies(path) {
  const source = readFileSync(path, "utf8");
  const match = /(?:^|\n)depends_on\s*=\s*\[([\s\S]*?)\n\]/.exec(source);
  if (!match) throw new Error(`cannot find depends_on array in ${path}`);
  const entries = Array.from(match[1].matchAll(/"([^"]+)"/g), (item) => item[1]);
  if (entries.length === 0) throw new Error(`depends_on array is empty in ${path}`);
  return entries.map((entry) => {
    const at = entry.lastIndexOf("@");
    if (at <= 0 || at === entry.length - 1) {
      throw new Error(`dependency must be locked as name@version: ${entry} in ${path}`);
    }
    const name = entry.slice(0, at);
    const version = entry.slice(at + 1);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw new Error(`unsupported dependency ${JSON.stringify(entry)} in ${path}`);
    }
    return { name, version };
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

function assertExactSequence(actual, expected, message, render) {
  const actualValues = actual.map(render);
  const expectedValues = expected.map(render);
  if (JSON.stringify(actualValues) === JSON.stringify(expectedValues)) return;
  const missing = expectedValues.filter((value) => !actualValues.includes(value));
  const extra = actualValues.filter((value) => !expectedValues.includes(value));
  throw new Error(
    `${message}\n  missing: ${missing.join(", ") || "(none)"}` +
      `\n  extra: ${extra.join(", ") || "(none)"}\n  ordering must also match`,
  );
}

function assertUnique(values, label) {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate) throw new Error(`${label} contains duplicate ${duplicate}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
