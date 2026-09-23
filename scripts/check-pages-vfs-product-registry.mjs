#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "@babel/parser";

import { loadVfsProductCatalog } from "./vfs-product-catalog.mjs";
import { allTrackedProfileIds } from "./tracked-demo-config-sources.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootfsAlias = "@rootfs-vfs";

export function checkPagesVfsProductRegistry(options) {
  const catalog = loadVfsProductCatalog(options.catalogPath);
  assertNoAppMachineIdentityTables(catalog);
  const registry = readPagesRegistry(options.registryPath);
  const generatedRegistry = readGeneratedPagesRegistry(options.generatedRegistryPath);
  if (JSON.stringify(registry) !== JSON.stringify(generatedRegistry)) {
    throw new Error("source and generated Pages registries differ");
  }
  checkPagesGallery({
    catalog,
    galleryPath: options.galleryPath,
    pagesProducts: registry.products,
    rosterPath: options.rosterPath,
  });
  const selected = new Map();
  for (const entry of registry.products) {
    const product = catalog.productById(entry.id);
    selected.set(entry.id, {
      ...entry,
      product,
      artifact: projectedArtifact(product),
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
    const product = catalog.productById(id);
    allKnownProducts.set(id, {
      id,
      product,
      artifact: projectedArtifact(product),
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
    selected,
  });
}

/**
 * THE DURABLE GUARD (image-owned-machine-definitions, task B6): assert that
 * the browser app holds no built-in machine identities, so `LIVE_DEMO_SPECS`,
 * `PRESET_LIBRARY`, `DEMO_ALIASES`, and friends — all deleted by this
 * project — cannot quietly come back as a differently-named table.
 *
 * The hard part is admitting PRODUCT-id plumbing while rejecting PROFILE-id
 * tables. `VFS_SOURCES` was not deleted; it was re-keyed into `VFS_PRODUCTS`
 * (live-setup.ts) and `OPTIONAL_DEMO_VFS_PATHS` (optional-demo-vfs.ts) — both
 * still hold `relPaths`/URL plumbing per PRODUCT id (`browser-main-shell`,
 * `browser-wordpress`, ...), because Vite needs literal specifiers for those
 * mirror globs and because resolving "where do this product's bytes live in
 * THIS deployment" is a real, ongoing need that has nothing to do with
 * machine identity. That is legitimate and must be admitted. What must
 * never come back is a table keyed by PROFILE id (`doom`, `sdl2`,
 * `wordpress-sqlite`, ...) carrying per-machine content (title, argv, env,
 * features, ...) — that is exactly the shape of the deleted
 * `LIVE_DEMO_SPECS`.
 *
 * The two id spaces are disjoint by construction (`browser-*` / product ids
 * vs. bare `doom`/`sdl2`/... profile ids from the tracked demo configs), so
 * "admit every catalog product id, reject every OTHER tracked profile id" is
 * the general, non-hand-wavy rule: DANGEROUS_PROFILE_IDS is
 * allTrackedProfileIds() (from images/vfs/scripts/tracked-demo-config.ts's
 * own tracked JSON, the single authority for what a profile id even is)
 * minus catalog.productIds (from images/vfs/products/generated/catalog.json,
 * the single authority for what a product id is).
 *
 * A handful of pre-existing, already-reviewed constructs use a SHORT bucket
 * name ("node", "wordpress", "lamp") that happens to collide with a
 * single-profile image's profile id, or (candidate-evidence-vfs.ts) predate
 * this project entirely. Those are exempted by NAME below — (file,
 * declaration) pairs, each with a one-line reason — never by file or by
 * directory: an unexplained blanket exemption is the hole the next table
 * would walk through.
 */
const MACHINE_SURFACE_ROOTS = ["apps/browser-demos", "web-libs/kandelo-session/src"];
const EXCLUDED_SURFACE_DIR_NAMES = new Set(["node_modules", "dist", ".vite", "test", "tests"]);

/**
 * Named exemptions. Each entry names the exact file (by basename) and the
 * exact `const`/`type` declaration inside it that is allowed to reference
 * two or more machine profile ids, and says why in one line. Do not widen
 * this to a path or a whole-file exemption.
 */
const EXEMPT_MACHINE_ID_DECLARATIONS = [
  {
    file: "optional-demo-vfs.ts",
    name: "OptionalDemoVfsImage",
    reason:
      "Product/image-bucket names ('node'/'wordpress'/'lamp') that happen "
      + "to coincide with a single-profile image's profile id; the type "
      + "carries no per-machine content.",
  },
  {
    file: "optional-demo-vfs.ts",
    name: "OPTIONAL_DEMO_VFS_PATHS",
    reason:
      "Per-bucket artifact LOCATION plumbing (label + relPaths only) — no "
      + "title/summary/argv/env/features lives here, which is what makes "
      + "this artifact plumbing rather than machine identity.",
  },
  {
    file: "candidate-evidence-vfs.ts",
    name: "CandidateOptionalDemoVfsImage",
    reason:
      "Mirrors OptionalDemoVfsImage for the protected evidence path; same "
      + "bucket-naming coincidence, not machine identity.",
  },
  {
    file: "candidate-evidence-vfs.ts",
    name: "CandidateEvidenceLiveDemoId",
    reason:
      "Pre-existing admission boundary for the protected ABI-staging "
      + "evidence path (PR #1247). It predates image-owned-machine-"
      + "definitions and is out of scope for it: it selects which live demo "
      + "the protected evidence harness may inject, gating an unrelated "
      + "trust boundary, not an app-side machine-spec table for ordinary "
      + "boot.",
  },
  {
    file: "candidate-evidence-vfs.ts",
    name: "LIVE_DEMO_BY_EVIDENCE_PROFILE",
    reason: "Same protected ABI-staging admission boundary as CandidateEvidenceLiveDemoId above.",
  },
];

function isExemptDeclaration(context) {
  return EXEMPT_MACHINE_ID_DECLARATIONS.some(
    (entry) => entry.file === context.fileBase && entry.name === context.declaratorName,
  );
}

function collectMachineSurfaceFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_SURFACE_DIR_NAMES.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name);
      if (ext !== ".ts" && ext !== ".tsx") continue;
      if (entry.name.endsWith(".d.ts")) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      files.push(full);
    }
  };
  for (const relRoot of MACHINE_SURFACE_ROOTS) walk(resolve(root, relRoot));
  return files;
}

