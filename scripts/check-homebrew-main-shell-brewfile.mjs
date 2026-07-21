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
const tapRepository = "kandelo-dev/homebrew-tap-core";
const tapName = "kandelo-dev/tap-core";
const gitShaPattern = /^[0-9a-f]{40}$/;
const formulaIdentityPattern = /^kandelo-dev\/tap-core\/[a-z0-9][a-z0-9._-]*$/;
const expectedRootCount = 32;
const expectedClosureCount = 38;

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
validateCompatibilityPolicy(lock);
if (metadataPath !== undefined) validateTapMetadata(lock, metadataPath);

console.log(
  `Homebrew main-shell contract: ${actualFormulae.length} registry roots and ` +
    `${lock.formula_closure.length} Formulae match the reviewed migration lock, ` +
    `Brewfile, and catalog ${lock.catalog.tap_commit}.`,
);

function readMigrationLock(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    value.tap_repository !== tapRepository ||
    value.tap_name !== tapName
  ) {
    throw new Error(`invalid main-shell migration lock schema or tap identity: ${path}`);
  }
  if (
    !isRecord(value.catalog) ||
    JSON.stringify(Object.keys(value.catalog).sort()) !== JSON.stringify(["tap_commit"]) ||
    typeof value.catalog.tap_commit !== "string" ||
    !gitShaPattern.test(value.catalog.tap_commit)
  ) {
    throw new Error(`main-shell migration lock must pin one exact catalog commit: ${path}`);
  }
  if (
    !Array.isArray(value.packages) ||
    !Array.isArray(value.formula_closure) ||
    !Array.isArray(value.reviewed_substitutions)
  ) {
    throw new Error(
      `main-shell migration lock packages/formula_closure/substitutions must be arrays: ${path}`,
    );
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
  if (packages.length !== expectedRootCount) {
    throw new Error(
      `main-shell migration lock must contain exactly ${expectedRootCount} registry roots: ${path}`,
    );
  }
  const formulaClosure = value.formula_closure.map((entry, index) =>
    readFormulaIdentity(entry, `formula_closure[${index}]`)
  );
  if (formulaClosure.length !== expectedClosureCount) {
    throw new Error(
      `main-shell migration lock must contain exactly ${expectedClosureCount} closure Formulae: ${path}`,
    );
  }
  assertUnique(formulaClosure, "migration lock formula_closure");
  const missingRoots = packages
    .map(({ formula }) => `${tapName}/${formula.name}`)
    .filter((identity) => !formulaClosure.includes(identity));
  if (missingRoots.length > 0) {
    throw new Error(
      `main-shell migration lock formula_closure omits registry-root Formulae: ` +
        missingRoots.join(", "),
    );
  }
  return { ...value, packages, formula_closure: formulaClosure };
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

function readFormulaIdentity(value, label) {
  if (
    typeof value !== "string" ||
    !formulaIdentityPattern.test(value)
  ) {
    throw new Error(`${label} must be a canonical ${tapName}/<formula> identity`);
  }
  return value;
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
    const label = `reviewed_substitutions[${index}]`;
    if (
      !isRecord(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !==
        JSON.stringify(["formula", "kind", "reason", "registry"]) ||
      (entry.kind !== "formula_identity" && entry.kind !== "version") ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0
    ) {
      throw new Error(`${label} is invalid`);
    }
    return {
      kind: entry.kind,
      registry: readReviewedRegistryIdentity(entry.registry, `${label}.registry`),
      formula: readReviewedFormulaIdentity(entry.formula, `${label}.formula`),
    };
  });
  assertUnique(
    actual.map(({ kind, registry, formula }) => `${kind}:${registry}->${formula}`),
    "reviewed migration substitutions",
  );
  assertExactSequence(
    actual,
    expected,
    "reviewed migration substitutions are incomplete or stale",
    ({ kind, registry, formula }) => `${kind}:${registry}->${formula}`,
  );
}

function readReviewedRegistryIdentity(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a registry name@version identity`);
  }
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${label} must be a registry name@version identity`);
  }
  readIdentity(
    { name: value.slice(0, separator), version: value.slice(separator + 1) },
    label,
  );
  return value;
}

function readReviewedFormulaIdentity(value, label) {
  const prefix = `${tapName}/`;
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(`${label} must be a ${tapName}/<formula>@<version> identity`);
  }
  const unqualified = value.slice(prefix.length);
  const separator = unqualified.lastIndexOf("@");
  if (separator <= 0 || separator === unqualified.length - 1) {
    throw new Error(`${label} must be a ${tapName}/<formula>@<version> identity`);
  }
  readIdentity(
    {
      name: unqualified.slice(0, separator),
      version: unqualified.slice(separator + 1),
    },
    label,
  );
  return value;
}

