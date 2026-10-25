/**
 * Does the supported build supply every binary something needs?
 *
 * Two kinds of consumer name package outputs and expect their bytes at
 * runtime:
 *   - VFS images record lazy files and lazy archives. What an image needs is
 *     declared before it is built, as the image package's dependency closure,
 *     which the local-build planner already enforces; after the build, the
 *     image itself lists exactly what it references.
 *   - The browser app imports some outputs directly (`@binaries/...`, or a
 *     relative import into a binary mirror), as
 *     apps/browser-demos/browser-binary-imports.mjs finds them. Nothing else
 *     declares those, so they are checked here.
 *
 * Modes (repo root, inside scripts/dev-shell.sh):
 *   node node_modules/tsx/dist/cli.mjs scripts/check-browser-binary-supply.ts
 *       Each browser import must be an output of a package the supported set
 *       builds. On success, print `name/arch` for the package owning each
 *       browser import: a default build seeds its selection with these
 *       beside the products. The local-build engine runs this once, before
 *       a whole-tree build.
 *   ... --published <dir>
 *       After a build: each browser import, the artifacts behind the
 *       browser's virtual modules (kernel, rootfs, image writer), and every
 *       lazy body each active product's published image references must be a
 *       regular file of the declared size in <dir>.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserBinariesImports,
  localOnlyBrowserImports,
  packageOutputOwners,
} from "./browser-binary-package-roots.mjs";
import { readLocalSupportedSet } from "./local-supported-set.mjs";
import { loadVfsProductCatalog } from "./vfs-product-catalog.mjs";
import { imageLazyReferences, type ImageLazyReference } from "./vfs-image-lazy-references.ts";
import { normalizeImageOwnedLazyReference } from "../host/src/vfs/vfs-asset-group-reference.ts";
import { browserVirtualModuleCapabilities } from "../apps/browser-demos/browser-module-contract.mjs";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface BinaryDemand {
  /** Package-mirror path, e.g. `programs/wasm32/dash.wasm`. */
  binary: string;
  /** Every consumer that names it. */
  consumers: string[];
  /** Declared byte length, when the consumer records one. */
  bytes?: number;
}

type Owner = { packageName: string; arch: string };

/** The browser app's required binary imports. Optional gallery globs are
 *  excluded: those artifacts are the app's documented optional boundary, and
 *  Vite yields an empty map without them. */
export function browserImportDemands(repoRoot = defaultRepoRoot): BinaryDemand[] {
  return browserBinariesImports(repoRoot, { includeOptionalGlobs: false })
    .filter((binary: string) => !localOnlyBrowserImports.has(binary))
    .map((binary: string) => ({ binary, consumers: ["browser @binaries import"] }));
}

function readSupportedSet(repoRoot: string) {
  return readLocalSupportedSet(
    readFileSync(join(repoRoot, "packages/sets/local-supported.toml"), "utf8"),
  );
}

/** The packages the supported set builds (see readLocalSupportedSet). */
export function supportedPackageNames(repoRoot = defaultRepoRoot): Set<string> {
  return readSupportedSet(repoRoot).builtPackages;
}

/**
 * Demands no supported package produces, one diagnostic line each. Pure:
 * `owners` maps a mirror path to the registry package whose declared output
 * it is, and `supported` is the set of packages the supported build builds.
 */
export function classifyUnsupplied(
  demands: readonly BinaryDemand[],
  owners: ReadonlyMap<string, { packageName: string }>,
  supported: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const { binary, consumers } of demands) {
    const owner = owners.get(binary);
    const neededBy = `needed by ${consumers.join("; ")}`;
    if (owner === undefined) {
      problems.push(`${binary}: no registry package declares this output (${neededBy})`);
    } else if (!supported.has(owner.packageName)) {
      problems.push(
        `${binary}: produced by ${owner.packageName}, which packages/sets/local-supported.toml ` +
          `does not build (${neededBy})`,
      );
    }
  }
  return problems;
}

export function unsuppliedBinaryDemands(
  repoRoot = defaultRepoRoot,
  demands = browserImportDemands(repoRoot),
): string[] {
  return classifyUnsupplied(
    demands,
    packageOutputOwners(repoRoot) as Map<string, Owner>,
    supportedPackageNames(repoRoot),
  );
}

/** `name/arch` of the package owning each demand, sorted and distinct. */
export function demandedPackages(
  demands: readonly BinaryDemand[],
  owners: ReadonlyMap<string, Owner>,
): string[] {
  const nodes = new Set<string>();
  for (const { binary } of demands) {
    const owner = owners.get(binary);
    if (owner !== undefined) nodes.add(`${owner.packageName}/${owner.arch}`);
  }
  return [...nodes].sort();
}

/**
 * Where the SourceOnly projection publishes the artifact behind each browser
 * virtual module (apps/browser-demos/browser-module-contract.mjs). `null`
 * marks a module with no single artifact: the product catalog names each
 * product's image, and those images are checked as products.
 */
const VIRTUAL_MODULE_ARTIFACTS: Readonly<Record<string, string | null>> = {
  "kernel-wasm": "kernel.wasm",
  "kandelo-image-module32-wasm": "kandelo_image_module32.wasm",
  "rootfs-vfs": "programs/wasm32/rootfs.vfs.zst",
  "pages-vfs-products": null,
};

/** The published artifacts the browser loads through virtual modules. */
export function virtualModuleDemands(): BinaryDemand[] {
  const demands: BinaryDemand[] = [];
  for (const [specifier, capability] of Object.entries(browserVirtualModuleCapabilities)) {
    if (!(capability in VIRTUAL_MODULE_ARTIFACTS)) {
      throw new Error(`browser virtual module ${specifier} has no published artifact mapping`);
    }
    const binary = VIRTUAL_MODULE_ARTIFACTS[capability];
    if (binary !== null) demands.push({ binary, consumers: [`browser ${specifier} module`] });
  }
  return demands;
}

