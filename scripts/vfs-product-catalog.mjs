#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const catalogKind = "kandelo-vfs-product-catalog";
const productIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const legacyTapName = "kandelo-dev/tap-core";
const canonicalTapRepository = "kandelo-dev/homebrew-tap-core";
const legacyTapPrefix = `${legacyTapName}/`;
const maximumCatalogBytes = 16 * 1024 * 1024;

export function loadVfsProductCatalog(catalogPath) {
  const path = resolve(catalogPath);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`VFS product catalog must be a regular non-symlink file: ${path}`);
  }
  if (metadata.size === 0 || metadata.size > maximumCatalogBytes) {
    throw new Error(`VFS product catalog has an invalid byte length: ${path}`);
  }

  const bytes = readFileSync(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`cannot parse VFS product catalog ${path}: ${error.message}`);
  }
  validateIntegerNumbers(value, "catalog");
  const canonical = canonicalJsonBytes(value);
  if (!bytes.equals(canonical)) {
    throw new Error(`VFS product catalog is not canonical JSON: ${path}`);
  }
  exactKeys(value, ["kind", "products", "schema"], "catalog");
  if (value.schema !== 1 || value.kind !== catalogKind) {
    throw new Error(`invalid VFS product catalog schema or kind: ${path}`);
  }
  if (!Array.isArray(value.products) || value.products.length === 0) {
    throw new Error("VFS product catalog products must be a nonempty array");
  }

  const products = new Map();
  for (const [index, entry] of value.products.entries()) {
    const label = `catalog.products[${index}]`;
    exactKeys(entry, ["manifest", "path", "sha256"], label);
    requireString(entry.path, `${label}.path`);
    requireNormalizedRepositoryPath(entry.path, `${label}.path`);
    if (!sha256Pattern.test(entry.sha256)) {
      throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest`);
    }
    validateManifest(entry.manifest, `${label}.manifest`);
    const actualDigest = createHash("sha256")
      .update(canonicalJsonBytes(entry.manifest))
      .digest("hex");
    if (actualDigest !== entry.sha256) {
      throw new Error(
        `${label} manifest digest differs for ${entry.manifest.id}: ` +
          `expected ${entry.sha256}, actual ${actualDigest}`,
      );
    }
    if (products.has(entry.manifest.id)) {
      throw new Error(`duplicate product ID in VFS product catalog: ${entry.manifest.id}`);
    }
    products.set(entry.manifest.id, deepFreeze(entry.manifest));
  }

  return Object.freeze({
    productById(id) {
      const product = products.get(id);
      if (product === undefined) {
        throw new Error(`VFS product catalog has no product ${JSON.stringify(id)}`);
      }
      return product;
    },
    homebrewRoots(id) {
      const product = products.get(id);
      if (product === undefined) {
        throw new Error(`VFS product catalog has no product ${JSON.stringify(id)}`);
      }
      return Object.freeze(
        product.software.homebrew.flatMap((group) =>
          group.formulae.map((formula) =>
            Object.freeze({
              tap: group.tap,
              formula,
              materialization: group.materialization,
            }),
          ),
        ),
      );
    },
    productIds: Object.freeze([...products.keys()]),
  });
}

export function checkMainShellProjection(options) {
  const productId = "browser-main-shell";
  const catalog = loadVfsProductCatalog(options.catalogPath);
  const productRoots = catalog.homebrewRoots(productId);
  const product = catalog.productById(productId);
  const brewfileRoots = readBrewfileRoots(options.brewfilePath);
  const runtimeRoots = readRuntimeRoots(options.runtimeSupportPath);
  const embeddedRoots = readEmbeddedRoots(options.materializationPath);

  const declared = new Map();
  for (const formula of [...brewfileRoots, ...runtimeRoots]) {
    const materialization = embeddedRoots.has(formula) ? "embedded" : "lazy";
    const previous = declared.get(formula);
    if (previous !== undefined && previous !== materialization) {
      throw new Error(`${productId} root ${formula} has conflicting materialization`);
    }
    declared.set(formula, materialization);
  }
  for (const formula of embeddedRoots) {
    if (!declared.has(formula)) {
      throw new Error(
        `${productId} embedded root ${formula} is absent from the legacy selectors`,
      );
    }
  }

  const canonical = new Map();
  for (const root of productRoots) {
    if (root.tap !== canonicalTapRepository) {
      throw new Error(
        `${productId} Homebrew root ${root.formula} uses unsupported tap ${root.tap}`,
      );
    }
    if (canonical.has(root.formula)) {
      throw new Error(`${productId} has duplicate Homebrew root ${root.formula}`);
    }
    canonical.set(root.formula, root.materialization);
  }
  compareRootMaps(productId, declared, canonical);

  if (product.id !== productId) {
    throw new Error(`${productId} catalog lookup returned ${product.id}`);
  }
}

function validateManifest(value, label) {
  const manifestKeys = [
    "architecture",
    "builder",
    "composition",
    "evidence",
    "id",
    "mounts",
    "output",
    "schema",
    "software",
  ];
  if (Object.hasOwn(value ?? {}, "boot")) manifestKeys.push("boot");
  exactKeys(
    value,
    manifestKeys,
    label,
  );
  if (value.schema !== 1) throw new Error(`${label}.schema must equal 1`);
  if (typeof value.id !== "string" || !productIdPattern.test(value.id)) {
    throw new Error(`${label}.id is invalid`);
  }
  if (value.architecture !== "wasm32" && value.architecture !== "wasm64") {
    throw new Error(`${label}.architecture is invalid for ${value.id}`);
  }
  requirePortableFilename(value.output, `${label}.output`, value.id);
  requireNormalizedRepositoryPath(value.builder, `${label}.builder`);

  exactKeys(value.composition, ["product", "repository"], `${label}.composition`);
  requireArray(value.composition.product, `${label}.composition.product`);
  requireArray(value.composition.repository, `${label}.composition.repository`);
  for (const [index, input] of value.composition.product.entries()) {
    exactKeys(input, ["id", "materialization"], `${label}.composition.product[${index}]`);
    requireString(input.id, `${label}.composition.product[${index}].id`);
    requireMaterialization(
      input.materialization,
      `${label}.composition.product[${index}].materialization`,
    );
  }
  for (const [index, input] of value.composition.repository.entries()) {
    validateOptionalMaterializedRecord(
      input,
      ["id", "paths", "role"],
      `${label}.composition.repository[${index}]`,
    );
    requireString(input.id, `${label}.composition.repository[${index}].id`);
    requireStringArray(input.paths, `${label}.composition.repository[${index}].paths`);
    for (const path of input.paths) {
      requireNormalizedRepositoryPath(path, `${label}.composition.repository[${index}].paths`);
    }
    requireRole(input.role, `${label}.composition.repository[${index}].role`);
  }

  exactKeys(
    value.software,
    ["archive", "homebrew", "package", "toolchain"],
    `${label}.software`,
  );
  for (const key of ["archive", "homebrew", "package", "toolchain"]) {
    requireArray(value.software[key], `${label}.software.${key}`);
  }
  for (const [index, group] of value.software.homebrew.entries()) {
    const itemLabel = `${label}.software.homebrew[${index}]`;
    exactKeys(group, ["formulae", "materialization", "tap"], itemLabel);
    if (group.tap !== canonicalTapRepository) {
      throw new Error(`${itemLabel}.tap is unsupported`);
    }
    requireStringArray(group.formulae, `${itemLabel}.formulae`);
    requireMaterialization(group.materialization, `${itemLabel}.materialization`);
  }
  for (const [index, input] of value.software.package.entries()) {
    const itemLabel = `${label}.software.package[${index}]`;
    validateOptionalMaterializedRecord(
      input,
      ["name", "outputs", "role", "source_roles"],
      itemLabel,
    );
    requireString(input.name, `${itemLabel}.name`);
    requireStringArray(input.outputs, `${itemLabel}.outputs`);
    requireStringArray(input.source_roles, `${itemLabel}.source_roles`);
    requireRole(input.role, `${itemLabel}.role`);
  }
  for (const [index, input] of value.software.archive.entries()) {
    const itemLabel = `${label}.software.archive[${index}]`;
    validateOptionalMaterializedRecord(
      input,
      ["id", "role", "sha256", "url"],
      itemLabel,
    );
    requireString(input.id, `${itemLabel}.id`);
    requireString(input.url, `${itemLabel}.url`);
    if (!sha256Pattern.test(input.sha256)) throw new Error(`${itemLabel}.sha256 is invalid`);
    requireRole(input.role, `${itemLabel}.role`);
  }
  for (const [index, input] of value.software.toolchain.entries()) {
    const itemLabel = `${label}.software.toolchain[${index}]`;
    validateOptionalMaterializedRecord(
      input,
      ["component", "id", "provider", "role"],
      itemLabel,
    );
    requireString(input.id, `${itemLabel}.id`);
    requireString(input.component, `${itemLabel}.component`);
    if (!new Set(["prepared-runtime", "repository-dev-shell"]).has(input.provider)) {
      throw new Error(`${itemLabel}.provider is invalid`);
    }
    requireRole(input.role, `${itemLabel}.role`);
  }

  requireArray(value.mounts, `${label}.mounts`);
  for (const [index, mount] of value.mounts.entries()) {
    const mountLabel = `${label}.mounts[${index}]`;
    if (mount?.source === "built-image") {
      exactKeys(mount, ["path", "readonly", "source"], mountLabel);
      if (typeof mount.readonly !== "boolean") throw new Error(`${mountLabel}.readonly is invalid`);
    } else if (mount?.source === "scratch") {
      exactKeys(
        mount,
        ["ephemeral", "gid", "mode", "path", "source", "uid"],
        mountLabel,
      );
      if (typeof mount.ephemeral !== "boolean") throw new Error(`${mountLabel}.ephemeral is invalid`);
      requireString(mount.mode, `${mountLabel}.mode`);
    } else {
      throw new Error(`${mountLabel}.source is invalid`);
    }
    requireString(mount.path, `${mountLabel}.path`);
  }

  if (value.boot !== undefined) {
    exactKeys(value.boot, ["argv", "cwd", "env", "gid", "uid"], `${label}.boot`);
    requireStringArray(value.boot.argv, `${label}.boot.argv`);
    requireString(value.boot.cwd, `${label}.boot.cwd`);
    if (!isRecord(value.boot.env)) throw new Error(`${label}.boot.env must be an object`);
    for (const [key, child] of Object.entries(value.boot.env)) {
      requireString(child, `${label}.boot.env.${key}`);
    }
  }

  if (!isRecord(value.evidence)) throw new Error(`${label}.evidence must be an object`);
  const evidenceKeys = Object.keys(value.evidence);
  for (const key of evidenceKeys) {
    if (key !== "node" && key !== "browser") {
      throw new Error(`${label}.evidence has unknown field ${key}`);
    }
    exactKeys(value.evidence[key], ["test"], `${label}.evidence.${key}`);
    requireString(value.evidence[key].test, `${label}.evidence.${key}.test`);
  }
}

function validateOptionalMaterializedRecord(value, requiredKeys, label) {
  const keys = [...requiredKeys];
  if (Object.hasOwn(value ?? {}, "materialization")) keys.push("materialization");
  exactKeys(value, keys, label);
  if (Object.hasOwn(value, "materialization")) {
    requireMaterialization(value.materialization, `${label}.materialization`);
  }
}

function readBrewfileRoots(path) {
  const roots = [];
  let sawTap = false;
  for (const [index, rawLine] of readFileSync(path, "utf8").split("\n").entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === `tap "${legacyTapName}"`) {
      if (sawTap) throw new Error(`duplicate ${legacyTapName} declaration in ${path}`);
      sawTap = true;
      continue;
    }
    const match = /^brew "kandelo-dev\/tap-core\/([a-z0-9][a-z0-9._-]*)"$/.exec(line);
    if (match === null) throw new Error(`unsupported ${path}:${index + 1}: ${rawLine}`);
    roots.push(match[1]);
  }
  if (!sawTap) throw new Error(`missing ${legacyTapName} declaration in ${path}`);
  requireUnique(roots, `Brewfile ${path}`);
  return roots;
}

function readRuntimeRoots(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value?.formula_roots)) {
    throw new Error(`runtime support formula_roots must be an array: ${path}`);
  }
  const roots = value.formula_roots.map((entry, index) =>
    readLegacyFormulaIdentity(entry?.package, `formula_roots[${index}].package`),
  );
  requireUnique(roots, `runtime support ${path}`);
  return roots;
}

function readEmbeddedRoots(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    value.kind !== "kandelo-homebrew-vfs-materialization-policy" ||
    !Array.isArray(value.embedded_roots)
  ) {
    throw new Error(`invalid Homebrew materialization policy: ${path}`);
  }
  const roots = value.embedded_roots.map((entry, index) =>
    readLegacyFormulaIdentity(entry, `embedded_roots[${index}]`),
  );
  requireUnique(roots, `embedded roots ${path}`);
  return new Set(roots);
}

function readLegacyFormulaIdentity(value, label) {
  if (
    typeof value !== "string" ||
    !value.startsWith(legacyTapPrefix) ||
    !productIdPattern.test(value.slice(legacyTapPrefix.length))
  ) {
    throw new Error(`${label} must use ${legacyTapName}/<formula>`);
  }
  return value.slice(legacyTapPrefix.length);
}

function compareRootMaps(productId, legacy, canonical) {
  const names = [...new Set([...legacy.keys(), ...canonical.keys()])].sort();
  const differences = names.filter((name) => legacy.get(name) !== canonical.get(name));
  if (differences.length === 0) return;
  const detail = differences
    .map(
      (name) =>
        `${name} (legacy=${legacy.get(name) ?? "absent"}, ` +
        `product=${canonical.get(name) ?? "absent"})`,
    )
    .join(", ");
  throw new Error(`${productId} Homebrew root projection differs: ${detail}`);
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(normalizeJson(value))}\n`);
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeJson(value[key])]),
    );
  }
  return value;
}