function objectPropertyKeyName(prop) {
  if (prop.type !== "ObjectProperty" && prop.type !== "ObjectMethod") return null;
  if (prop.computed) return null;
  const key = prop.key;
  if (key.type === "Identifier") return key.name;
  if (key.type === "StringLiteral") return key.value;
  return null;
}

const AST_SKIP_KEYS = new Set([
  "loc", "start", "end", "range", "leadingComments", "trailingComments", "innerComments",
]);

/**
 * Walk a Babel AST looking for three shapes a reintroduced machine-identity
 * table could take: an object literal keyed by >=2 dangerous profile ids
 * (LIVE_DEMO_SPECS's shape), a string-literal union type naming >=2 of them
 * (LIVE_DEMO_IDS/LiveDemoId's shape), or a switch statement branching on
 * >=2 of them (the id-selection ladder this project collapsed). Requiring
 * >=2 is deliberate: a single incidental match (e.g. a `wordpress` THEME
 * family, unrelated to any machine) is common and must not trip this guard;
 * a real machine-identity table always carries more than one machine.
 */
function walkForMachineIdentityTables(node, dangerousIds, findings, context) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkForMachineIdentityTables(child, dangerousIds, findings, context);
    return;
  }
  if (typeof node.type !== "string") {
    for (const key of Object.keys(node)) {
      if (AST_SKIP_KEYS.has(key)) continue;
      walkForMachineIdentityTables(node[key], dangerousIds, findings, context);
    }
    return;
  }

  let childContext = context;
  if (
    (node.type === "VariableDeclarator" || node.type === "TSTypeAliasDeclaration")
    && node.id?.type === "Identifier"
  ) {
    childContext = { ...context, declaratorName: node.id.name };
  }

  if (node.type === "ObjectExpression" && !isExemptDeclaration(context)) {
    const keys = node.properties.map(objectPropertyKeyName).filter((k) => k !== null);
    const dangerous = [...new Set(keys.filter((k) => dangerousIds.has(k)))];
    if (dangerous.length >= 2) {
      findings.push({ kind: "object literal", ids: dangerous, node, context });
    }
  } else if (node.type === "TSUnionType" && !isExemptDeclaration(context)) {
    const members = node.types
      .map((t) => (t.type === "TSLiteralType" && t.literal?.type === "StringLiteral" ? t.literal.value : null))
      .filter((v) => v !== null);
    const dangerous = [...new Set(members.filter((v) => dangerousIds.has(v)))];
    if (dangerous.length >= 2) {
      findings.push({ kind: "union type", ids: dangerous, node, context });
    }
  } else if (node.type === "SwitchStatement" && !isExemptDeclaration(context)) {
    const caseIds = node.cases
      .map((c) => (c.test?.type === "StringLiteral" ? c.test.value : null))
      .filter((v) => v !== null);
    const dangerous = [...new Set(caseIds.filter((v) => dangerousIds.has(v)))];
    if (dangerous.length >= 2) {
      findings.push({ kind: "switch statement", ids: dangerous, node, context });
    }
  }

  for (const key of Object.keys(node)) {
    if (AST_SKIP_KEYS.has(key)) continue;
    walkForMachineIdentityTables(node[key], dangerousIds, findings, childContext);
  }
}