/**
 * An image's lazy references, cached by the image's SHA-256. Loading an image
 * into the image module takes seconds per product, and a whole-tree build
 * rarely changes most images, so a no-op build pays only for hashing.
 */
function cachedImageLazyReferences(
  image: Uint8Array,
  cache: Map<string, ImageLazyReference[]>,
  used: Set<string>,
): ImageLazyReference[] {
  const key = createHash("sha256").update(image).digest("hex");
  used.add(key);
  let references = cache.get(key);
  if (references === undefined) {
    references = imageLazyReferences(image);
    cache.set(key, references);
  }
  return references;
}

function readReferenceCache(cachePath: string): Map<string, ImageLazyReference[]> {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, ImageLazyReference[]>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

/** Keep only the listings this run used, so the cache tracks current images. */
function writeReferenceCache(
  cachePath: string,
  cache: Map<string, ImageLazyReference[]>,
  used: Set<string>,
): void {
  if (cache.size === used.size && [...used].every((key) => cache.has(key))) return;
  const kept = Object.fromEntries([...used].map((key) => [key, cache.get(key)!]));
  mkdirSync(dirname(cachePath), { recursive: true });
  const staged = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(staged, JSON.stringify(kept));
  renameSync(staged, cachePath);
}

/**
 * Each active product's published image, and every lazy body it references.
 * An image that is itself missing is reported as a demand on the image.
 */
export function productImageDemands(
  outputRoot: string,
  repoRoot = defaultRepoRoot,
): BinaryDemand[] {
  const catalog = loadVfsProductCatalog(
    join(repoRoot, "images/vfs/products/generated/catalog.json"),
  );
  const cachePath = join(repoRoot, "target/browser-binary-supply/image-lazy-references-v1.json");
  const cache = readReferenceCache(cachePath);
  const used = new Set<string>();
  const demands: BinaryDemand[] = [];
  for (const id of [...readSupportedSet(repoRoot).activeProducts].sort()) {
    const product = catalog.productById(id) as { architecture: string; output: string };
    const image = `programs/${product.architecture}/${product.output}`;
    demands.push({ binary: image, consumers: [`product ${id}`] });
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(outputRoot, image));
    } catch {
      continue;
    }
    for (const body of cachedImageLazyReferences(bytes, cache, used)) {
      demands.push({
        binary: normalizeImageOwnedLazyReference(body.address).slice("assets/".length),
        consumers: [`${image} ${body.kind} ${body.address}`],
        bytes: body.bytes,
      });
    }
  }
  writeReferenceCache(cachePath, cache, used);
  return demands;
}

/** One demand per binary, its consumers combined. A body two consumers
 *  size differently keeps both sizes apart, so the conflict is reported. */
export function mergeDemands(demands: readonly BinaryDemand[]): BinaryDemand[] {
  const merged = new Map<string, BinaryDemand>();
  for (const demand of demands) {
    const key = `${demand.binary}\0${demand.bytes ?? ""}`;
    const prior = merged.get(key);
    if (prior === undefined) {
      merged.set(key, { ...demand, consumers: [...demand.consumers] });
    } else {
      prior.consumers.push(...demand.consumers);
    }
  }
  return [...merged.values()];
}

/** Demands that are not a regular file (of the declared size) under `outputRoot`. */
export function unpublishedBinaryDemands(
  outputRoot: string,
  demands: readonly BinaryDemand[],
): string[] {
  const problems: string[] = [];
  for (const { binary, consumers, bytes } of demands) {
    let size: number | null = null;
    try {
      const metadata = lstatSync(join(outputRoot, binary));
      size = metadata.isFile() ? metadata.size : null;
    } catch {
      size = null;
    }
    const neededBy = `needed by ${consumers.join("; ")}`;
    if (size === null) {
      problems.push(`${binary}: not published (${neededBy})`);
    } else if (bytes !== undefined && size !== bytes) {
      problems.push(`${binary}: published with ${size} bytes, expected ${bytes} (${neededBy})`);
    }
  }
  return problems;
}

function main(argv: string[]): number {
  const usage = "usage: check-browser-binary-supply.ts [--published <dir>]\n";
  if (argv.length === 2 && argv[0] === "--published") {
    const published = resolve(argv[1]!);
    const unpublished = unpublishedBinaryDemands(published, mergeDemands([
      ...browserImportDemands(),
      ...virtualModuleDemands(),
      ...productImageDemands(published),
    ]));
    if (unpublished.length === 0) return 0;
    process.stderr.write(
      `Binaries the browser app or a VFS image needs that ${published} does not contain:\n` +
        unpublished.map((line) => `  ${line}\n`).join("") +
        "The build did not publish them. Rebuild with ./run.sh local-build.\n",
    );
    return 1;
  }
  if (argv.length !== 0) {
    process.stderr.write(usage);
    return 2;
  }
  const demands = browserImportDemands();
  const owners = packageOutputOwners(defaultRepoRoot) as Map<string, Owner>;
  const unsupplied = classifyUnsupplied(demands, owners, supportedPackageNames());
  if (unsupplied.length === 0) {
    for (const node of demandedPackages(demands, owners)) process.stdout.write(`${node}\n`);
    return 0;
  }
  process.stderr.write(
    "Binaries the browser app imports that no supported package produces:\n" +
      unsupplied.map((line) => `  ${line}\n`).join("") +
      "Add the producing package to packages/sets/local-supported.toml, or remove the import.\n",
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `check-browser-binary-supply: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
