#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadVfsProductCatalog } from "./vfs-product-catalog.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootfsAlias = "@rootfs-vfs";

export function checkPagesVfsProductRegistry(options) {
  const catalog = loadVfsProductCatalog(options.catalogPath);
  const registry = readPagesRegistry(options.registryPath);
  const generatedRegistry = readGeneratedPagesRegistry(options.generatedRegistryPath);
  if (JSON.stringify(registry) !== JSON.stringify(generatedRegistry)) {
    throw new Error("source and generated Pages registries differ");
  }
  checkPagesGallery({
    galleryPath: options.galleryPath,
    pagesProducts: registry.products,
    presentationPath: options.presentationPath,
    liveSetupPath: options.browserSources.find((path) => basename(path) === "live-setup.ts"),
  });
  const adapters = readAdapterRegistry(options.adapterPath);
  const adapterByProduct = new Map(adapters.map((adapter) => [adapter.product, adapter]));
  const selected = new Map();

  for (const entry of registry.products) {
    const product = catalog.productById(entry.id);
    const adapter = adapterByProduct.get(entry.id);
    if (adapter === undefined) {
      throw new Error(`Pages product ${entry.id} has no mechanical legacy adapter`);
    }
    selected.set(entry.id, {
      ...entry,
      product,
      adapter,
      artifact: projectedArtifact(product, adapter),
    });
  }

  const sources = options.browserSources.map((path) => ({
    path,
    source: readFileSync(path, "utf8"),
  }));
  requireExactBrowserSourceKinds(sources);
  checkRootfsAliasProjection(selected, sources);
  checkCanonicalPagesProjection(selected, sources);

  const imports = sources.flatMap(({ path, source }) =>
    extractStaticImports(source).map((specifier) => ({ path, specifier })),
  );
  const globs = sources.flatMap(({ path, source }) =>
    extractGlobImports(source).map((specifier) => ({ path, specifier })),
  );

  for (const entry of selected.values()) {
    const staticMatches = imports.filter(({ specifier }) =>
      matchesProductSpecifier(specifier, entry),
    );
    const globMatches = globs.filter(({ specifier }) =>
      matchesProductSpecifier(specifier, entry),
    );
    if (entry.load === "eager") {
      if (staticMatches.length === 0) {
        throw new Error(
          `${entry.id} is eager in the Pages registry but has no static import`,
        );
      }
      if (globMatches.length !== 0) {
        throw new Error(`${entry.id} is eager but also has a lazy import.meta.glob loader`);
      }
    } else {
      if (globMatches.length === 0) {
        throw new Error(
          `${entry.id} is lazy in the Pages registry but has no import.meta.glob loader`,
        );
      }
      if (staticMatches.length !== 0) {
        throw new Error(`${entry.id} is lazy but is also referenced by a static import`);
      }
    }
  }

  const allKnownProducts = new Map();
  for (const id of catalog.productIds) {
    const adapter = adapterByProduct.get(id);
    if (adapter === undefined) continue;
    const product = catalog.productById(id);
    allKnownProducts.set(id, {
      id,
      product,
      adapter,
      artifact: projectedArtifact(product, adapter),
    });
  }
  for (const reference of [...imports, ...globs]) {
    if (!isVfsSpecifier(reference.specifier)) continue;
    const selectedMatch = [...selected.values()].find((entry) =>
      matchesProductSpecifier(reference.specifier, entry),
    );
    if (selectedMatch !== undefined) continue;
    const knownMatch = [...allKnownProducts.values()].find((entry) =>
      matchesProductSpecifier(reference.specifier, entry),
    );
    if (knownMatch !== undefined) {
      throw new Error(
        `${knownMatch.id} is referenced by browser source but is not selected by Pages`,
      );
    }
    throw new Error(
      `browser source contains an unregistered VFS product: ${reference.specifier}`,
    );
  }

  checkBrowserDependencies({
    runPath: options.browserDepsPath,
    catalog,
    adapters,
    selected,
  });
}

