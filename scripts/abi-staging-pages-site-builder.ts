import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import type { Plugin, ResolvedConfig } from "vite";

import { ABI_VERSION } from "../host/src/generated/abi.ts";
import { loadVfsProductCatalog } from "./vfs-product-catalog.mjs";
import {
  checkPagesVfsProductRegistry,
  isVfsSpecifier,
  projectedArtifact,
  readAdapterRegistry,
  readGeneratedPagesRegistry,
  readPagesGallery,
  readPagesRegistry,
} from "./check-pages-vfs-product-registry.mjs";

const MAX_MAP_BYTES = 1024 * 1024;
const MAX_PRODUCT_BYTES = 256 * 1024 * 1024;
const MAX_SITE_BYTES = 1_000_000_000;
const MAX_SITE_FILES = 65_536;
const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PRIVATE_MAP_KIND = "kandelo-pages-private-product-map";
const VIRTUAL_PRODUCTS = "virtual:kandelo-pages-vfs-products";
const RESOLVED_VIRTUAL_PRODUCTS = `\0${VIRTUAL_PRODUCTS}`;
const RESOLVED_PRODUCT_URL = "\0kandelo-pages-vfs-product-url:";

export interface CanonicalPagesProductMapEntryV1 {
  bytes: number;
  id: string;
  load: "eager" | "lazy";
  path: string;
  private_path: string;
  sha256: string;
}

export interface CanonicalPagesProductMapV1 {
  kind: "kandelo-pages-private-product-map";
  products: CanonicalPagesProductMapEntryV1[];
  schema: 1;
}

export interface PagesFileIdentityV1 {
  bytes: number;
  path: string;
  sha256: string;
}

export interface PagesSiteMetadataV1 {
  api: PagesFileIdentityV1;
  browser: PagesFileIdentityV1;
  documentation: PagesFileIdentityV1;
  files: PagesFileIdentityV1[];
  kind: "kandelo-pages-site-metadata";
  products: Array<{ gallery_entries: string[]; id: string; vfs_image: string }>;
  schema: 1;
}

export interface PagesSiteBuildCommand {
  arguments: string[];
  command: string;
  environment: Record<string, string>;
  name: "browser" | "documentation" | "api";
  output: string;
  workingDirectory: string;
}

export interface BuildFinalPagesSiteOptions {
  additionalFiles?: ReadonlyArray<PagesFileIdentityV1 & { body: Uint8Array }>;
  execute?(command: PagesSiteBuildCommand): void;
  outputRoot: string;
  productMapPath: string;
  sourceRoot: string;
}

interface CanonicalMapAuthority {
  gallery: PagesSiteMetadataV1["products"];
  productByLegacyFilename: Map<string, string>;
  productById: Map<string, { architecture: string }>;
}

interface CatalogProductProjection {
  architecture: string;
  output: string;
}

const mapAuthorities = new WeakMap<CanonicalPagesProductMapV1, CanonicalMapAuthority>();

