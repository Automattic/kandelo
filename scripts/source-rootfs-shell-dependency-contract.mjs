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
      entry.version.length === 0 ||
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
  if (process.argv.length !== 4 || process.argv[2] !== "--print-resolver-owned") {
    throw new Error(
      "usage: source-rootfs-shell-dependency-contract.mjs " +
        "--print-resolver-owned <contract.json>",
    );
  }
  const contract = readSourceRootfsShellDependencyContract(resolve(process.argv[3]));
  for (const { name } of resolverOwnedSourceRootfsShellDependencies(contract)) {
    console.log(name);
  }
}
