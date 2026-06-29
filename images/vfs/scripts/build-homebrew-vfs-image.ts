/**
 * Build a precomposed Homebrew-prefix VFS image from Kandelo/Homebrew sidecars.
 *
 * Usage:
 *   npx tsx images/vfs/scripts/build-homebrew-vfs-image.ts \
 *     --metadata homebrew/kandelo-homebrew/Kandelo/metadata.json \
 *     --tap-root homebrew/kandelo-homebrew \
 *     --package hello \
 *     --arch wasm32 \
 *     --runtime node \
 *     --out target/homebrew-hello.vfs.zst \
 *     --report target/homebrew-hello.vfs-report.json
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHomebrewVfs } from "../../../host/src/homebrew-vfs-builder";
import { fetchHomebrewBottleBytes } from "../../../host/src/homebrew-vfs-fetch";
import {
  planHomebrewVfs,
  type HomebrewBottleArch,
  type HomebrewRuntime,
  type HomebrewVfsPackagePlan,
} from "../../../host/src/homebrew-vfs-planner";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { saveImage } from "./vfs-image-helpers";

interface CliOptions {
  metadata: string;
  tapRoot: string;
  packages: string[];
  arch: HomebrewBottleArch;
  runtime?: HomebrewRuntime;
  out: string;
  report: string;
  expectedCacheKeys: Record<string, string>;
  allowFallback: boolean;
  bottleCache?: string;
  maxBytes: number;
  writeProfile: boolean;
}

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const metadata = readJsonFile(options.metadata);

  const plan = await planHomebrewVfs(metadata, {
    packages: options.packages,
    arch: options.arch,
    runtime: options.runtime,
    expectedCacheKeys: options.expectedCacheKeys,
    allowFallback: options.allowFallback,
    loadLinkManifest: (relPath) => readJsonFile(join(options.tapRoot, relPath)),
  });

  const fs = createFs(options.maxBytes);
  const result = await buildHomebrewVfs(plan, {
    fs,
    writeProfile: options.writeProfile,
    createdBy: "images/vfs/scripts/build-homebrew-vfs-image.ts",
    loadBottleBytes: (pkg) => loadBottleBytes(pkg, options),
  });

  await saveImage(fs, options.out, {
    metadata: {
      version: 1,
      kernelAbi: plan.kandeloAbi,
      createdBy: "images/vfs/scripts/build-homebrew-vfs-image.ts",
      homebrew: {
        tapRepository: plan.tapRepository,
        tapCommit: plan.tapCommit,
        releaseTag: plan.releaseTag,
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

  const report = { ...result.report, image: options.out };
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
    maxBytes: DEFAULT_MAX_BYTES,
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
  if (options.packages.length === 0) usage("at least one --package is required");

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
  return bytes;
}

function createFs(maxBytes: number): MemoryFileSystem {
  const SharedArrayBufferCtor = SharedArrayBuffer as new (
    byteLength: number,
    options?: { maxByteLength?: number },
  ) => SharedArrayBuffer;
  const sab = new SharedArrayBufferCtor(maxBytes, { maxByteLength: maxBytes });
  return MemoryFileSystem.create(sab, maxBytes);
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
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
  --package <name> [--package <name> ...] \\
  --arch <wasm32|wasm64> [--runtime <node|browser>] \\
  --out <image.vfs.zst> \\
  --report <report.json> \\
  [--expected-cache-key <name>=<sha256>] [--no-fallback] \\
  [--bottle-cache <dir>] [--max-bytes <bytes|MiB>] [--write-profile]`);
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