function checkCanonicalPagesProjection(selected, sources) {
  const viteSource = sourceNamed(sources, "vite.config.ts");
  const canonicalPlugin = viteSource.indexOf("pagesVfsProducts,");
  const kernelResolver = viteSource.indexOf("resolveKernelArtifactsAlias(binaryDevAccess)");
  const binaryResolver = viteSource.indexOf(
    "resolveBinariesAlias(binaryDevAccess, browserBinaryResolution)",
  );
  if (
    !viteSource.includes("KANDELO_PAGES_PRODUCT_MAP") || canonicalPlugin < 0 ||
    kernelResolver < canonicalPlugin || binaryResolver < canonicalPlugin
  ) {
    throw new Error("canonical Pages VFS resolver must precede every ordinary VFS resolver");
  }

  const liveSource = sourceNamed(sources, "live-setup.ts");
  if (
    !liveSource.includes('from "virtual:kandelo-pages-vfs-products"') ||
    !liveSource.includes("createPagesVfsProductLoader(") ||
    !liveSource.includes('activate("platform-rootfs")') ||
    !liveSource.includes('activate("browser-main-shell")')
  ) {
    throw new Error("browser live setup lacks the canonical eager Pages product loader");
  }
  for (const id of selected.keys()) {
    if (id === "platform-rootfs") continue;
    if (!liveSource.includes(`productId: "${id}"`)) {
      throw new Error(`browser live setup lacks canonical product mapping for ${id}`);
    }
  }

  const optionalSource = sourceNamed(sources, "optional-demo-vfs.ts");
  if (
    !optionalSource.includes("canonicalProductUrl?: () => Promise<string>") ||
    !optionalSource.includes("if (canonicalProductUrl !== undefined) return canonicalProductUrl()")
  ) {
    throw new Error("optional Pages VFS resolver can evaluate fallback in canonical mode");
  }
}

export function projectedArtifact(product, adapter) {
  if (adapter.mirror_filename === undefined) {
    return { filename: product.output, rawFilename: product.output };
  }
  const productExtensionStart = product.output.indexOf(".");
  const mirrorExtensionStart = adapter.mirror_filename.indexOf(".");
  if (productExtensionStart < 1 || mirrorExtensionStart < 1) {
    throw new Error(
      `${product.id} canonical and transitional outputs must have artifact extensions`,
    );
  }
  const productExtension = product.output.slice(productExtensionStart);
  const mirrorExtension = adapter.mirror_filename.slice(mirrorExtensionStart);
  if (productExtension !== mirrorExtension) {
    throw new Error(
      `${product.id} adapter output type ${mirrorExtension} differs from ` +
        `canonical output type ${productExtension}`,
    );
  }
  return {
    filename: `${adapter.output}${mirrorExtension}`,
    rawFilename: product.output,
  };
}