export function loadCanonicalPagesProductMap(options: {
  mapPath: string;
  sourceRoot: string;
}): CanonicalPagesProductMapV1 {
  const sourceRoot = exactDirectory(options.sourceRoot, "Pages source root");
  const mapPath = exactAbsoluteFile(options.mapPath, "private Pages product map", MAX_MAP_BYTES);
  const paths = repositoryAuthorityPaths(sourceRoot);
  checkPagesVfsProductRegistry(paths.check);
  const catalog = loadVfsProductCatalog(paths.catalogPath);
  const sourceRegistry = readPagesRegistry(paths.registryPath);
  const generatedRegistry = readGeneratedPagesRegistry(paths.generatedRegistryPath);
  if (!jsonEqual(sourceRegistry, generatedRegistry)) {
    throw new Error("source and generated Pages registries differ");
  }
  const gallery = readPagesGallery(paths.galleryPath, generatedRegistry.products);
  const adapters = readAdapterRegistry(paths.adapterPath);
  const adapterByProduct = new Map(adapters.map((value: any) => [value.product, value]));

  const bytes = readFileSync(mapPath);
  const value = JSON.parse(bytes.toString("utf8"));
  if (!bytes.equals(Buffer.from(canonicalJson(value)))) {
    throw new Error("private Pages product map is not canonical JSON");
  }
  exactKeys(value, ["kind", "products", "schema"], "private Pages product map");
  if (value.schema !== 1 || value.kind !== PRIVATE_MAP_KIND || !Array.isArray(value.products)) {
    throw new Error("private Pages product map has unsupported identity");
  }
  const expected = generatedRegistry.products;
  if (value.products.length !== expected.length) {
    throw new Error("private Pages product map differs from the exact Pages product set");
  }
  const products = value.products.map((candidate: unknown, index: number) => {
    exactKeys(
      candidate,
      ["bytes", "id", "load", "path", "private_path", "sha256"],
      `private Pages product ${index}`,
    );
    const entry = candidate as CanonicalPagesProductMapEntryV1;
    if (!STABLE_ID.test(entry.id) || (entry.load !== "eager" && entry.load !== "lazy")) {
      throw new Error(`private Pages product ${index} has an invalid identity`);
    }
    if (index > 0 && value.products[index - 1].id >= entry.id) {
      throw new Error("private Pages products are not sorted and unique");
    }
    const wanted = expected[index];
    if (wanted?.id !== entry.id) {
      throw new Error("private Pages product map differs from the exact Pages product set");
    }
    if (wanted.load !== entry.load) {
      throw new Error(`private Pages product ${entry.id} load differs from the Pages registry`);
    }
    catalog.productById(entry.id);
    if (
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_PRODUCT_BYTES ||
      !SHA256.test(entry.sha256)
    ) {
      throw new Error(`private Pages product ${entry.id} has an invalid byte identity`);
    }
    const expectedPath = canonicalProductPath(entry.id, entry.sha256, ABI_VERSION);
    if (entry.path !== expectedPath || entry.path.includes("-candidates/")) {
      throw new Error(`private Pages product ${entry.id} lacks its current-ABI canonical product path`);
    }
    const privatePath = exactAbsoluteFile(
      entry.private_path,
      `private product ${entry.id}`,
      MAX_PRODUCT_BYTES,
      entry.bytes,
    );
    const body = readFileSync(privatePath);
    if (body.byteLength !== entry.bytes || sha256(body) !== entry.sha256) {
      throw new Error(`private product ${entry.id} differs from its authenticated identity`);
    }
    return Object.freeze({ ...entry, private_path: privatePath });
  });

  const productByLegacyFilename = new Map<string, string>();
  const productById = new Map<string, { architecture: string }>();
  for (const entry of products) {
    const product = catalog.productById(entry.id) as CatalogProductProjection;
    const adapter = adapterByProduct.get(entry.id);
    if (adapter === undefined) {
      throw new Error(`Pages product ${entry.id} has no legacy adapter`);
    }
    const artifact = projectedArtifact(product, adapter);
    for (const filename of new Set([product.output, artifact.filename, artifact.rawFilename])) {
      const prior = productByLegacyFilename.get(filename);
      if (prior !== undefined && prior !== entry.id) {
        throw new Error(`legacy VFS filename ${filename} maps to multiple Pages products`);
      }
      productByLegacyFilename.set(filename, entry.id);
    }
    productById.set(entry.id, { architecture: product.architecture });
  }
  const loaded: CanonicalPagesProductMapV1 = Object.freeze({
    kind: PRIVATE_MAP_KIND,
    products: Object.freeze(products) as unknown as CanonicalPagesProductMapEntryV1[],
    schema: 1,
  });
  mapAuthorities.set(loaded, {
    gallery: structuredClone(gallery.products),
    productById,
    productByLegacyFilename,
  });
  return loaded;
}

