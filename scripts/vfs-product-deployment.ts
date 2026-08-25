import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Plugin, ResolvedConfig } from "vite";

import { ABI_VERSION } from "../host/src/generated/abi.ts";
import { normalizeDeploymentBase } from "../web-libs/kandelo-session/src/deployment-scope.ts";
import {
  validateVfsAssetGroupManifest,
  validateVfsAssetGroupRelativePath,
} from "../web-libs/kandelo-session/src/vfs-asset-group.ts";
import { loadVfsProductCatalog } from "./vfs-product-catalog.mjs";
import {
  checkPagesVfsProductRegistry,
  isVfsSpecifier,
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
const SOURCE_ONLY_VIRTUAL_ASSET = "virtual:kandelo-source-only-asset:";
const VFS_LAZY_CACHE_VERSION_PLACEHOLDER =
  "__KANDELO_VFS_LAZY_CACHE_VERSION__";
const VFS_LAZY_CACHE_VERSION_SOURCE =
  `null /*${VFS_LAZY_CACHE_VERSION_PLACEHOLDER}*/`;

export interface PagesFileIdentityV1 {
  bytes: number;
  path: string;
  sha256: string;
}

export interface VfsProductDeploymentMapEntryV1 {
  asset_group?: PagesFileIdentityV1;
  bytes: number;
  id: string;
  load: "eager" | "lazy";
  path: string;
  private_path: string;
  sha256: string;
}

export interface VfsProductDeploymentMapV1 {
  kind: "kandelo-pages-private-product-map";
  products: VfsProductDeploymentMapEntryV1[];
  schema: 1;
}

interface CanonicalMapAuthority {
  gallery: Array<{ gallery_entries: string[]; id: string; vfs_image: string }>;
  productByLegacyFilename: Map<string, string>;
  productById: Map<string, { architecture: string }>;
}

interface CatalogProductProjection {
  architecture: string;
  output: string;
}

const mapAuthorities = new WeakMap<VfsProductDeploymentMapV1, CanonicalMapAuthority>();

export function loadVfsProductDeploymentMap(options: {
  mapPath: string;
  sourceRoot: string;
}): VfsProductDeploymentMapV1 {
  const sourceRoot = exactDirectory(options.sourceRoot, "VFS product deployment source root");
  const mapPath = exactAbsoluteFile(
    options.mapPath,
    "private VFS product deployment map",
    MAX_MAP_BYTES,
  );
  const paths = repositoryAuthorityPaths(sourceRoot);
  checkPagesVfsProductRegistry(paths.check);
  const catalog = loadVfsProductCatalog(paths.catalogPath);
  const sourceRegistry = readPagesRegistry(paths.registryPath);
  const generatedRegistry = readGeneratedPagesRegistry(paths.generatedRegistryPath);
  if (!jsonEqual(sourceRegistry, generatedRegistry)) {
    throw new Error("source and generated VFS product deployment registries differ");
  }
  const gallery = readPagesGallery(paths.galleryPath, generatedRegistry.products);

  const bytes = readFileSync(mapPath);
  const value = JSON.parse(bytes.toString("utf8"));
  if (!bytes.equals(Buffer.from(canonicalJson(value)))) {
    throw new Error("private VFS product deployment map is not canonical JSON");
  }
  exactKeys(value, ["kind", "products", "schema"], "private VFS product deployment map");
  if (value.schema !== 1 || value.kind !== PRIVATE_MAP_KIND || !Array.isArray(value.products)) {
    throw new Error("private VFS product deployment map has unsupported identity");
  }
  const expected = generatedRegistry.products;
  if (value.products.length !== expected.length) {
    throw new Error("private VFS product deployment map differs from the exact product set");
  }
  const products = value.products.map((candidate: unknown, index: number) => {
    const declaresAssetGroup = candidate !== null &&
      typeof candidate === "object" && !Array.isArray(candidate) &&
      Object.hasOwn(candidate, "asset_group");
    exactKeys(
      candidate,
      [
        ...(declaresAssetGroup ? ["asset_group"] : []),
        "bytes", "id", "load", "path", "private_path", "sha256",
      ],
      `private VFS product deployment product ${index}`,
    );
    const entry = candidate as VfsProductDeploymentMapEntryV1;
    if (!STABLE_ID.test(entry.id) || (entry.load !== "eager" && entry.load !== "lazy")) {
      throw new Error(`private VFS product deployment product ${index} has an invalid identity`);
    }
    if (index > 0 && value.products[index - 1].id >= entry.id) {
      throw new Error("private VFS product deployment products are not sorted and unique");
    }
    const wanted = expected[index];
    if (wanted?.id !== entry.id) {
      throw new Error("private VFS product deployment map differs from the exact product set");
    }
    if (wanted.load !== entry.load) {
      throw new Error(
        `private VFS product deployment product ${entry.id} load differs from the registry`,
      );
    }
    catalog.productById(entry.id);
    if (
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_PRODUCT_BYTES ||
      !SHA256.test(entry.sha256)
    ) {
      throw new Error(`private VFS product deployment product ${entry.id} has an invalid byte identity`);
    }
    let assetGroup: Readonly<PagesFileIdentityV1> | undefined;
    if (entry.asset_group !== undefined) {
      exactKeys(
        entry.asset_group,
        ["bytes", "path", "sha256"],
        `private VFS product deployment product ${entry.id} asset group`,
      );
      let assetGroupPath: string;
      try {
        assetGroupPath = validateVfsAssetGroupRelativePath(entry.asset_group.path);
      } catch {
        throw new Error(
          `private VFS product deployment product ${entry.id} has an invalid asset group identity`,
        );
      }
      if (!Number.isSafeInteger(entry.asset_group.bytes) || entry.asset_group.bytes < 1 ||
          !SHA256.test(entry.asset_group.sha256)) {
        throw new Error(
          `private VFS product deployment product ${entry.id} has an invalid asset group identity`,
        );
      }
      assetGroup = Object.freeze({ ...entry.asset_group, path: assetGroupPath });
    }
    const expectedPath = vfsProductDeploymentPath(entry.id, entry.sha256, ABI_VERSION);
    if (entry.path !== expectedPath || entry.path.includes("-candidates/")) {
      throw new Error(
        `private VFS product deployment product ${entry.id} lacks its current-ABI canonical product path`,
      );
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
    return Object.freeze({
      ...entry,
      ...(assetGroup === undefined ? {} : { asset_group: assetGroup }),
      private_path: privatePath,
    });
  });
  const assetGroupCount = products.filter((entry) =>
    entry.asset_group !== undefined).length;
  if (assetGroupCount !== 0 && assetGroupCount !== products.length) {
    throw new Error(
      "private VFS product deployment products must all declare an asset group or all omit it",
    );
  }
  const assetGroup = products[0]?.asset_group;
  if (assetGroup !== undefined &&
      products.some((entry) => !jsonEqual(entry.asset_group, assetGroup))) {
    throw new Error("private VFS product deployment products must share one asset group identity");
  }

  const productByLegacyFilename = new Map<string, string>();
  const productById = new Map<string, { architecture: string }>();
  for (const entry of products) {
    const product = catalog.productById(entry.id) as CatalogProductProjection;
    for (const filename of new Set([product.output])) {
      const prior = productByLegacyFilename.get(filename);
      if (prior !== undefined && prior !== entry.id) {
        throw new Error(
          `VFS product output ${filename} maps to multiple VFS product deployments`,
        );
      }
      productByLegacyFilename.set(filename, entry.id);
    }
    productById.set(entry.id, { architecture: product.architecture });
  }
  const loaded: VfsProductDeploymentMapV1 = Object.freeze({
    kind: PRIVATE_MAP_KIND,
    products: Object.freeze(products) as unknown as VfsProductDeploymentMapEntryV1[],
    schema: 1,
  });
  mapAuthorities.set(loaded, {
    gallery: structuredClone(gallery.products),
    productById,
    productByLegacyFilename,
  });
  return loaded;
}

export function createVfsProductDeploymentPlugin(options: {
  assetGroupDirectory?: string;
  base: string;
  map: VfsProductDeploymentMapV1 | null;
  mirrorRoots: readonly string[];
}): Plugin {
  const base = normalizeDeploymentBase(options.base);
  const authority = options.map === null ? undefined : mapAuthorities.get(options.map);
  if (options.map !== null && authority === undefined) {
    throw new Error("VFS product deployment plugin requires a validated private product map");
  }
  const declaresAssetGroup = options.map?.products[0]?.asset_group !== undefined;
  if (options.assetGroupDirectory !== undefined && !declaresAssetGroup) {
    throw new Error(
      "VFS product deployment asset group requires a grouped private product map",
    );
  }
  if (declaresAssetGroup && options.assetGroupDirectory === undefined) {
    throw new Error(
      "grouped private VFS product deployment map requires an asset-group directory",
    );
  }
  const assetGroupDirectory =
    options.assetGroupDirectory === undefined
      ? undefined
      : exactDirectory(
          options.assetGroupDirectory,
          "VFS product deployment asset group directory",
        );
  if (assetGroupDirectory !== undefined) {
    validateCanonicalPagesAssetGroup(options.map!, assetGroupDirectory);
  }
  const mirrorRoots = options.mirrorRoots.map(canonicalizeFromExistingAncestor);
  const publicProducts = options.map?.products.map(
    ({ private_path: _privatePath, asset_group, ...entry }) => ({
      ...entry,
      ...(asset_group === undefined
        ? {}
        : { asset_group: { ...asset_group, path: `${base}${asset_group.path}` } }),
      path: `${base}${entry.path}`,
    })) ?? null;
  const byId = new Map(options.map?.products.map((entry) => [entry.id, entry]) ?? []);
  let resolvedBase = base;
  let outputRoot: string | undefined;

  return {
    name: "vfs-product-deployment",
    enforce: "pre",
    configResolved(config: ResolvedConfig) {
      resolvedBase = normalizeDeploymentBase(config.base);
      if (resolvedBase !== base) {
        throw new Error(`VFS product deployment base changed from ${base} to ${resolvedBase}`);
      }
      outputRoot = resolve(config.root, config.build.outDir);
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
          `unknown VFS product deployment request: ${source} from ${importer ?? "<entry>"}; ` +
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
      if (product === undefined) this.error(`unknown VFS product deployment product ${productId}`);
      return `export default ${JSON.stringify(`${resolvedBase}${product.path}`)};\n`;
    },
    writeBundle: {
      order: "post",
      handler() {
        if (assetGroupDirectory === undefined) return;
        if (outputRoot === undefined) {
          throw new Error(
            "VFS product deployment output directory was not resolved",
          );
        }
        copyCanonicalPagesAssetGroup(
          options.map!,
          assetGroupDirectory,
          outputRoot,
          false,
        );
        injectGroupedLazyCacheVersion(options.map!, outputRoot);
      },
    },
  };
}

interface ValidatedCanonicalPagesAssetGroup {
  destinationDirectory: string;
  sourceInventory: PagesFileIdentityV1[];
  vfs: Map<string, PagesFileIdentityV1>;
}

function validateCanonicalPagesAssetGroup(
  map: VfsProductDeploymentMapV1,
  assetGroupDirectory: string,
): ValidatedCanonicalPagesAssetGroup {
  if (mapAuthorities.get(map) === undefined) {
    throw new Error(
      "VFS product deployment asset group requires a validated private product map",
    );
  }
  const identity = map.products[0]!.asset_group!;
  const sourceManifest = readFileSync(
    join(assetGroupDirectory, basename(identity.path)),
  );
  if (
    sourceManifest.byteLength !== identity.bytes ||
    sha256(sourceManifest) !== identity.sha256
  ) {
    throw new Error(
      "VFS product deployment asset group directory differs from its authenticated manifest identity",
    );
  }
  let manifest: ReturnType<typeof validateVfsAssetGroupManifest>;
  try {
    manifest = validateVfsAssetGroupManifest(
      JSON.parse(sourceManifest.toString("utf8")),
    );
  } catch (error) {
    throw new Error(`VFS product deployment asset group manifest is invalid: ${String(error)}`);
  }
  if (manifest.products.length !== map.products.length) {
    throw new Error("VFS product deployment asset group differs from the exact product set");
  }
  const sourceFiles = new Map<string, PagesFileIdentityV1>();
  const addSourceFile = (path: string, file: PagesFileIdentityV1): void => {
    if (sourceFiles.has(path)) {
      throw new Error(
        "VFS product deployment asset group manifest repeats its source inventory path",
      );
    }
    sourceFiles.set(path, { ...file, path });
  };
  addSourceFile(basename(identity.path), {
    bytes: identity.bytes,
    path: basename(identity.path),
    sha256: identity.sha256,
  });
  const vfs = new Map(
    manifest.products.map((product) => {
      const mapProduct = map.products.find((entry) => entry.id === product.id);
      if (
        mapProduct === undefined ||
        product.image.bytes !== mapProduct.bytes ||
        product.image.sha256 !== mapProduct.sha256
      ) {
        throw new Error(
          `VFS product deployment asset group image ${product.id} differs from its product identity`,
        );
      }
      addSourceFile(product.image.path, product.image);
      const path = join(dirname(identity.path), product.image.path)
        .split(sep)
        .join("/");
      return [
        path,
        { bytes: product.image.bytes, path, sha256: product.image.sha256 },
      ];
    }),
  );
  for (const asset of manifest.assets) {
    if (isVfsSpecifier(asset.path)) {
      throw new Error("VFS product deployment asset group manifest may not declare VFS assets");
    }
    addSourceFile(asset.path, asset);
  }
  const sourceInventory = inventoryTree(assetGroupDirectory, MAX_SITE_BYTES);
  if (
    sourceInventory.length !== sourceFiles.size ||
    sourceInventory.some((file) => {
      const expected = sourceFiles.get(file.path);
      return (
        expected === undefined ||
        expected.bytes !== file.bytes ||
        expected.sha256 !== file.sha256
      );
    })
  ) {
    throw new Error(
      "VFS product deployment asset group directory inventory differs from its manifest",
    );
  }
  return {
    destinationDirectory: dirname(identity.path),
    sourceInventory,
    vfs,
  };
}

function copyCanonicalPagesAssetGroup(
  map: VfsProductDeploymentMapV1,
  assetGroupDirectory: string,
  outputRoot: string,
  allowIdenticalExisting: boolean,
): Map<string, PagesFileIdentityV1> {
  const validated = validateCanonicalPagesAssetGroup(
    map,
    exactDirectory(assetGroupDirectory, "VFS product deployment asset group directory"),
  );
  const canonicalOutput = exactDirectory(outputRoot, "Vite output directory");
  const destination = resolve(canonicalOutput, validated.destinationDirectory);
  if (
    destination !== canonicalOutput &&
    !pathIsWithin(canonicalOutput, destination)
  ) {
    throw new Error(
      "VFS product deployment asset group destination escapes the Vite output directory",
    );
  }
  if (existsSync(destination)) {
    if (!allowIdenticalExisting) {
      throw new Error(`VFS product deployment build output path conflicts: ${destination}`);
    }
    const existing = inventoryTree(destination, MAX_SITE_BYTES);
    if (!jsonEqual(existing, validated.sourceInventory)) {
      throw new Error(
        "Vite output asset group differs from its authenticated source",
      );
    }
  } else {
    copyTreeWithoutLinks(assetGroupDirectory, destination);
  }
  validateCopiedAssetGroup(destination, validated.sourceInventory);
  const copiedManifest = readFileSync(
    join(canonicalOutput, map.products[0]!.asset_group!.path),
  );
  const identity = map.products[0]!.asset_group!;
  if (
    copiedManifest.byteLength !== identity.bytes ||
    sha256(copiedManifest) !== identity.sha256
  ) {
    throw new Error(
      "VFS product deployment asset group directory differs from its authenticated manifest identity",
    );
  }
  return validated.vfs;
}

function injectGroupedLazyCacheVersion(
  map: VfsProductDeploymentMapV1,
  outputRoot: string,
): void {
  const version = map.products[0]!.asset_group!.sha256;
  const workerPath = join(outputRoot, "service-worker.js");
  const source = readFileSync(workerPath, "utf8");
  const marker = VFS_LAZY_CACHE_VERSION_SOURCE;
  const matches = source.split(marker).length - 1;
  if (matches !== 1) {
    throw new Error(
      "VFS product deployment grouped build service worker lacks one lazy-cache version marker",
    );
  }
  writeFileSync(workerPath, source.replace(marker, JSON.stringify(version)));
}

function validateCopiedAssetGroup(
  destination: string,
  expected: readonly PagesFileIdentityV1[],
): void {
  const copied = inventoryTree(destination, MAX_SITE_BYTES);
  if (!jsonEqual(copied, expected)) {
    throw new Error(
      "copied asset group inventory differs from its authenticated source",
    );
  }
}

function canonicalProductForSpecifier(
  source: string,
  importer: string | undefined,
  mirrorRoots: readonly string[],
  authority: CanonicalMapAuthority,
): string | undefined {
  if (source === "@rootfs-vfs") return "platform-rootfs";
  if (source.startsWith(SOURCE_ONLY_VIRTUAL_ASSET)) {
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(
        source.slice(SOURCE_ONLY_VIRTUAL_ASSET.length),
      );
    } catch {
      return undefined;
    }
    const virtualProduct = /^programs\/([^/]+)\/([^/]+)$/u.exec(relativePath);
    if (virtualProduct !== null) {
      return productForLegacyPath(
        virtualProduct[1]!,
        virtualProduct[2]!,
        authority,
      );
    }
    return undefined;
  }
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
  return {
    catalogPath,
    galleryPath,
    generatedRegistryPath,
    registryPath,
    check: {
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

function inventoryTree(root: string, maximumBytes: number): PagesFileIdentityV1[] {
  const result: PagesFileIdentityV1[] = [];
  let total = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > 64) throw new Error("VFS product deployment tree exceeds its depth bound");
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      ordinal(a.name, b.name))) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`VFS product deployment tree contains a symbolic link: ${path}`);
      }
      if (metadata.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (
        !metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1 ||
        result.length >= MAX_SITE_FILES || total + metadata.size > maximumBytes
      ) throw new Error("VFS product deployment tree exceeds its file or byte bound");
      const body = readFileSync(path);
      if (body.byteLength !== metadata.size) {
        throw new Error("VFS product deployment tree changed during inventory");
      }
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

function copyTreeWithoutLinks(source: string, destination: string, depth = 0): void {
  if (depth > 64) throw new Error("VFS product deployment tree exceeds its depth bound");
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const metadata = lstatSync(from);
    if (metadata.isSymbolicLink()) {
      throw new Error(`VFS product deployment tree contains a symbolic link: ${from}`);
    }
    if (metadata.isDirectory()) {
      copyTreeWithoutLinks(from, to, depth + 1);
    } else if (metadata.isFile() && metadata.nlink === 1) {
      if (existsSync(to)) throw new Error(`VFS product deployment output path conflicts: ${to}`);
      writeFileSync(to, readFileSync(from), { flag: "wx", mode: 0o644 });
    } else {
      throw new Error(`VFS product deployment tree contains a non-regular entry: ${from}`);
    }
  }
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

export function vfsProductDeploymentPath(
  id: string,
  digest: string,
  abi: number,
): string {
  return `products/${id}/sha256-${digest}/${id}-${abi}.vfs.zst`;
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