/**
 * `root` defaults to this repository, but is overridable so tests can point
 * the file-scanning half at an isolated temp directory tree without ever
 * writing a fixture file into the real apps/browser-demos or
 * web-libs/kandelo-session sources. `dangerousIds` is always computed from
 * the REAL tracked demo configs regardless of `root`: the universe of real
 * machine profile ids is a property of this repository, not of whichever
 * directory is being scanned for a reintroduced table.
 */
export function assertNoAppMachineIdentityTables(catalog, root = repoRoot) {
  const allProfileIds = allTrackedProfileIds();
  const admittedProductIds = new Set(catalog.productIds);
  const dangerousIds = new Set(
    [...allProfileIds].filter((id) => !admittedProductIds.has(id)),
  );

  const findings = [];
  for (const file of collectMachineSurfaceFiles(root)) {
    const relPath = relative(root, file);
    const source = readFileSync(file, "utf8");
    let ast;
    try {
      ast = parse(source, {
        sourceType: "module",
        plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
      });
    } catch (error) {
      throw new Error(
        `failed to parse ${relPath} while scanning for machine-identity tables: ${error.message}`,
      );
    }
    const fileFindings = [];
    walkForMachineIdentityTables(ast.program, dangerousIds, fileFindings, {
      fileBase: basename(file),
    });
    for (const finding of fileFindings) findings.push({ ...finding, relPath });
  }

  if (findings.length > 0) {
    const lines = findings.map((finding) => {
      const line = finding.node.loc?.start?.line ?? "?";
      const where = finding.context.declaratorName ? ` (in ${finding.context.declaratorName})` : "";
      return `  ${finding.relPath}:${line} ${finding.kind} keyed by machine profile ids `
        + `[${finding.ids.join(", ")}]${where}`;
    });
    throw new Error(
      "browser app source declares a machine-identity table. Every machine "
        + "profile's title/argv/env/features must come from the image's own "
        + "/etc/kandelo/demo.json (web-libs/kandelo-session/src/demo-config.ts), "
        + "not from an app-side id table, union type, or switch:\n"
        + lines.join("\n"),
    );
  }
}

function checkCanonicalPagesProjection(selected, sources) {
  const viteSource = sourceNamed(sources, "vite.config.ts");
  const canonicalPlugin = viteSource.indexOf("vfsProductsPlugin(base),");
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

export function projectedArtifact(product) {
  return { filename: product.output, rawFilename: product.output };
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

function checkBrowserDependencies({ runPath, catalog, selected }) {
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

  // Match every catalog product to the run.sh build-target functions by
  // content: a function that bootstraps the product by id (the local-build
  // engine front door every VFS target delegates to), that invokes the
  // product's builder script, or that references one of the product's
  // candidate package names, materializes it.
  // BROWSER_DEPS may list non-deployed VFS targets (e.g. mariadb-vfs), so the
  // full catalog — not just the deployed set — must feed registeredTargets.
  for (const productId of catalog.productIds) {
    const product = catalog.productById(productId);
    const packageNames = productPackageNames(product);
    let matches = [...targetFunctions].filter(([target, functionName]) => {
      if (productId === "platform-rootfs" && target === "rootfs") return true;
      const body = functionBodies.get(functionName) ?? "";
      if (new RegExp(`\\bbootstrap_target[ \\t]+${escapeRegExp(productId)}(?=\\s|$)`, "m").test(body)) {
        return true;
      }
      if (product.builder !== undefined && body.includes(product.builder)) return true;
      return packageNames.some((pkg) => {
        const pattern = escapeRegExp(pkg);
        return (
          body.includes(`packages/registry/${pkg}/`) ||
          new RegExp(`\\bresolve[ \\t]+${pattern}\\b`).test(body) ||
          new RegExp(`\\bpkg_has_output[ \\t]+${pattern}\\b`).test(body)
        );
      });
    });
    if (matches.length > 1 && productId.includes("mariadb-wasm")) {
      matches = matches.filter(([target]) =>
        product.architecture === "wasm64" ? target.includes("64") : !target.includes("64"),
      );
    }
    const targets = matches.map(([target]) => target);
    targetsByProduct.set(productId, targets);
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
        `${entry.id} has no selected VFS build target; expected ` +
          `${targets.join(" or ") || "a registered build target"}`,
      );
    }
  }
}