export function createCanonicalPagesVfsProductsPlugin(options: {
  base: string;
  map: CanonicalPagesProductMapV1 | null;
  mirrorRoots: readonly string[];
}): Plugin {
  const base = canonicalBase(options.base);
  const authority = options.map === null ? undefined : mapAuthorities.get(options.map);
  if (options.map !== null && authority === undefined) {
    throw new Error("canonical Pages VFS plugin requires a validated private product map");
  }
  const mirrorRoots = options.mirrorRoots.map(canonicalizeFromExistingAncestor);
  const publicProducts = options.map?.products.map(({ private_path: _privatePath, ...entry }) => ({
    ...entry,
    path: `${base}${entry.path}`,
  })) ?? null;
  const byId = new Map(options.map?.products.map((entry) => [entry.id, entry]) ?? []);
  let resolvedBase = base;

  return {
    name: "canonical-pages-vfs-products",
    enforce: "pre",
    configResolved(config: ResolvedConfig) {
      resolvedBase = canonicalBase(config.base);
      if (resolvedBase !== base) {
        throw new Error(`canonical Pages VFS base changed from ${base} to ${resolvedBase}`);
      }
    },
    resolveId(source, importer) {
      if (source === VIRTUAL_PRODUCTS) return RESOLVED_VIRTUAL_PRODUCTS;
      if (options.map === null || source.startsWith("\0")) return null;
      const pathPart = source.split("?", 1)[0]!;
      const id = canonicalProductForSpecifier(
        pathPart,
        importer,
        mirrorRoots,
        authority!,
      );
      if (id !== undefined) return `${RESOLVED_PRODUCT_URL}${id}`;
      if (isVfsSpecifier(pathPart)) {
        this.error(
          `unknown canonical Pages VFS request: ${source} from ${importer ?? "<entry>"}; ` +
            `mirror roots: ${mirrorRoots.join(", ")}`,
        );
      }
      return null;
    },
    load(id) {
      if (id === RESOLVED_VIRTUAL_PRODUCTS) {
        return `export default ${JSON.stringify(publicProducts)};\n`;
      }
      if (!id.startsWith(RESOLVED_PRODUCT_URL)) return null;
      const productId = id.slice(RESOLVED_PRODUCT_URL.length);
      const product = byId.get(productId);
      if (product === undefined) this.error(`unknown canonical Pages VFS product ${productId}`);
      return `export default ${JSON.stringify(`${resolvedBase}${product.path}`)};\n`;
    },
  };
}

