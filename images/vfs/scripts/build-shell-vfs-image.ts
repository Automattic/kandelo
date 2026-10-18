/**
 * Build a pre-built VFS image containing the full shell environment.
 * The base utility layout comes from the canonical rootfs image. The shell
 * overlay layout lives in `shell-vfs-build.ts` so the WordPress (SQLite/LAMP)
 * demos can reuse it where they still build standalone images.
 *
 * Produces: apps/browser-demos/public/shell.vfs.zst
 *
 * Usage: npx tsx images/vfs/scripts/build-shell-vfs-image.ts
 */
import { readFileSync } from "node:fs";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { saveImage } from "./vfs-image-helpers";
import { populateShellEnvironment } from "./shell-vfs-build";
import { writeMainShellDemoConfig } from "./main-shell-demo-config";
import { restoreTrustedShellRootfs } from "./shell-rootfs-restore";

const OUT_FILE = "apps/browser-demos/public/shell.vfs.zst";

function resolveRootfsImagePath(): string {
  try {
    return resolveBinary("rootfs.vfs.zst");
  } catch {
    return resolveBinary("programs/rootfs.vfs.zst");
  }
}

async function main() {
  const rootfsBytes = readFileSync(resolveRootfsImagePath());
  const fs = await restoreTrustedShellRootfs(
    new Uint8Array(rootfsBytes),
    256 * 1024 * 1024,
  );

  console.log("Populating shell environment...");
  // Doom and modeset arrive as lazy files with the rest of
  // SHELL_LAZY_BINARY_SPECS.
  populateShellEnvironment(fs, { eagerBinaries: false, baseProvided: true });
  writeMainShellDemoConfig(fs);

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
