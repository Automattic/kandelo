import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { findRepoRoot, resolveBinary } from "../../src/binary-resolver";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { OverlayStorageFile } from "../../src/vfs/overlay-storage";
import { imageReadFromContainer } from "../../src/vfs/rootfs-lazy-archives";
import { maybeDecompressImage } from "../../src/vfs/vfs-image-transport";

export function readSavedShellPrograms(defaultGuest: string) {
  const kernel = readFileSync(process.env.KANDELO_KIFS_BENCH_KERNEL ?? resolveBinary("kernel.wasm"));
  const guest = readFileSync(process.env.KANDELO_KIFS_BENCH_GUEST ?? defaultGuest);
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const digests = { kernelSha256: digest(kernel), guestSha256: digest(guest) };
  const expected = process.env.KANDELO_KIFS_KERNEL_SHA256;
  if (expected && digests.kernelSha256 !== expected) {
    throw new Error(`Selected kernel ${digests.kernelSha256} differs from benchmark kernel ${expected}`);
  }
  return { kernel, guest, digests };
}

function readPartialShell() {
  const partial = join(findRepoRoot(), "local-binaries", "partial");
  const manifest = JSON.parse(readFileSync(join(partial, "partial.json"), "utf8"));
  if (manifest.image !== "shell" || manifest.file !== "shell-partial.vfs.zst") {
    throw new Error("Build the partial shell with ./run.sh partial shell bash coreutils git");
  }
  const source = readFileSync(join(partial, manifest.file));
  const digest = createHash("sha256").update(source).digest();
  if (digest.toString("hex") !== manifest.sha256) throw new Error("Partial shell digest mismatch");
  const raw = maybeDecompressImage(source);
  return { raw, digest };
}

/** Stage the exact local package artifact into an empty disposable volume. */
export function stagePartialShell(directory: string) {
  const { raw, digest } = readPartialShell();
  const image = KandeloImageFs.createFromPositionedImage(
    Uint8Array.from(readFileSync(resolveBinary("kandelo_image_module_positioned32.wasm"))),
    raw.length, imageReadFromContainer(raw),
  );
  const target = OverlayStorageFile.open(new HostFileSystem(directory), "/shell.kifs");
  try {
    image.stageKifsV3To(target, 1024 ** 3 / 4096, digest);
  } finally {
    target.close();
    image.reset();
  }
  return { path: join(directory, "shell.kifs"), identity: digest.toString("hex") };
}

/** Use the same checked-base container as a saved product computer. */
export async function writeCheckedPartialShell(directory: string) {
  const { raw, digest } = readPartialShell();
  const image = KandeloImageFs.createPositioned(readFileSync(resolveBinary("kandelo_image_module_positioned32.wasm")));
  const target = OverlayStorageFile.open(new HostFileSystem(directory), "/base.img");
  try {
    const checked = await image.writePersistentImageTo(target, raw.length, "sha256", [raw]);
    return { path: join(directory, "base.img"), identity: checked.identitySha256, source: digest.toString("hex") };
  } finally { target.close(); image.reset(); }
}

export function shellWorkloadCount(): number | undefined {
  const value = process.env.KANDELO_KIFS_SHELL_ENTRIES;
  if (value === undefined) return undefined;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) throw new Error("Invalid shell workload count");
  return count;
}
