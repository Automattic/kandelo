/**
 * Does the supported package graph supply every binary something needs?
 *
 * "Something" is every place that names a package output by path and expects
 * its bytes at runtime:
 *   - the browser app's static `@binaries` imports (and relative imports into
 *     a binary mirror), as apps/browser-demos/browser-binary-imports.mjs
 *     finds them;
 *   - every lazy file and lazy archive the rootfs and shell images record
 *     (scripts/browser-lazy-asset-tables.ts).
 *
 * Each path must be an output of a package in packages/sets/local-supported.toml,
 * because that set is exactly what `./run.sh setup` and `./run.sh local-build`
 * build. A path nothing in the set produces used to surface as a skipped
 * Playwright spec or a runtime 404; this makes it a build failure instead.
 *
 * With `--published <dir>`, check only that each path, plus the artifacts the
 * browser loads through virtual modules (kernel, rootfs, image writer), is a
 * regular file in that SourceOnly output root. The local-build engine runs the
 * graph check before a whole-tree build starts and the published check after
 * it publishes, so setup cannot succeed while leaving a needed binary
 * unpublished (for example, a projection built from an older checkout).
 *
 * Usage (repo root, inside scripts/dev-shell.sh):
 *   node node_modules/tsx/dist/cli.mjs scripts/check-browser-binary-supply.ts [--published <dir>]
 */
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserBinariesImports,
  localOnlyBrowserImports,
  packageOutputOwners,
} from "./browser-binary-package-roots.mjs";
import { lazyAssetTables } from "./browser-lazy-asset-tables";
import { readLocalSupportedSet } from "./local-supported-set.mjs";
import { browserVirtualModuleCapabilities } from "../apps/browser-demos/browser-module-contract.mjs";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface BinaryDemand {
  /** Package-mirror path, e.g. `programs/wasm32/tmux.wasm`. */
  binary: string;
  /** Every consumer that names it. */
  consumers: string[];
}

/** Every binary a supported deployment needs, with who needs it. */
export function browserBinaryDemands(repoRoot = defaultRepoRoot): BinaryDemand[] {
  const demands = new Map<string, Set<string>>();
  const add = (binary: string, consumer: string) => {
    if (localOnlyBrowserImports.has(binary)) return;
    let consumers = demands.get(binary);
    if (consumers === undefined) {
      consumers = new Set();
      demands.set(binary, consumers);
    }
    consumers.add(consumer);
  };
  // Optional gallery globs are excluded: those artifacts are the app's
  // documented optional boundary, and Vite yields an empty map without them.
  for (const binary of browserBinariesImports(repoRoot, { includeOptionalGlobs: false })) {
    add(binary, "browser @binaries import");
  }
  const tables = lazyAssetTables(repoRoot);
  for (const entry of [...tables.rootfs, ...tables.shell, ...tables.archives]) {
    add(entry.binary, entry.declaredBy);
  }
  return [...demands]
    .map(([binary, consumers]) => ({ binary, consumers: [...consumers].sort() }))
    .sort((left, right) => left.binary.localeCompare(right.binary));
}

/** The packages the supported set builds (see readLocalSupportedSet). */
export function supportedPackageNames(repoRoot = defaultRepoRoot): Set<string> {
  return readLocalSupportedSet(
    readFileSync(join(repoRoot, "packages/sets/local-supported.toml"), "utf8"),
  ).builtPackages;
}

/**
 * Where the SourceOnly projection publishes the artifact behind each browser
 * virtual module (apps/browser-demos/browser-module-contract.mjs). `null`
 * marks a module with no single artifact: the product catalog names each
 * product's image, and those images are package outputs the graph builds.
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
  demands = browserBinaryDemands(repoRoot),
): string[] {
  return classifyUnsupplied(
    demands,
    packageOutputOwners(repoRoot) as Map<string, { packageName: string }>,
    supportedPackageNames(repoRoot),
  );
}

/** Demands that are not a regular file under `outputRoot`. */
export function unpublishedBinaryDemands(
  outputRoot: string,
  demands: readonly BinaryDemand[],
): string[] {
  const problems: string[] = [];
  for (const { binary, consumers } of demands) {
    let isFile = false;
    try {
      isFile = lstatSync(join(outputRoot, binary)).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      problems.push(`${binary}: not published (needed by ${consumers.join("; ")})`);
    }
  }
  return problems;
}

function main(argv: string[]): number {
  let published: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--published" && argv[index + 1] !== undefined) {
      published = resolve(argv[index + 1]!);
      index += 1;
    } else {
      process.stderr.write(
        "usage: check-browser-binary-supply.ts [--published <source-only output root>]\n",
      );
      return 2;
    }
  }
  const demands = browserBinaryDemands();
  if (published === undefined) {
    const unsupplied = unsuppliedBinaryDemands(defaultRepoRoot, demands);
    if (unsupplied.length === 0) return 0;
    process.stderr.write(
      "Binaries the browser app or a VFS image needs that no supported package produces:\n" +
        unsupplied.map((line) => `  ${line}\n`).join("") +
        "Add the producing package to packages/sets/local-supported.toml, or remove the consumer.\n",
    );
    return 1;
  }
  const unpublished = unpublishedBinaryDemands(published, [
    ...demands,
    ...virtualModuleDemands(),
  ]);
  if (unpublished.length === 0) return 0;
  process.stderr.write(
    `Binaries the browser app or a VFS image needs that ${published} does not contain:\n` +
      unpublished.map((line) => `  ${line}\n`).join("") +
      "The supported build did not publish them. Rebuild with ./run.sh local-build.\n",
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
