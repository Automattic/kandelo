/** Audit a Kandelo-provided product, without reading or fetching lazy files. */
import { readFileSync } from "node:fs";
import { KandeloImageFs } from "../images/vfs/lib/kandelo-image-fs";
import { assertKandeloFilesystemLayout } from "../images/vfs/scripts/filesystem-layout";

if (process.argv.length < 3) throw new Error("Usage: check-image-layout.ts IMAGE.vfs.zst [...]");
for (const path of process.argv.slice(2)) {
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(readFileSync(path)));
  assertKandeloFilesystemLayout(fs);
  console.log(`FHS layout audit passed: ${path}`);
}