export function buildFinalPagesSite(
  options: BuildFinalPagesSiteOptions,
): PagesSiteMetadataV1 {
  const sourceRoot = exactDirectory(options.sourceRoot, "Pages source root");
  const outputRoot = exactAbsentAbsolutePath(options.outputRoot, "final Pages site root");
  const productMapPath = exactAbsoluteFile(
    options.productMapPath,
    "private Pages product map",
    MAX_MAP_BYTES,
  );
  const map = loadCanonicalPagesProductMap({ mapPath: productMapPath, sourceRoot });
  const authority = mapAuthorities.get(map)!;
  const execute = options.execute ?? executeBuildCommand;
  mkdirSync(dirname(outputRoot), { recursive: true, mode: 0o700 });
  const buildRoot = mkdtempSync(join(dirname(outputRoot), ".kandelo-pages-site-build-"));
  const home = join(buildRoot, "home");
  const temporary = join(buildRoot, "tmp");
  const browserOutput = join(buildRoot, "browser");
  const documentationOutput = join(buildRoot, "documentation");
  const apiOutput = join(buildRoot, "api");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(temporary, { mode: 0o700 });
  const environment = safeBuildEnvironment(home, temporary);
  const devShell = join(sourceRoot, "scripts/dev-shell.sh");
  const childEnvironment = [
    `HOME=${home}`,
    `TMPDIR=${temporary}`,
    "NO_COLOR=1",
    "NPM_CONFIG_AUDIT=false",
    "NPM_CONFIG_FUND=false",
    "NPM_CONFIG_PROGRESS=false",
    "NPM_CONFIG_UPDATE_NOTIFIER=false",
  ];

  try {
    execute({
      arguments: [
        "env", ...childEnvironment,
        `KANDELO_PAGES_PRODUCT_MAP=${productMapPath}`,
        "VITE_BASE=/kandelo/",
        "VITE_CORS_PROXY_URL=https://wordpress-playground-cors-proxy.net/?",
        "npm", "--prefix", "apps/browser-demos", "run", "build", "--",
        "--outDir", browserOutput, "--emptyOutDir",
      ],
      command: devShell,
      environment,
      name: "browser",
      output: browserOutput,
      workingDirectory: sourceRoot,
    });
    assertExactBuildOutput(browserOutput, "browser build");
    const viteVfs = inventoryTree(browserOutput, MAX_SITE_BYTES).find(({ path }) => isVfsSpecifier(path));
    if (viteVfs !== undefined) {
      throw new Error(`Vite output contains VFS artifact ${viteVfs.path}`);
    }

    execute({
      arguments: [
        "env", ...childEnvironment,
        "VITEPRESS_BASE=/kandelo/guide/",
        "npx", "vitepress", "build", "docs-site", "--outDir", documentationOutput,
      ],
      command: devShell,
      environment,
      name: "documentation",
      output: documentationOutput,
      workingDirectory: sourceRoot,
    });
    assertExactBuildOutput(documentationOutput, "documentation build");

    execute({
      arguments: [
        "env", ...childEnvironment,
        "bash", "-euo", "pipefail", "-c",
        'host/node_modules/.bin/tsc --noEmit -p host/tsconfig.docs.json && host/node_modules/.bin/typedoc --options host/typedoc.json --out "$1"',
        "--", apiOutput,
      ],
      command: devShell,
      environment,
      name: "api",
      output: apiOutput,
      workingDirectory: sourceRoot,
    });
    assertExactBuildOutput(apiOutput, "API build");

    mkdirSync(outputRoot, { mode: 0o755 });
    copyTreeWithoutLinks(browserOutput, outputRoot);
    copyTreeWithoutLinks(documentationOutput, join(outputRoot, "guide"));
    copyTreeWithoutLinks(apiOutput, join(outputRoot, "api"));
    for (const entry of map.products) {
      const body = readFileSync(entry.private_path);
      if (body.byteLength !== entry.bytes || sha256(body) !== entry.sha256) {
        throw new Error(`private product ${entry.id} changed during final site assembly`);
      }
      writeExactSiteFile(outputRoot, entry.path, body);
    }
    for (const file of options.additionalFiles ?? []) {
      if (
        file.body.byteLength !== file.bytes || sha256(file.body) !== file.sha256 ||
        isVfsSpecifier(file.path)
      ) {
        throw new Error(`additional Pages file ${file.path} differs from its non-VFS identity`);
      }
      writeExactSiteFile(outputRoot, file.path, file.body);
    }
    const files = inventoryTree(outputRoot, MAX_SITE_BYTES);
    const expectedVfs = new Map(map.products.map((entry) => [entry.path, entry]));
    const actualVfs = files.filter(({ path }) => isVfsSpecifier(path));
    if (
      actualVfs.length !== map.products.length ||
      actualVfs.some((file) => {
        const expected = expectedVfs.get(file.path);
        return expected === undefined || expected.bytes !== file.bytes || expected.sha256 !== file.sha256;
      })
    ) {
      throw new Error("final Pages site differs from the exact seven canonical VFS paths");
    }
    const identity = (path: string, label: string): PagesFileIdentityV1 => {
      const value = files.find((file) => file.path === path);
      if (value === undefined) throw new Error(`final Pages site lacks ${label}`);
      return value;
    };
    return {
      api: identity("api/index.html", "API entry point"),
      browser: identity("index.html", "browser entry point"),
      documentation: identity("guide/index.html", "documentation entry point"),
      files,
      kind: "kandelo-pages-site-metadata",
      products: structuredClone(authority.gallery),
      schema: 1,
    };
  } catch (error) {
    rmSync(outputRoot, { force: true, recursive: true });
    throw error;
  } finally {
    rmSync(buildRoot, { force: true, recursive: true });
  }
}

