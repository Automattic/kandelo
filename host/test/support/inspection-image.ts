import { readFileSync } from "node:fs";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../../src/binary-resolver";

export const INSPECTION_MUTATION = [
  "set -e",
  "mkdir /tmp/inspection-live",
  "printf 'live guest bytes' > /tmp/inspection-live/data",
  "chmod 0640 /tmp/inspection-live/data",
  "chown 123:456 /tmp/inspection-live/data",
  "ln -s /tmp/inspection-live /inspection/guest",
].join("; ");

/** Build plain transferable image bytes; only the worker owns the live FS. */
export async function inspectionImage(large = false): Promise<Uint8Array> {
  const fs = KandeloImageFs.create();
  fs.mkdir("/inspection", 0o755);
  fs.mkdir("/inspection/site", 0o750, 12, 34);
  fs.writeFile("/inspection/index.html", new TextEncoder().encode("hello"), 0o644);
  fs.symlink("site", "/inspection/current", 56, 78);
  fs.symlink("/foreign", "/inspection/foreign");
  fs.ensureDirRecursive("/usr/bin/bash");
  fs.mkdir("/bin", 0o755);
  for (const program of ["bash", "coreutils"]) {
    fs.writeFile(`/usr/bin/${program}`, readFileSync(resolveBinary(`programs/${program}.wasm`)), 0o755);
  }
  for (const command of ["mkdir", "ln", "chmod", "chown"]) fs.symlink("/usr/bin/coreutils", `/bin/${command}`);
  if (large) {
    fs.mkdir("/large", 0o755);
    for (let i = 0; i < 800; i++) {
      fs.writeFile(`/large/${String(i).padStart(4, "0")}-${"x".repeat(96)}`, new Uint8Array([i & 255]), 0o644);
    }
  }
  return fs.saveImage();
}
