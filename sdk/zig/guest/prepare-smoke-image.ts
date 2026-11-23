import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

const [baseImage, install, instrumenter, output, sdkDriver, ...extra] = process.argv.slice(2);
if (!baseImage || !install || !instrumenter || !output || extra.length) {
  throw new Error("usage: prepare-smoke-image.ts BUILD_IMAGE ZIG_INSTALL GUEST_INSTRUMENTER OUT_VFS [GUEST_SDK_DRIVER]");
}

const fs = KandeloImageFs.create(await readFile(resolveBinary("kandelo_image_module32.wasm")));

async function copy(source: string, destination: string, mode = 0o644) {
  fs.ensureDirRecursive(destination);
  fs.createFileWithOwner(destination, mode, 0, 0, await readFile(source));
}

async function copyTree(source: string, destination: string) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = `${destination}/${entry.name}`;
    if (entry.isDirectory()) await copyTree(from, to);
    if (entry.isFile()) await copy(from, to);
  }
}

try {
  fs.loadImage(await readFile(baseImage));
  fs.setImageCapacity(1024 * 1024 * 1024);
  await copy(join(install, "bin/zig"), "/zig-tools/bin/zig", 0o755);
  await copy(instrumenter, "/zig-tools/bin/wasm-fork-instrument", 0o755);
  if (sdkDriver) await copy(sdkDriver, "/zig-tools/bin/wasm32posix-cc", 0o755);
  const lib = join(install, "lib/zig");
  for (const name of ["std", "compiler", "compiler_rt"]) {
    await copyTree(join(lib, name), `/zig-tools/lib/zig/${name}`);
  }
  for (const name of ["compiler_rt.zig", "ubsan_rt.zig", "c.zig", "zig.h"]) {
    await copy(join(lib, name), `/zig-tools/lib/zig/${name}`);
  }
  await copyTree(join(import.meta.dirname, "smoke"), "/guest-zig-smoke");
  await writeFile(output, await fs.saveImage());
} finally {
  fs.reset();
}
