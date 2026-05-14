/**
 * Build a pre-built VFS image containing the full shell environment.
 * The actual layout (dash, coreutils symlinks, grep/sed symlinks,
 * extended tool symlinks, magic database, lazy archive references)
 * lives in `shell-vfs-build.ts` so the WordPress (SQLite/LAMP) demos
 * can reuse it.
 *
 * Produces: examples/browser/public/shell.vfs
 *
 * Usage: npx tsx examples/browser/scripts/build-shell-vfs-image.ts
 */
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { saveImage } from "./vfs-image-helpers";
import { populateShellEnvironment } from "./shell-vfs-build";

const OUT_FILE = "examples/browser/public/shell.vfs.zst";

async function main() {
  // 16 MB is sufficient for dash + symlinks + magic + lazy-archive stubs.
  // The eager binaries (bash, coreutils, …) are not baked here — the
  // Shell page registers them lazily at runtime.
  const sab = new SharedArrayBuffer(16 * 1024 * 1024);
  const fs = MemoryFileSystem.create(sab);

  console.log("Populating shell environment...");
  populateShellEnvironment(fs, { eagerBinaries: false });

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