function matchesProductSpecifier(specifier, entry) {
  const clean = specifier.replace(/[?#].*$/, "");
  if (entry.id === "platform-rootfs" && clean === rootfsAlias) return true;
  const prefix = `/programs/${entry.product.architecture}/`;
  return (
    clean.endsWith(`${prefix}${entry.artifact.filename}`) ||
    clean.endsWith(`${prefix}${entry.artifact.rawFilename}`)
  );
}

export function isVfsSpecifier(specifier) {
  const clean = specifier.replace(/[?#].*$/, "");
  return clean === rootfsAlias ||
    /(?:^|\/)[^/]*\.vfs(?:\.zst)?(?:-[A-Za-z0-9_-]+)?(?:\.zst)?$/.test(clean);
}

function checkRootfsAliasProjection(selected, sources) {
  const rootfs = selected.get("platform-rootfs");
  if (rootfs === undefined) return;
  if (rootfs.load !== "eager") {
    throw new Error("platform-rootfs alias must remain eager in the Pages registry");
  }
  const hostSource = sourceNamed(sources, "browser-kernel-default-artifacts.ts");
  if (!hostSource.includes(`from "${rootfsAlias}?url"`)) {
    throw new Error("platform-rootfs is not statically imported through @rootfs-vfs");
  }
  const viteSource = sourceNamed(sources, "vite.config.ts");
  if (
    !viteSource.includes("const ROOTFS = browserRootfsModuleSpecifier") ||
    !viteSource.includes(
      `programs/${rootfs.product.architecture}/${rootfs.artifact.filename}`,
    )
  ) {
    throw new Error(
      "the @rootfs-vfs Vite alias is not a mechanical platform-rootfs projection",
    );
  }
}

function checkBrowserDependencies({ runPath, catalog, adapters, selected }) {
  const source = readFileSync(runPath, "utf8");
  const dependencyMatch = /(?:^|\n)BROWSER_DEPS=\(([^)]*)\)/.exec(source);
  if (dependencyMatch === null) {
    throw new Error(`${runPath} has no literal BROWSER_DEPS array`);
  }
  const dependencies = dependencyMatch[1].trim().split(/\s+/).filter(Boolean);
  requireUnique(dependencies, "run.sh BROWSER_DEPS");
  const dependencySet = new Set(dependencies);
  const targetFunctions = readBuildTargetFunctions(source);
  const functionBodies = readShellFunctionBodies(source);
  const targetsByProduct = new Map();
  const registeredTargets = new Set();

  for (const adapter of adapters) {
    const product = catalog.productById(adapter.product);
    let matches = [...targetFunctions].filter(([target, functionName]) => {
      if (adapter.product === "platform-rootfs" && target === "rootfs") return true;
      const body = functionBodies.get(functionName) ?? "";
      if (body.includes(adapter.build_target)) return true;
      if (adapter.package === undefined) return false;
      const packagePattern = escapeRegExp(adapter.package);
      return (
        body.includes(`packages/registry/${adapter.package}/`) ||
        new RegExp(`\\bresolve[ \\t]+${packagePattern}\\b`).test(body) ||
        new RegExp(`\\bpkg_has_output[ \\t]+${packagePattern}\\b`).test(body)
      );
    });
    if (matches.length > 1 && adapter.product.includes("mariadb-wasm")) {
      matches = matches.filter(([target]) =>
        product.architecture === "wasm64" ? target.includes("64") : !target.includes("64"),
      );
    }
    const targets = matches.map(([target]) => target);
    targetsByProduct.set(adapter.product, targets);
    for (const target of targets) registeredTargets.add(target);
  }

  for (const target of dependencies) {
    if ((target === "rootfs" || target.endsWith("-vfs")) && !registeredTargets.has(target)) {
      throw new Error(`run.sh BROWSER_DEPS has unregistered VFS build target ${target}`);
    }
  }
  for (const entry of selected.values()) {
    const targets = targetsByProduct.get(entry.id) ?? [];
    const present = targets.find((target) => dependencySet.has(target));
    if (present === undefined) {
      throw new Error(
        `${entry.id} has no selected legacy BROWSER_DEPS target; expected ` +
          `${targets.join(" or ") || "a registered adapter target"}`,
      );
    }
  }
}

function readBuildTargetFunctions(source) {
  const targets = new Map();
  const pattern = /^\s*([a-z0-9][a-z0-9-]*)\)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b[^\n]*;;\s*$/gm;
  for (const match of source.matchAll(pattern)) targets.set(match[1], match[2]);
  return targets;
}

function readShellFunctionBodies(source) {
  const functions = new Map();
  const pattern = /^([a-zA-Z_][a-zA-Z0-9_]*)\(\) \{\n([\s\S]*?)^\}/gm;
  for (const match of source.matchAll(pattern)) functions.set(match[1], match[2]);
  return functions;
}

export function readPagesRegistry(path) {
  const parsed = parseArrayTableToml(path, "products");
  exactObjectKeys(parsed.root, ["kind", "schema"], "Pages registry");
  if (parsed.root.schema !== 1 || parsed.root.kind !== "kandelo-pages-vfs-products") {
    throw new Error(`invalid Pages VFS product registry: ${path}`);
  }
  const products = parsed.entries.map((entry, index) => {
    exactObjectKeys(entry, ["id", "load"], `Pages products[${index}]`);
    requireTomlString(entry.id, `Pages products[${index}].id`);
    if (entry.load !== "eager" && entry.load !== "lazy") {
      throw new Error(`Pages products[${index}].load must be eager or lazy`);
    }
    return entry;
  });
  requireUnique(products.map(({ id }) => id), "Pages product IDs");
  products.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {
    kind: "kandelo-pages-vfs-products",
    products,
    schema: 1,
  };
}

export function readGeneratedPagesRegistry(path) {
  const bytes = readFileSync(path, "utf8");
  const value = JSON.parse(bytes);
  if (bytes !== canonicalJson(value)) {
    throw new Error("generated Pages registry is not canonical JSON");
  }
  exactObjectKeys(value, ["kind", "products", "schema"], "generated Pages registry");
  if (
    value.schema !== 1 || value.kind !== "kandelo-pages-vfs-products" ||
    !Array.isArray(value.products)
  ) throw new Error("generated Pages registry has unsupported identity");
  value.products.forEach((entry, index) => {
    exactObjectKeys(entry, ["id", "load"], `generated Pages products[${index}]`);
    requireTomlString(entry.id, `generated Pages products[${index}].id`);
    if (entry.load !== "eager" && entry.load !== "lazy") {
      throw new Error(`generated Pages products[${index}].load must be eager or lazy`);
    }
  });
  requireUnique(value.products.map(({ id }) => id), "generated Pages product IDs");
  return value;
}

function checkPagesGallery({ galleryPath, pagesProducts, presentationPath, liveSetupPath }) {
  if (typeof galleryPath !== "string" || typeof presentationPath !== "string" ||
      typeof liveSetupPath !== "string") {
    throw new Error("Pages gallery check lacks its reviewed presentation authorities");
  }
  const products = readPagesGallery(galleryPath, pagesProducts).products;

  const presetSource = readFileSync(presentationPath, "utf8");
  const presetStart = presetSource.indexOf("export const PRESET_LIBRARY");
  const presetEnd = presetSource.indexOf("\n];", presetStart);
  if (presetStart < 0 || presetEnd < 0) throw new Error("reviewed preset authority is not static");
  const presetIds = [...presetSource.slice(presetStart, presetEnd).matchAll(/^\s{4}id: "([a-z0-9-]+)",$/gmu)]
    .map((match) => match[1]);
  requireUnique(presetIds, "reviewed preset IDs");

  const liveSource = readFileSync(liveSetupPath, "utf8");
  const specStart = liveSource.indexOf("const LIVE_DEMO_SPECS");
  const specEnd = liveSource.indexOf("\n};", specStart);
  if (specStart < 0 || specEnd < 0) throw new Error("reviewed live-demo authority is not static");
  const imageByEntry = new Map(
    [...liveSource.slice(specStart, specEnd).matchAll(
      /^\s{2}(?:"([a-z0-9-]+)"|([a-z0-9-]+)): \{\n\s{4}image: "([a-z0-9-]+)",$/gmu,
    )].map((match) => [match[1] ?? match[2], match[3]]),
  );
  const declaredEntries = products.flatMap(({ gallery_entries }) => gallery_entries).sort();
  if (JSON.stringify(declaredEntries) !== JSON.stringify([...presetIds].sort())) {
    throw new Error("Pages gallery entries differ from the reviewed preset authority");
  }
  for (const product of products) {
    for (const entry of product.gallery_entries) {
      if (!presetIds.includes(entry)) {
        throw new Error(`Pages gallery entry ${entry} is absent from the reviewed preset authority`);
      }
      const image = imageByEntry.get(entry);
      if (image !== product.vfs_image) {
        throw new Error(
          `Pages gallery entry ${entry} uses reviewed VFS image ${String(image)}, not ${product.vfs_image}`,
        );
      }
    }
  }
}

export function readPagesGallery(galleryPath, pagesProducts) {
  const bytes = readFileSync(galleryPath, "utf8");
  const value = JSON.parse(bytes);
  if (bytes !== canonicalJson(value)) throw new Error("Pages gallery registry is not canonical JSON");
  exactObjectKeys(value, ["kind", "products", "schema"], "Pages gallery registry");
  if (value.schema !== 1 || value.kind !== "kandelo-pages-vfs-product-gallery" ||
      !Array.isArray(value.products)) {
    throw new Error("Pages gallery registry has unsupported identity");
  }
  const products = value.products.map((entry, index) => {
    exactObjectKeys(entry, ["gallery_entries", "id", "vfs_image"], `Pages gallery product ${index}`);
    requireTomlString(entry.id, `Pages gallery product ${index}.id`);
    requireTomlString(entry.vfs_image, `Pages gallery product ${index}.vfs_image`);
    if (!Array.isArray(entry.gallery_entries) ||
        entry.gallery_entries.some((id) => typeof id !== "string" || id.length === 0)) {
      throw new Error(`Pages gallery product ${entry.id} has invalid gallery entries`);
    }
    requireUnique(entry.gallery_entries, `Pages gallery product ${entry.id}`);
    if (JSON.stringify(entry.gallery_entries) !== JSON.stringify([...entry.gallery_entries].sort())) {
      throw new Error(`Pages gallery product ${entry.id} entries are not sorted`);
    }
    return entry;
  });
  const pagesIds = pagesProducts.map(({ id }) => id).sort();
  const galleryIds = products.map(({ id }) => id).sort();
  if (JSON.stringify(galleryIds) !== JSON.stringify(pagesIds)) {
    throw new Error("Pages gallery registry differs from the exact Pages product set");
  }
  requireUnique(galleryIds, "Pages gallery product IDs");
  return { kind: value.kind, products, schema: value.schema };
}

function canonicalJson(value) {
  const normalize = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, normalize(child)]));
    }
    return candidate;
  };
  return `${JSON.stringify(normalize(value))}\n`;
}