function validateCompatibilityPolicy(lock) {
  const compatibility = lock.compatibility;
  if (
    !isRecord(compatibility) ||
    !isRecord(compatibility.mirror_link_manifest_bin) ||
    JSON.stringify(compatibility.mirror_link_manifest_bin.targets) !==
      JSON.stringify(["/usr/bin", "/bin"]) ||
    !Array.isArray(compatibility.link_conflict_owners) ||
    !Array.isArray(compatibility.aliases)
  ) {
    throw new Error("main-shell migration compatibility policy is invalid");
  }

  const lockedPackages = new Set(lock.formula_closure);
  const conflictTargets = new Set();
  for (const [index, entry] of compatibility.link_conflict_owners.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.target !== "string" ||
      !/^bin\/[a-z0-9][a-z0-9._+-]*$/.test(entry.target) ||
      typeof entry.package !== "string" ||
      !lockedPackages.has(entry.package) ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0
    ) {
      throw new Error(`compatibility.link_conflict_owners[${index}] is invalid`);
    }
    if (conflictTargets.has(entry.target)) {
      throw new Error(`compatibility link conflict target is duplicated: ${entry.target}`);
    }
    conflictTargets.add(entry.target);
  }

  const aliasTargets = new Set();
  for (const [index, entry] of compatibility.aliases.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.package !== "string" ||
      !lockedPackages.has(entry.package) ||
      (entry.source_kind !== "link" && entry.source_kind !== "keg") ||
      typeof entry.source !== "string" ||
      !/^[a-z0-9][a-z0-9._+-]*(?:\/[a-z0-9][a-z0-9._+-]*)*$/.test(entry.source) ||
      (entry.source_kind === "link" &&
        !/^bin\/[a-z0-9][a-z0-9._+-]*$/.test(entry.source)) ||
      !Array.isArray(entry.targets) ||
      entry.targets.length === 0 ||
      entry.targets.some((target) =>
        typeof target !== "string" ||
        !/^\/(?:[a-z0-9._+-]+\/)*[a-z0-9._+-]+$/.test(target)
      ) ||
      new Set(entry.targets).size !== entry.targets.length
    ) {
      throw new Error(`compatibility.aliases[${index}] is invalid`);
    }
    for (const target of entry.targets) {
      if (aliasTargets.has(target)) {
        throw new Error(`compatibility alias target is duplicated: ${target}`);
      }
      aliasTargets.add(target);
    }
  }
}

function validateTapMetadata(lock, path) {
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(metadata) ||
    metadata.schema !== 1 ||
    metadata.tap_repository !== tapRepository ||
    metadata.tap_name !== tapName ||
    !Array.isArray(metadata.packages)
  ) {
    throw new Error(`tap metadata has the wrong identity or package shape: ${path}`);
  }
  const byName = new Map();
  for (const [index, value] of metadata.packages.entries()) {
    const pkg = readTapMetadataPackage(value, `metadata.packages[${index}]`);
    if (byName.has(pkg.name)) {
      throw new Error(`tap metadata contains duplicate Formula ${pkg.name}`);
    }
    byName.set(pkg.name, pkg);
  }
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
  const actualClosure = resolveTapFormulaClosure(
    lock.packages.map(({ formula }) => formula.name),
    byName,
  );
  if (actualClosure.length !== expectedClosureCount) {
    throw new Error(
      `tap metadata resolves ${actualClosure.length} main-shell Formulae; ` +
        `the reviewed closure requires ${expectedClosureCount}`,
    );
  }
  assertExactSet(
    actualClosure,
    lock.formula_closure,
    "tap metadata dependency closure does not match reviewed formula_closure",
    (value) => value,
  );
}

function readTapMetadataPackage(value, label) {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value.name) ||
    value.full_name !== `${tapName}/${value.name}` ||
    typeof value.version !== "string" ||
    !Number.isInteger(value.formula_revision) ||
    !Number.isInteger(value.bottle_rebuild) ||
    !Array.isArray(value.dependencies)
  ) {
    throw new Error(`${label} is not a canonical Formula metadata record`);
  }
  const dependencies = value.dependencies.map((dependency, index) => {
    const dependencyLabel = `${label}.dependencies[${index}]`;
    if (
      !isRecord(dependency) ||
      typeof dependency.name !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(dependency.name) ||
      (dependency.full_name !== undefined &&
        dependency.full_name !== `${tapName}/${dependency.name}`)
    ) {
      throw new Error(`${dependencyLabel} is not a canonical same-tap dependency`);
    }
    return dependency.name;
  });
  assertUnique(dependencies, `${label}.dependencies`);
  return { ...value, dependencies };
}

function resolveTapFormulaClosure(rootNames, byName) {
  const ordered = [];
  const state = new Map();
  const stack = [];

  function visit(name, requiredBy) {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      const cycleStart = stack.indexOf(name);
      const cycle = [...stack.slice(cycleStart < 0 ? 0 : cycleStart), name];
      throw new Error(`tap metadata dependency cycle: ${cycle.join(" -> ")}`);
    }
    const pkg = byName.get(name);
    if (pkg === undefined) {
      const context = requiredBy === undefined ? "registry root" : `dependency of ${requiredBy}`;
      throw new Error(`tap metadata is missing ${context} Formula ${name}`);
    }
    state.set(name, "visiting");
    stack.push(name);
    for (const dependency of pkg.dependencies) visit(dependency, name);
    stack.pop();
    state.set(name, "done");
    ordered.push(`${tapName}/${name}`);
  }

  for (const name of rootNames) visit(name);
  return ordered;
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

function assertExactSet(actual, expected, message, render) {
  const actualValues = actual.map(render).sort();
  const expectedValues = expected.map(render).sort();
  if (JSON.stringify(actualValues) === JSON.stringify(expectedValues)) return;
  const missing = expectedValues.filter((value) => !actualValues.includes(value));
  const extra = actualValues.filter((value) => !expectedValues.includes(value));
  throw new Error(
    `${message}\n  missing: ${missing.join(", ") || "(none)"}` +
      `\n  extra: ${extra.join(", ") || "(none)"}`,
  );
}

function assertUnique(values, label) {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate) throw new Error(`${label} contains duplicate ${duplicate}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