function validateIntegerNumbers(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must contain integer numbers only`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateIntegerNumbers(child, `${label}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      validateIntegerNumbers(child, `${label}.${key}`);
    }
  }
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const expectedSet = new Set(expected);
  const unknown = Object.keys(value).find((key) => !expectedSet.has(key));
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`);
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new Error(`${label} is missing required field ${missing}`);
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
}

function requireStringArray(value, label) {
  requireArray(value, label);
  for (const [index, child] of value.entries()) requireString(child, `${label}[${index}]`);
}

function requireRole(value, label) {
  if (value !== "runtime" && value !== "build") throw new Error(`${label} is invalid`);
}

function requireMaterialization(value, label) {
  if (value !== "embedded" && value !== "lazy") throw new Error(`${label} is invalid`);
}

function requirePortableFilename(value, label, productId) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`${productId} ${label} must be a portable output filename`);
  }
}

function requireNormalizedRepositoryPath(value, label) {
  requireString(value, label);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a normalized repository path`);
  }
}

function requireUnique(values, label) {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate !== undefined) throw new Error(`${label} contains duplicate ${duplicate}`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== "check-main-shell" || process.argv.length !== 7) {
    throw new Error(
      "usage: vfs-product-catalog.mjs check-main-shell " +
        "<catalog.json> <Brewfile> <runtime-support.json> <materialization.json>",
    );
  }
  checkMainShellProjection({
    catalogPath: process.argv[3],
    brewfilePath: process.argv[4],
    runtimeSupportPath: process.argv[5],
    materializationPath: process.argv[6],
  });
}