// Candidate run.sh package names for a catalog product, derived from the
// catalog with no adapter registry: the declared output token (before the
// first extension separator), the VFS-image package captured from a
// build-<package>-image.sh builder path, and every declared software package
// name. The builder-path primary match resolves most products; these names
// resolve those whose run.sh function delegates to a package-registry wrapper.
function productPackageNames(product) {
  const names = new Set();
  const dot = product.output.indexOf(".");
  const outputToken = dot > 0 ? product.output.slice(0, dot) : product.output;
  if (outputToken.length > 0) names.add(outputToken);
  const builderImage = /(?:^|\/)build-(.+)-image\.sh$/.exec(product.builder ?? "");
  if (builderImage !== null) names.add(builderImage[1]);
  for (const pkg of product.software?.package ?? []) {
    if (typeof pkg?.name === "string" && pkg.name.length > 0) names.add(pkg.name);
  }
  return [...names];
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

/**
 * `pages-vfs-product-gallery.json` does DEPLOYMENT SCOPING ONLY: which
 * products this Pages deployment serves, and which VFS image each maps to.
 * It no longer carries `gallery_entries` — gallery MEMBERSHIP lives
 * exclusively in the curated roster
 * (apps/browser-demos/pages/kandelo/gallery-roster.json), per the spec's
 * "The roster" section. A roster entry is free to name a product this
 * deployment does not serve (the availability model's "unavailable here"
 * state); the only invariant left to check here is that every roster entry
 * names a product that actually exists in the catalog, so a typo'd product
 * id fails loudly instead of silently listing an unresolvable machine.
 */
function checkPagesGallery({ catalog, galleryPath, pagesProducts, rosterPath }) {
  if (typeof galleryPath !== "string" || typeof rosterPath !== "string") {
    throw new Error("Pages gallery check lacks its reviewed roster authority");
  }
  const products = readPagesGallery(galleryPath, pagesProducts).products;
  const roster = readGalleryRoster(rosterPath);
  const rosterProfiles = roster.map(({ profile }) => profile);
  requireUnique(rosterProfiles, "gallery roster profiles");
  const knownProductIds = new Set(catalog.productIds);
  for (const { product } of roster) {
    if (!knownProductIds.has(product)) {
      throw new Error(`gallery roster references unknown product ${product}`);
    }
  }

  for (const product of products) {
    // `vfs_image` used to be cross-checked against the app's LIVE_DEMO_SPECS
    // image families. With those deleted, hold it to the catalog instead:
    // it must be a mechanical projection of the product's declared output.
    const expected = vfsImageNameForOutput(catalog.productById(product.id).output);
    if (product.vfs_image !== expected) {
      throw new Error(
        `Pages gallery product ${product.id} declares VFS image ${product.vfs_image}, not ${expected}`,
      );
    }
  }
}

/** `nginx-vfs.vfs.zst` → `nginx`, `shell.vfs.zst` → `shell`, `rootfs.vfs` →
 *  `rootfs`. The gallery scoping names the image, not the artifact file. */
function vfsImageNameForOutput(output) {
  return output.replace(/(?:-vfs)?\.vfs(?:\.zst)?$/u, "");
}

function readGalleryRoster(rosterPath) {
  const value = JSON.parse(readFileSync(rosterPath, "utf8"));
  if (value === null || typeof value !== "object" || value.schema !== 1 ||
      !Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error("gallery roster has unsupported identity");
  }
  return value.entries.map((entry, index) => {
    exactObjectKeys(entry, ["product", "profile"], `gallery roster entry ${index}`);
    requireTomlString(entry.product, `gallery roster entry ${index}.product`);
    requireTomlString(entry.profile, `gallery roster entry ${index}.profile`);
    return entry;
  });
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
    exactObjectKeys(entry, ["id", "vfs_image"], `Pages gallery product ${index}`);
    requireTomlString(entry.id, `Pages gallery product ${index}.id`);
    requireTomlString(entry.vfs_image, `Pages gallery product ${index}.vfs_image`);
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
    rosterPath: resolve(repoRoot, "apps/browser-demos/pages/kandelo/gallery-roster.json"),
    browserDepsPath: resolve(repoRoot, "run.sh"),
    browserSources: [
      resolve(repoRoot, "host/src/browser-kernel-default-artifacts.ts"),
      resolve(repoRoot, "apps/browser-demos/vite.config.ts"),
      resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts"),
      resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts"),
    ],
  });
}
