#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const catalogKind = "kandelo-vfs-product-catalog";
const productIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
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
    productIds: Object.freeze([...products.keys()]),
  });
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
    ["archive", "package", "toolchain"],
    `${label}.software`,
  );
  for (const key of ["archive", "package", "toolchain"]) {
    requireArray(value.software[key], `${label}.software.${key}`);
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