function canonicalProductForSpecifier(
  source: string,
  importer: string | undefined,
  mirrorRoots: readonly string[],
  authority: CanonicalMapAuthority,
): string | undefined {
  if (source === "@rootfs-vfs") return "platform-rootfs";
  const binary = /^@binaries\/programs\/([^/]+)\/([^/]+)$/u.exec(source);
  if (binary !== null) return productForLegacyPath(binary[1]!, binary[2]!, authority);
  if (source.startsWith("@")) return undefined;
  const importerPath = importer?.split("?", 1)[0];
  const candidatePath = source.startsWith("/")
    ? resolve(source)
    : importerPath === undefined || !importerPath.startsWith("/")
    ? undefined
    : resolve(dirname(importerPath), source);
  if (candidatePath === undefined) return undefined;
  const candidate = canonicalizeFromExistingAncestor(candidatePath);
  for (const root of mirrorRoots) {
    if (!pathIsWithin(root, candidate)) continue;
    const relPath = relative(root, candidate).split(sep).join("/");
    const match = /^programs\/([^/]+)\/([^/]+)$/u.exec(relPath);
    if (match !== null) return productForLegacyPath(match[1]!, match[2]!, authority);
  }
  return undefined;
}

function productForLegacyPath(
  architecture: string,
  filename: string,
  authority: CanonicalMapAuthority,
): string | undefined {
  const id = authority.productByLegacyFilename.get(filename);
  if (id === undefined) return undefined;
  return authority.productById.get(id)?.architecture === architecture ? id : undefined;
}

function repositoryAuthorityPaths(sourceRoot: string) {
  const catalogPath = join(sourceRoot, "images/vfs/products/generated/catalog.json");
  const registryPath = join(
    sourceRoot,
    "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml",
  );
  const generatedRegistryPath = join(
    sourceRoot,
    "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
  );
  const galleryPath = join(
    sourceRoot,
    "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json",
  );
  const adapterPath = join(sourceRoot, "abi/staging/legacy-vfs-adapters.toml");
  return {
    adapterPath,
    catalogPath,
    galleryPath,
    generatedRegistryPath,
    registryPath,
    check: {
      adapterPath,
      browserDepsPath: join(sourceRoot, "run.sh"),
      browserSources: [
        join(sourceRoot, "host/src/browser-kernel-default-artifacts.ts"),
        join(sourceRoot, "apps/browser-demos/vite.config.ts"),
        join(sourceRoot, "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts"),
        join(sourceRoot, "apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts"),
      ],
      catalogPath,
      galleryPath,
      generatedRegistryPath,
      liveSetupPath: join(
        sourceRoot,
        "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts",
      ),
      presentationPath: join(sourceRoot, "apps/browser-demos/pages/kandelo/presets.ts"),
      registryPath,
    },
  };
}

