import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { ensureDirRecursive, writeVfsBinary } from "./vfs-image-helpers";
import { openMiniatureVfsProductBuild } from "./vfs-product-builder-contract";

export interface AbiStagingMiniVfsBuildOptions {
  manifestPath: string;
  inputsPath: string;
  reportPath: string;
  outputPath: string;
}

export async function buildAbiStagingMiniVfs(
  options: AbiStagingMiniVfsBuildOptions,
): Promise<void> {
  const paths = validatePaths(options);
  const build = await openMiniatureVfsProductBuild(
    paths.inputsPath,
    paths.reportPath,
  );
  validateManifest(paths.manifestPath, build.product);

  const embedded = build.requireHomebrewBottle("base-bottle");
  if (embedded.placement !== "embedded") {
    throw new Error("miniature base bottle must be embedded");
  }
  const lazy = build.requireHomebrewBottle("tool-bottle");
  if (lazy.placement !== "lazy-reference") {
    throw new Error("miniature tool bottle must remain a lazy reference");
  }

  const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  ensureDirRecursive(fs, "/usr/bin");
  writeVfsBinary(
    fs,
    "/usr/bin/base",
    new Uint8Array(readFileSync(embedded.path)),
    0o755,
  );
  fs.registerLazyFile("/usr/bin/tool", lazy.reference, lazy.bytes, 0o755);
  const image = await fs.saveImage({
    metadata: {
      version: 1,
      kernelAbi: build.targetAbi.version,
      abiSnapshotSha256: build.targetAbi.snapshot_sha256,
    },
    normalizeTimestampsMs: 0,
  });
  writeFileSync(paths.outputPath, image);
  await verifyMiniatureImage(image, build.targetAbi, embedded.sha256, lazy);
  await build.finish(paths.outputPath);
}

async function verifyMiniatureImage(
  image: Uint8Array,
  targetAbi: Readonly<{ version: number; snapshot_sha256: string }>,
  embeddedSha256: string,
  lazy: Readonly<{
    sha256: string;
    bytes: number;
    placement: "lazy-reference";
    reference: string;
  }>,
): Promise<void> {
  const metadata = MemoryFileSystem.readImageMetadata(image);
  if (
    metadata?.kernelAbi !== targetAbi.version ||
    metadata.abiSnapshotSha256 !== targetAbi.snapshot_sha256
  ) {
    throw new Error("miniature VFS metadata does not bind the target ABI");
  }
  const restored = MemoryFileSystem.fromImage(image);
  await restored.verifyImportedLazyAtomicGroupSeals();
  const embeddedBytes = readVfsFile(restored, "/usr/bin/base");
  if (sha256(embeddedBytes) !== embeddedSha256) {
    throw new Error("miniature embedded bottle identity changed during VFS save");
  }
  const restoredLazy = restored.getLazyEntry("/usr/bin/tool");
  if (
    restoredLazy?.url !== lazy.reference ||
    restoredLazy.size !== lazy.bytes ||
    !lazy.reference.includes(`sha256:${lazy.sha256}`)
  ) {
    throw new Error("miniature lazy bottle reference changed during VFS save");
  }
}

function validateManifest(
  manifestPath: string,
  product: Readonly<{
    id: string;
    architecture: "wasm32" | "wasm64";
    output: string;
  }>,
): void {
  const text = readFileSync(manifestPath, "utf8");
  const firstTable = text.search(/^\[/m);
  const header = firstTable === -1 ? text : text.slice(0, firstTable);
  const required = {
    architecture: oneLiteral(header, "architecture"),
    builder: oneLiteral(header, "builder"),
    id: oneLiteral(header, "id"),
    output: oneLiteral(header, "output"),
  };
  if (
    required.id !== product.id ||
    required.architecture !== product.architecture ||
    required.output !== product.output
  ) {
    throw new Error("miniature builder manifest identity does not match resolved inputs");
  }
  if (required.builder !== "images/vfs/scripts/build-abi-staging-mini-vfs.ts") {
    throw new Error("miniature product does not select the miniature builder");
  }
}

function oneLiteral(text: string, key: string): string {
  const matches = [
    ...text.matchAll(new RegExp(`^${key} = "([^"\\\\]+)"$`, "gm")),
  ];
  if (matches.length !== 1) {
    throw new Error(`miniature manifest must contain exactly one literal ${key}`);
  }
  return matches[0][1];
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const size = fs.stat(path).size;
  const descriptor = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(size);
    const read = fs.read(descriptor, bytes, null, bytes.byteLength);
    if (read !== bytes.byteLength) {
      throw new Error(`miniature VFS read for ${path} was incomplete`);
    }
    return bytes;
  } finally {
    fs.close(descriptor);
  }
}

function validatePaths(
  options: AbiStagingMiniVfsBuildOptions,
): AbiStagingMiniVfsBuildOptions {
  const normalized = Object.fromEntries(
    Object.entries(options).map(([name, path]) => {
      if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
        throw new Error(`${name} must be a nonempty path`);
      }
      if (resolve(path) !== path) throw new Error(`${name} must be absolute`);
      return [name, path];
    }),
  ) as unknown as AbiStagingMiniVfsBuildOptions;
  for (const [name, path] of [
    ["manifest", normalized.manifestPath],
    ["resolved inputs", normalized.inputsPath],
  ] as const) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${name} must be a regular nonsymlink file`);
    }
  }
  return normalized;
}

function parseCli(args: readonly string[]): AbiStagingMiniVfsBuildOptions {
  const expected: ReadonlyMap<string, keyof AbiStagingMiniVfsBuildOptions> = new Map([
    ["--vfs-product-manifest", "manifestPath"],
    ["--vfs-product-inputs", "inputsPath"],
    ["--vfs-product-report", "reportPath"],
    ["--vfs-product-output", "outputPath"],
  ] as const);
  if (args.length !== expected.size * 2) {
    throw new Error(`expected ${[...expected.keys()].join(" ")}`);
  }
  const values: Partial<Record<keyof AbiStagingMiniVfsBuildOptions, string>> = {};
  for (let index = 0; index < args.length; index += 2) {
    const field = expected.get(args[index]);
    if (!field || values[field] !== undefined) {
      throw new Error(`unknown or duplicate miniature builder flag ${args[index]}`);
    }
    values[field] = args[index + 1];
  }
  for (const field of expected.values()) {
    if (values[field] === undefined) throw new Error(`missing miniature builder ${field}`);
  }
  return values as AbiStagingMiniVfsBuildOptions;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  buildAbiStagingMiniVfs(parseCli(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
