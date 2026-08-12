/**
 * Build a pre-built VFS image containing Erlang/OTP 28 runtime files
 * (kernel, stdlib, erts, compiler, and release boot scripts).
 *
 * The package wrapper supplies an explicit OTP input tree and output path.
 *
 * Usage: npx tsx images/vfs/scripts/build-erlang-vfs-image.ts
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  exactVfsImageMetadata,
  ensureDir,
  ensureDirRecursive,
  saveImage,
  type ExactVfsImageAbi,
  walkAndWrite,
} from "./vfs-image-helpers";
const BLOCK_SIZE = 4096;
const IMAGE_HEADROOM = 1024 * 1024;
const BEAM_RELATIVE_PATH = join("erts-16.1.2", "bin", "beam.smp");

/**
 * Resolve the OTP install tree supplied by the package transaction. Do not
 * fall back to a recipe-directory side effect or a user cache: either would
 * let stale bytes satisfy a fresh package build.
 */
function requireOtpInstall(root: string | undefined): string {
  const required = [
    join("bin", "start.boot"),
    BEAM_RELATIVE_PATH,
    join("erts-16.1.2", "bin", "erl_child_setup"),
    join("lib", "kernel-10.4.2", "ebin"),
    join("lib", "stdlib-7.1", "ebin"),
    join("releases", "28", "start_clean.boot"),
  ];
  if (!root || required.some((path) => !existsSync(join(root, path)))) {
    throw new Error("KANDELO_ERLANG_OTP_ROOT must name the resolved OTP runtime tree");
  }
  return root;
}

function stagedByteLength(root: string): number {
  let total = 0;
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) total += stat.size;
    }
  };
  visit(root);
  return total;
}

function imageCapacity(stagedBytes: number): number {
  const requested = stagedBytes * 2 + IMAGE_HEADROOM;
  return Math.ceil(requested / BLOCK_SIZE) * BLOCK_SIZE;
}

export interface ErlangVfsImageBuildInputs {
  erlang: Uint8Array;
  otpDirectory: string;
  outputPath: string;
  targetAbi?: ExactVfsImageAbi;
}

export async function buildErlangVfsImage(
  inputs: ErlangVfsImageBuildInputs,
): Promise<void> {
  const installDirectory = requireOtpInstall(inputs.otpDirectory);
  const archivedBeam = new Uint8Array(
    readFileSync(join(installDirectory, BEAM_RELATIVE_PATH)),
  );
  if (
    inputs.erlang.byteLength !== archivedBeam.byteLength ||
    !Buffer.from(inputs.erlang).equals(Buffer.from(archivedBeam))
  ) {
    throw new Error(
      "declared Erlang executable differs from the OTP runtime boot executable",
    );
  }

  // Keep enough allocator headroom for the complete relocatable OTP tree,
  // including the boot contract and target executable helpers. A fixed 16 MB
  // image silently stopped being sufficient once the VFS began consuming the
  // publisher-safe archive instead of only selected ebin directories.
  const bytes = stagedByteLength(installDirectory);
  const sab = new SharedArrayBuffer(imageCapacity(bytes));
  const fs = MemoryFileSystem.create(sab);

  // Standard directories
  ensureDir(fs, "/tmp");
  fs.chmod("/tmp", 0o777);
  ensureDir(fs, "/home");

  // OTP directory tree
  const otpRoot = "/usr/local/lib/erlang";
  ensureDirRecursive(fs, otpRoot);
  const totalFiles = walkAndWrite(fs, installDirectory, otpRoot, {
    preserveMode: true,
    preserveSymlinks: true,
  });
  console.log(`Wrote ${totalFiles} OTP runtime files (${bytes} bytes)`);
  await saveImage(fs, inputs.outputPath, {
    normalizeTimestampsMs: 0,
    ...(inputs.targetAbi === undefined
      ? {}
      : {
          kernelAbi: inputs.targetAbi.version,
          metadata: exactVfsImageMetadata(
            inputs.targetAbi,
            "images/vfs/scripts/build-erlang-vfs-image.ts",
          ),
        }),
  });
}

async function main(): Promise<void> {
  const outputPath = process.env.KANDELO_ERLANG_VFS_OUT;
  if (!outputPath) {
    throw new Error(
      "KANDELO_ERLANG_VFS_OUT must name the caller-owned output path",
    );
  }
  const otpDirectory = requireOtpInstall(process.env.KANDELO_ERLANG_OTP_ROOT);
  await buildErlangVfsImage({
    erlang: new Uint8Array(
      readFileSync(join(otpDirectory, BEAM_RELATIVE_PATH)),
    ),
    otpDirectory,
    outputPath,
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