function executeBuildCommand(request: PagesSiteBuildCommand): void {
  const result = spawnSync(request.command, request.arguments, {
    cwd: request.workingDirectory,
    encoding: "utf8",
    env: request.environment,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(
      `${request.name} Pages build failed: ${String(result.stderr).slice(0, 8192)}`,
    );
  }
}

function safeBuildEnvironment(home: string, temporary: string): Record<string, string> {
  const result: Record<string, string> = { HOME: home, TMPDIR: temporary };
  for (const name of [
    "KANDELO_NIX_BIN", "LANG", "LC_ALL", "LC_CTYPE", "NIX_SSL_CERT_FILE",
    "PATH", "SSL_CERT_FILE", "TERM", "TZ",
  ]) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function assertExactBuildOutput(path: string, label: string): void {
  exactDirectory(path, label);
  inventoryTree(path, MAX_SITE_BYTES);
}

function copyTreeWithoutLinks(source: string, destination: string, depth = 0): void {
  if (depth > 64) throw new Error("Pages build tree exceeds its depth bound");
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const metadata = lstatSync(from);
    if (metadata.isSymbolicLink()) throw new Error(`Pages build contains a symbolic link: ${from}`);
    if (metadata.isDirectory()) {
      copyTreeWithoutLinks(from, to, depth + 1);
    } else if (metadata.isFile() && metadata.nlink === 1) {
      if (existsSync(to)) throw new Error(`Pages build output path conflicts: ${to}`);
      writeFileSync(to, readFileSync(from), { flag: "wx", mode: 0o644 });
    } else {
      throw new Error(`Pages build contains a non-regular entry: ${from}`);
    }
  }
}

function writeExactSiteFile(root: string, relativePath: string, body: Uint8Array): void {
  if (!isRepositoryPath(relativePath)) throw new Error("canonical Pages product path is invalid");
  const path = join(root, relativePath);
  if (existsSync(path)) throw new Error(`canonical Pages product path already exists: ${relativePath}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, body, { flag: "wx", mode: 0o644 });
}

function inventoryTree(root: string, maximumBytes: number): PagesFileIdentityV1[] {
  const result: PagesFileIdentityV1[] = [];
  let total = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > 64) throw new Error("Pages site exceeds its depth bound");
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      ordinal(a.name, b.name))) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error(`Pages site contains a symbolic link: ${path}`);
      if (metadata.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (
        !metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1 ||
        result.length >= MAX_SITE_FILES || total + metadata.size > maximumBytes
      ) throw new Error("Pages site exceeds its file or byte bound");
      const body = readFileSync(path);
      if (body.byteLength !== metadata.size) throw new Error("Pages site changed during inventory");
      total += body.byteLength;
      result.push({
        bytes: body.byteLength,
        path: relative(root, path).split(sep).join("/"),
        sha256: sha256(body),
      });
    }
  };
  visit(root, 0);
  return result.sort((left, right) => ordinal(left.path, right.path));
}

function exactAbsoluteFile(
  value: string,
  label: string,
  maximumBytes: number,
  expectedBytes?: number,
): string {
  if (typeof value !== "string" || resolve(value) !== value) {
    throw new Error(`${label} must be an absolute path`);
  }
  const metadata = lstatSync(value);
  if (
    metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 ||
    metadata.size < 1 || metadata.size > maximumBytes ||
    (expectedBytes !== undefined && metadata.size !== expectedBytes)
  ) throw new Error(`${label} is not one bounded regular file`);
  return value;
}

function exactDirectory(value: string, label: string): string {
  if (typeof value !== "string" || resolve(value) !== value) {
    throw new Error(`${label} must be an absolute path`);
  }
  const metadata = lstatSync(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a direct directory`);
  }
  return value;
}

function exactAbsentAbsolutePath(value: string, label: string): string {
  if (typeof value !== "string" || resolve(value) !== value || existsSync(value)) {
    throw new Error(`${label} must be an absent absolute path`);
  }
  return value;
}

function canonicalProductPath(id: string, digest: string, abi: number): string {
  return `products/${id}/sha256-${digest}/${id}-${abi}.vfs.zst`;
}

function canonicalBase(value: string): string {
  if (
    !value.startsWith("/") || !value.endsWith("/") || value.includes("\\") ||
    value.includes("//") || value.split("/").includes("..") || value.includes("?") ||
    value.includes("#")
  ) throw new Error(`canonical Pages Vite base is invalid: ${value}`);
  return value;
}

function pathIsWithin(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function canonicalizeFromExistingAncestor(value: string): string {
  const suffix: string[] = [];
  let existing = resolve(value);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(value);
    suffix.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function isRepositoryPath(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !value.startsWith("/") &&
    !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function exactKeys(value: unknown, expected: readonly string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!jsonEqual(actual, wanted)) {
    throw new Error(`${label} fields differ: expected ${wanted.join(", ")}, got ${actual.join(", ")}`);
  }
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate).sort(([left], [right]) =>
        ordinal(left, right)).map(([key, child]) => [key, normalize(child)]));
    }
    if (typeof candidate === "number" && !Number.isSafeInteger(candidate)) {
      throw new Error("canonical JSON permits safe integers only");
    }
    return candidate;
  };
  return `${JSON.stringify(normalize(value))}\n`;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