export function readAdapterRegistry(path) {
  const parsed = parseArrayTableToml(path, "adapters");
  exactObjectKeys(parsed.root, ["kind", "schema"], "legacy adapter registry");
  if (parsed.root.schema !== 1 || parsed.root.kind !== "kandelo-legacy-vfs-adapters") {
    throw new Error(`invalid legacy VFS adapter registry: ${path}`);
  }
  const adapters = parsed.entries.map((entry, index) => {
    const label = `legacy adapters[${index}]`;
    if (Object.hasOwn(entry, "package")) {
      exactObjectKeys(
        entry,
        ["build_target", "mirror_filename", "output", "package", "product"],
        label,
      );
    } else {
      exactObjectKeys(entry, ["build_target", "product"], label);
    }
    for (const [key, value] of Object.entries(entry)) requireTomlString(value, `${label}.${key}`);
    return entry;
  });
  requireUnique(adapters.map(({ product }) => product), "legacy adapter products");
  return adapters;
}

function parseArrayTableToml(path, tableName) {
  const root = {};
  const entries = [];
  let current = root;
  for (const [index, rawLine] of readFileSync(path, "utf8").split("\n").entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === `[[${tableName}]]`) {
      current = {};
      entries.push(current);
      continue;
    }
    if (line.startsWith("[")) {
      throw new Error(`${path}:${index + 1} has unsupported TOML table ${line}`);
    }
    const match = /^([a-z_]+)\s*=\s*(.+)$/.exec(line);
    if (match === null) throw new Error(`${path}:${index + 1} has unsupported TOML: ${line}`);
    if (Object.hasOwn(current, match[1])) {
      throw new Error(`${path}:${index + 1} duplicates ${match[1]}`);
    }
    current[match[1]] = parseTomlScalar(match[2], `${path}:${index + 1}`);
  }
  return { root, entries };
}

