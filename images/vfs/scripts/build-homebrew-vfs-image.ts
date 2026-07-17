/**
 * Build a precomposed Homebrew-prefix VFS image from Kandelo/Homebrew sidecars.
 *
 * Usage:
 *   npx tsx images/vfs/scripts/build-homebrew-vfs-image.ts \
 *     --metadata homebrew/homebrew-tap-core/Kandelo/metadata.json \
 *     --tap-root homebrew/homebrew-tap-core \
 *     --brewfile Brewfile \
 *     --arch wasm32 \
 *     --runtime node \
 *     --base-image target/platform-base.vfs.zst \
 *     --out target/homebrew-hello.vfs.zst \
 *     --report target/homebrew-hello.vfs-report.json
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHomebrewVfs } from "../../../host/src/homebrew-vfs-builder";
import { fetchHomebrewBottleBytes } from "../../../host/src/homebrew-vfs-fetch";
import {
  planHomebrewVfs,
  type HomebrewBottleArch,
  type HomebrewRuntime,
  type HomebrewVfsPackagePlan,
} from "../../../host/src/homebrew-vfs-planner";
import {
  MemoryFileSystem,
  type VfsImageMetadata,
} from "../../../host/src/vfs/memory-fs";
import { saveImage } from "./vfs-image-helpers";

interface CliOptions {
  metadata: string;
  tapRoot: string;
  packages: string[];
  brewfile?: string;
  arch: HomebrewBottleArch;
  runtime?: HomebrewRuntime;
  out: string;
  report: string;
  expectedCacheKeys: Record<string, string>;
  allowFallback: boolean;
  bottleCache?: string;
  baseImage?: string;
  maxBytes?: number;
  writeProfile: boolean;
}

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const SHARED_FS_BLOCK_BYTES = 4096;
const HOMEBREW_COMPOSITION_PATH = "/etc/kandelo/homebrew-vfs.json";
const MAX_SIDECAR_JSON_BYTES = 16_777_216;
const MAX_BREWFILE_BYTES = 65_536;
const MAX_BREWFILE_PACKAGES = 128;
const MAX_BREWFILE_PARSER_OUTPUT_BYTES = 65_536;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TAP_NAME_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;
const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BREWFILE_PARSER = resolve(
  SCRIPT_DIR,
  "../../../scripts/homebrew-brewfile-selection.rb",
);

interface BrewfileSelection {
  schema: 1;
  kind: "kandelo-static-brewfile-v1";
  tap_name: string;
  sha256: string;
  bytes: number;
  packages: string[];
}

interface BaseImageBinding {
  sha256: string;
  bytes: number;
  kernelAbi: number;
}

interface LoadedBaseImage {
  binding: BaseImageBinding;
  metadata: VfsImageMetadata;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const metadata = readJsonFile(options.metadata);
  const brewfileSelection = options.brewfile
    ? readBrewfileSelection(options.brewfile)
    : undefined;
  const requestedPackages = brewfileSelection?.packages ?? options.packages;

  const plan = await planHomebrewVfs(metadata, {
    packages: requestedPackages,
    arch: options.arch,
    expectedTapName: brewfileSelection?.tap_name,
    runtime: options.runtime,
    expectedCacheKeys: options.expectedCacheKeys,
    allowFallback: options.allowFallback,
    loadLinkManifest: (relPath) => readJsonFile(join(options.tapRoot, relPath)),
  });

  const { fs, baseImage } = createFs(
    options.baseImage,
    options.maxBytes,
    plan.kandeloAbi,
  );
  const result = await buildHomebrewVfs(plan, {
    fs,
    writeProfile: options.writeProfile,
    createdBy: "images/vfs/scripts/build-homebrew-vfs-image.ts",
    selectionSource: brewfileSelection ? {
      kind: "brewfile",
      parser: brewfileSelection.kind,
      sha256: brewfileSelection.sha256,
      bytes: brewfileSelection.bytes,
      requestedPackages: brewfileSelection.packages,
    } : undefined,
    loadBottleBytes: (pkg) => loadBottleBytes(pkg, options),
  });

  await saveImage(fs, options.out, {
    metadata: {
      version: 1,
      kernelAbi: plan.kandeloAbi,
      createdBy: "images/vfs/scripts/build-homebrew-vfs-image.ts",
      ...(baseImage ? { baseImage: baseImage.binding } : {}),
      homebrew: {
        tapRepository: plan.tapRepository,
        tapName: plan.tapName,
        tapCommit: plan.tapCommit,
        releaseTag: plan.releaseTag,
        selection: {
          kind: result.report.selection.kind,
          requestedPackageCount:
            result.report.selection.requested_packages.length,
          requestedPackagesSha256:
            result.report.selection.requested_packages_sha256,
          ...(result.report.selection.brewfile
            ? { brewfile: result.report.selection.brewfile }
            : {}),
        },
        packages: plan.packages.map((pkg) => ({
          name: pkg.name,
          version: pkg.version,
          arch: pkg.arch,
          sourceStatus: pkg.sourceStatus,
          cacheKeySha: pkg.cacheKeySha,
        })),
      },
    },
  });

  const report = {
    ...result.report,
    ...(baseImage ? {
      base_image: {
        ...baseImage.binding,
        metadata: baseImage.metadata,
      },
    } : {}),
    image: options.out,
  };
  mkdirSync(dirname(options.report), { recursive: true });
  writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Homebrew VFS report: ${options.report}`);
}

function parseArgs(args: string[]): CliOptions {
  const options: Partial<CliOptions> & {
    packages: string[];
    expectedCacheKeys: Record<string, string>;
  } = {
    packages: [],
    expectedCacheKeys: {},
    arch: "wasm32",
    allowFallback: true,
    writeProfile: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--metadata":
        options.metadata = requireValue(args, ++i, arg);
        break;
      case "--tap-root":
        options.tapRoot = requireValue(args, ++i, arg);
        break;
      case "--package":
        options.packages.push(requireValue(args, ++i, arg));
        break;
      case "--brewfile":
        if (options.brewfile !== undefined) {
          usage("--brewfile may be provided only once");
        }
        options.brewfile = requireValue(args, ++i, arg);
        break;
      case "--arch":
        options.arch = parseArch(requireValue(args, ++i, arg));
        break;
      case "--runtime":
        options.runtime = parseRuntime(requireValue(args, ++i, arg));
        break;
      case "--out":
        options.out = requireValue(args, ++i, arg);
        break;
      case "--report":
        options.report = requireValue(args, ++i, arg);
        break;
      case "--expected-cache-key": {
        const [name, sha] = requireValue(args, ++i, arg).split("=", 2);
        if (!name || !sha) usage(`--expected-cache-key must be <package>=<sha256>`);
        options.expectedCacheKeys[name] = sha;
        break;
      }
      case "--no-fallback":
        options.allowFallback = false;
        break;
      case "--bottle-cache":
        options.bottleCache = requireValue(args, ++i, arg);
        break;
      case "--base-image":
        options.baseImage = parseBaseImagePath(requireValue(args, ++i, arg));
        break;
      case "--max-bytes":
        options.maxBytes = parseByteSize(requireValue(args, ++i, arg));
        break;
      case "--write-profile":
        options.writeProfile = true;
        break;
      case "--help":
      case "-h":
        usage(undefined, 0);
        break;
      default:
        usage(`unexpected argument ${arg}`);
    }
  }

  for (const required of ["metadata", "tapRoot", "out", "report"] as const) {
    if (!options[required]) usage(`missing --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  if (options.brewfile && options.packages.length > 0) {
    usage("--brewfile cannot be combined with --package");
  }
  if (!options.brewfile && options.packages.length === 0) {
    usage("exactly one package selection mode is required: --brewfile or --package");
  }
  if (options.baseImage && !existsSync(options.baseImage)) {
    usage(`base image does not exist: ${options.baseImage}`);
  }

  return options as CliOptions;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) usage(`${flag} requires a value`);
  return value;
}

function parseArch(value: string): HomebrewBottleArch {
  if (value === "wasm32" || value === "wasm64") return value;
  usage(`--arch must be wasm32 or wasm64, got ${value}`);
}

function parseRuntime(value: string): HomebrewRuntime {
  if (value === "node" || value === "browser") return value;
  usage(`--runtime must be node or browser, got ${value}`);
}

function parseByteSize(value: string): number {
  const match = /^([1-9][0-9]*)([kKmMgG]i?[bB]?|[bB])?$/.exec(value);
  if (!match) usage(`--max-bytes must be a positive byte size, got ${value}`);
  const amount = Number(match[1]);
  const suffix = (match[2] ?? "b").toLowerCase();
  const multiplier = suffix.startsWith("g") ? 1024 ** 3
    : suffix.startsWith("m") ? 1024 ** 2
    : suffix.startsWith("k") ? 1024
    : 1;
  const bytes = amount * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    usage(`--max-bytes is too large: ${value}`);
  }
  if (bytes % SHARED_FS_BLOCK_BYTES !== 0) {
    usage(`--max-bytes must be a multiple of ${SHARED_FS_BLOCK_BYTES} bytes`);
  }
  return bytes;
}

function parseBaseImagePath(value: string): string {
  if (!value.endsWith(".vfs") && !value.endsWith(".vfs.zst")) {
    usage(`--base-image must end in .vfs or .vfs.zst, got ${value}`);
  }
  return value;
}

function createFs(
  baseImage: string | undefined,
  maxBytes: number | undefined,
  expectedAbi: number,
): { fs: MemoryFileSystem; baseImage?: LoadedBaseImage } {
  if (baseImage) {
    const image = new Uint8Array(readFileSync(baseImage));
    const restored = MemoryFileSystem.fromImagePreservingCapacity(image);
    const metadata = restored.getImageMetadata();
    if (metadata?.kernelAbi === undefined) {
      throw new Error(
        `base image ${baseImage} does not declare its required kernel ABI`,
      );
    }
    if (metadata.kernelAbi !== expectedAbi) {
      throw new Error(
        `base image ${baseImage} declares kernel ABI ${metadata.kernelAbi}, ` +
        `but bottle metadata requires ABI ${expectedAbi}`,
      );
    }
    if (
      metadata.homebrew !== undefined ||
      vfsPathExists(restored, HOMEBREW_COMPOSITION_PATH)
    ) {
      throw new Error(
        `base image ${baseImage} already contains a Homebrew composition; ` +
        "use a platform-only base image",
      );
    }

    const loadedBase: LoadedBaseImage = {
      binding: {
        sha256: createHash("sha256").update(image).digest("hex"),
        bytes: image.byteLength,
        kernelAbi: metadata.kernelAbi,
      },
      metadata,
    };
    const recordedMaxBytes =
      MemoryFileSystem.readImageCapacity(image).maxByteLength;
    if (!Number.isSafeInteger(recordedMaxBytes) || recordedMaxBytes <= 0) {
      throw new Error(
        `base image ${baseImage} declares an invalid filesystem capacity`,
      );
    }

    const targetMaxBytes = maxBytes ?? recordedMaxBytes;
    if (targetMaxBytes !== recordedMaxBytes) {
      console.log(
        `Rebasing base VFS capacity from ${formatMib(recordedMaxBytes)} ` +
        `to ${formatMib(targetMaxBytes)}...`,
      );
      return {
        fs: restored.rebaseToNewFileSystem(targetMaxBytes),
        baseImage: loadedBase,
      };
    }
    return {
      fs: restored,
      baseImage: loadedBase,
    };
  }

  const initialBytes = maxBytes ?? DEFAULT_MAX_BYTES;
  const SharedArrayBufferCtor = SharedArrayBuffer as new (
    byteLength: number,
    options?: { maxByteLength?: number },
  ) => SharedArrayBuffer;
  const sab = new SharedArrayBufferCtor(initialBytes, {
    maxByteLength: initialBytes,
  });
  return { fs: MemoryFileSystem.create(sab, initialBytes) };
}

function formatMib(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}

function vfsPathExists(fs: MemoryFileSystem, path: string): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === -2
    ) {
      return false;
    }
    throw err;
  }
}

function readJsonFile(path: string): unknown {
  const bytes = readBoundedRegularFile(
    path,
    MAX_SIDECAR_JSON_BYTES,
    "Homebrew sidecar JSON",
  );
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
): Uint8Array {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
  if (stat.size > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes: ${path}`);
  }
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes: ${path}`);
  }
  return bytes;
}

function readBrewfileSelection(path: string): BrewfileSelection {
  const parsed = spawnSync("ruby", [BREWFILE_PARSER, path], {
    encoding: "utf8",
    maxBuffer: MAX_BREWFILE_PARSER_OUTPUT_BYTES,
  });
  if (parsed.error) {
    throw new Error(`cannot parse Brewfile ${path}: ${parsed.error.message}`);
  }
  if (parsed.status !== 0) {
    const detail = parsed.stderr.trim() ||
      `parser exited with status ${String(parsed.status)}`;
    throw new Error(`cannot parse Brewfile ${path}: ${detail}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(parsed.stdout);
  } catch {
    throw new Error(`Brewfile parser returned invalid JSON for ${path}`);
  }
  if (!isRecord(value)) {
    throw new Error(`Brewfile parser returned a non-object for ${path}`);
  }
  const expectedKeys = ["bytes", "kind", "packages", "schema", "sha256", "tap_name"];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new Error(`Brewfile parser returned an unsupported result shape for ${path}`);
  }
  if (value.schema !== 1 || value.kind !== "kandelo-static-brewfile-v1") {
    throw new Error(`Brewfile parser returned an unsupported schema for ${path}`);
  }
  if (typeof value.tap_name !== "string" || !TAP_NAME_RE.test(value.tap_name)) {
    throw new Error(`Brewfile parser returned an invalid tap name for ${path}`);
  }
  if (typeof value.sha256 !== "string" || !SHA256_RE.test(value.sha256)) {
    throw new Error(`Brewfile parser returned an invalid sha256 for ${path}`);
  }
  if (
    typeof value.bytes !== "number" ||
    !Number.isInteger(value.bytes) ||
    value.bytes <= 0 ||
    value.bytes > MAX_BREWFILE_BYTES
  ) {
    throw new Error(`Brewfile parser returned an invalid byte count for ${path}`);
  }
  if (
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    value.packages.length > MAX_BREWFILE_PACKAGES ||
    value.packages.some((pkg) =>
      typeof pkg !== "string" || !PACKAGE_NAME_RE.test(pkg)
    ) ||
    new Set(value.packages).size !== value.packages.length
  ) {
    throw new Error(`Brewfile parser returned invalid requested packages for ${path}`);
  }
  return value as unknown as BrewfileSelection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadBottleBytes(
  pkg: HomebrewVfsPackagePlan,
  options: CliOptions,
): Promise<Uint8Array> {
  if (pkg.url.startsWith("file://")) {
    return new Uint8Array(readFileSync(fileURLToPath(pkg.url)));
  }

  const cachePath = options.bottleCache
    ? join(options.bottleCache, `${pkg.sha256}.tar.gz`)
    : undefined;
  if (cachePath && existsSync(cachePath)) {
    return new Uint8Array(readFileSync(cachePath));
  }

  if (!pkg.url.startsWith("https://")) {
    throw new Error(
      `package ${pkg.name}@${pkg.version} bottle URL must be https:// or file://, got ${pkg.url}`,
    );
  }

  const bytes = await fetchHomebrewBottleBytes(pkg.url);
  if (cachePath) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, bytes);
  }
  return bytes;
}

function usage(message?: string, code = 2): never {
  if (message) console.error(`build-homebrew-vfs-image: ${message}`);
  console.error(`usage: npx tsx images/vfs/scripts/build-homebrew-vfs-image.ts \\
  --metadata <Kandelo/metadata.json> \\
  --tap-root <tap-root> \\
  (--brewfile <Brewfile> | --package <name> [--package <name> ...]) \\
  --arch <wasm32|wasm64> [--runtime <node|browser>] \\
  --out <image.vfs.zst> \\
  --report <report.json> \\
  [--expected-cache-key <name>=<sha256>] [--no-fallback] \\
  [--bottle-cache <dir>] [--base-image <base.vfs[.zst]>] \\
  [--max-bytes <bytes|MiB>] [--write-profile]`);
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
