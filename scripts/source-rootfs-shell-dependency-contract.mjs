#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const validRoles = new Set([
  "base-image",
  "eager-program",
  "lazy-file",
  "lazy-archive",
]);
const packageNamePattern = /^[a-z0-9][a-z0-9._-]*$/;
const packageVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Read the single declarative dependency contract shared by the temporary
 * source-shell recipe, its composer, and its CI drift checker.
 */
export function readSourceRootfsShellDependencyContract(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(["dependencies", "schema"]) ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length === 0
  ) {
    throw new Error(`invalid source-rootfs shell dependency contract: ${path}`);
  }

  const dependencies = value.dependencies.map((entry, index) => {
    if (
      !isRecord(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !==
        JSON.stringify(["name", "role", "version"]) ||
      typeof entry.name !== "string" ||
      !packageNamePattern.test(entry.name) ||
      typeof entry.version !== "string" ||
      !packageVersionPattern.test(entry.version) ||
      typeof entry.role !== "string" ||
      !validRoles.has(entry.role)
    ) {
      throw new Error(
        `invalid source-rootfs shell dependency ${index}: ${path}`,
      );
    }
    return {
      name: entry.name,
      version: entry.version,
      role: entry.role,
    };
  });
  const names = dependencies.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new Error(
      `source-rootfs shell dependency names must be unique: ${path}`,
    );
  }
  return { schema: 1, dependencies };
}

/**
 * Parse the bridge manifest's top-level locked dependency array. This parser
 * is intentionally narrow: the bridge contract permits exactly one
 * `depends_on` declaration containing JSON-compatible quoted strings.
 */
export function readLockedPackageManifestDependencies(path) {
  const source = readFileSync(path, "utf8");
  const firstTable = source.search(/^[ \t]*\[/m);
  const topLevel = firstTable === -1 ? source : source.slice(0, firstTable);
  const declarations = Array.from(
    topLevel.matchAll(/^[ \t]*depends_on[ \t]*=/gm),
  );
  if (declarations.length !== 1) {
    throw new Error(
      `source-rootfs shell package manifest must declare depends_on exactly once: ${path}`,
    );
  }
  const match =
    /^[ \t]*depends_on[ \t]*=[ \t]*\[([\s\S]*?)\][ \t]*(?:#[^\r\n]*)?$/m.exec(
      topLevel,
    );
  if (match === null) {
    throw new Error(
      `source-rootfs shell package manifest has an unsupported depends_on array: ${path}`,
    );
  }

  let entries;
  try {
    // Package identities cannot contain '#', so stripping TOML comments before
    // JSON parsing cannot alter a valid dependency string. TOML permits one
    // trailing array comma; remove exactly that syntax before parsing.
    const arrayBody = match[1]
      .replace(/#[^\r\n]*/g, "")
      .trim()
      .replace(/,$/, "");
    entries = JSON.parse(`[${arrayBody}]`);
  } catch (error) {
    throw new Error(
      `source-rootfs shell package manifest has an invalid depends_on array: ${path}`,
      { cause: error },
    );
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      `source-rootfs shell package manifest must declare dependencies: ${path}`,
    );
  }

  const dependencies = entries.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(
        `source-rootfs shell package dependency ${index} must be a locked string: ${path}`,
      );
    }
    const at = entry.lastIndexOf("@");
    const name = entry.slice(0, at);
    const version = entry.slice(at + 1);
    if (
      at <= 0 ||
      at === entry.length - 1 ||
      !packageNamePattern.test(name) ||
      !packageVersionPattern.test(version)
    ) {
      throw new Error(
        `source-rootfs shell package dependency must be name@version, got ${JSON.stringify(entry)}: ${path}`,
      );
    }
    return { name, version };
  });
  const names = dependencies.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new Error(
      `source-rootfs shell package dependency names must be unique: ${path}`,
    );
  }
  return dependencies;
}

/**
 * Require the bridge package manifest to match the JSON contract exactly by
 * dependency identity. The JSON retains roles used by the composer; the
 * package manifest supplies no independent version authority.
 */
export function validateSourceRootfsShellPackageManifest(contract, path) {
  const actual = readLockedPackageManifestDependencies(path);
  const expectedByName = new Map(
    contract.dependencies.map(({ name, version }) => [name, version]),
  );
  const actualByName = new Map(
    actual.map(({ name, version }) => [name, version]),
  );
  const missing = [...expectedByName.keys()].filter(
    (name) => !actualByName.has(name),
  );
  const extra = [...actualByName.keys()].filter(
    (name) => !expectedByName.has(name),
  );
  const mismatched = [...expectedByName].flatMap(
    ([name, expectedVersion]) => {
      const actualVersion = actualByName.get(name);
      return actualVersion !== undefined && actualVersion !== expectedVersion
        ? [`${name}: expected ${expectedVersion}, got ${actualVersion}`]
        : [];
    },
  );
  if (missing.length > 0 || extra.length > 0 || mismatched.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
    if (extra.length > 0) details.push(`extra: ${extra.join(", ")}`);
    if (mismatched.length > 0) {
      details.push(`version drift: ${mismatched.join(", ")}`);
    }
    throw new Error(
      `source-rootfs shell package dependencies differ from the authoritative JSON contract (${details.join("; ")}): ${path}`,
    );
  }
  return actual;
}

export function resolverOwnedSourceRootfsShellDependencies(contract) {
  return contract.dependencies.filter(
    ({ role }) => role === "lazy-file" || role === "lazy-archive",
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 5 || process.argv[2] !== "--print-resolver-owned") {
    throw new Error(
      "usage: source-rootfs-shell-dependency-contract.mjs " +
        "--print-resolver-owned <contract.json> <package.toml>",
    );
  }
  const contract = readSourceRootfsShellDependencyContract(resolve(process.argv[3]));
  validateSourceRootfsShellPackageManifest(
    contract,
    resolve(process.argv[4]),
  );
  for (const { name } of resolverOwnedSourceRootfsShellDependencies(contract)) {
    console.log(name);
  }
}