function parseTomlScalar(raw, label) {
  if (/^[0-9]+$/.test(raw)) return Number.parseInt(raw, 10);
  const string = /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
  if (string !== null) return JSON.parse(`"${string[1]}"`);
  throw new Error(`${label} has unsupported TOML value ${raw}`);
}

function extractStaticImports(source) {
  return [...source.matchAll(/\bimport\s+(?!type\b)[^;]*?\sfrom\s*["']([^"']+)["']/gs)]
    .map((match) => match[1]);
}

function extractGlobImports(source) {
  return [...source.matchAll(/import\.meta\.glob\(\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);
}

function requireExactBrowserSourceKinds(sources) {
  for (const name of [
    "browser-kernel-default-artifacts.ts",
    "vite.config.ts",
    "live-setup.ts",
    "optional-demo-vfs.ts",
  ]) {
    sourceNamed(sources, name);
  }
  if (sources.length !== 4) {
    throw new Error("Pages projection must inspect exactly four browser source files");
  }
}

function sourceNamed(sources, name) {
  const matches = sources.filter(({ path }) => basename(path) === name);
  if (matches.length !== 1) throw new Error(`Pages projection requires exactly one ${name}`);
  return matches[0].source;
}

function exactObjectKeys(value, expected, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields differ: expected ${wanted.join(", ")}, got ${actual.join(", ")}`);
  }
}

function requireTomlString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
}

function requireUnique(values, label) {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate !== undefined) throw new Error(`${label} contains duplicate ${duplicate}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    throw new Error("usage: check-pages-vfs-product-registry.mjs");
  }
  checkPagesVfsProductRegistry({
    catalogPath: resolve(repoRoot, "images/vfs/products/generated/catalog.json"),
    registryPath: resolve(
      repoRoot,
      "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml",
    ),
    generatedRegistryPath: resolve(
      repoRoot,
      "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
    ),
    galleryPath: resolve(
      repoRoot,
      "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json",
    ),
    presentationPath: resolve(repoRoot, "apps/browser-demos/pages/kandelo/presets.ts"),
    adapterPath: resolve(repoRoot, "abi/staging/legacy-vfs-adapters.toml"),
    browserDepsPath: resolve(repoRoot, "run.sh"),
    browserSources: [
      resolve(repoRoot, "host/src/browser-kernel-default-artifacts.ts"),
      resolve(repoRoot, "apps/browser-demos/vite.config.ts"),
      resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts"),
      resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts"),
    ],
  });
}
