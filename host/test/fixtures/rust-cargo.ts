import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { extractZipEntry, parseZipCentralDirectory } from "../../src/vfs/zip";
import { cargoProjectFiles, cargoProjectBinaryFiles } from "./cargo-project";
import { tryResolveBinary, tryResolveBinaries } from "../../src/binary-resolver";

export function resolveRustCargoArtifacts(): Array<string | null> {
  const bundle = process.env.KANDELO_GUEST_RUST_SDK_BUNDLE;
  if (bundle !== undefined) {
    // An explicitly selected optional resolver output is an independent test
    // input, not a request to find the bundle in the published image closure.
    return [tryResolveBinary("kernel.wasm"), bundle];
  }
  const sdk = "programs/wasm32/kandelo-rust-sdk.zip";
  if (tryResolveBinary(sdk) === null) return [null, null];
  // Ordinary published artifacts must still come from one admitted tier.
  return tryResolveBinaries(["kernel.wasm", sdk]);
}

export async function createRustCargoImage(bundle: Uint8Array, extraFiles: Record<string, string> = {}) {
  const fs = KandeloImageFs.create();
  fs.setImageCapacity(6 * 1024 ** 3);
  const directories = new Set<string>();
  function mkdir(path: string, mode = 0o755) {
    if (path === "/" || directories.has(path)) return;
    mkdir(dirname(path));
    fs.mkdir(path, mode);
    if (path.startsWith("/home/maker")) fs.chown(path, 1000, 1000);
    directories.add(path);
  }
  for (const path of ["/usr", "/home/maker/project"]) mkdir(path);
  mkdir("/tmp", 0o1777);
  for (const [path, source] of Object.entries({ ...cargoProjectFiles, ...extraFiles })) {
    const destination = `/home/maker/project/${path}`;
    mkdir(dirname(destination));
    fs.writeFile(destination, new TextEncoder().encode(source), 0o644);
    fs.chown(destination, 1000, 1000);
  }
  for (const [path, bytes] of Object.entries(cargoProjectBinaryFiles)) {
    const destination = `/home/maker/project/${path}`;
    mkdir(dirname(destination));
    fs.writeFile(destination, bytes, 0o644);
    fs.chown(destination, 1000, 1000);
  }
  const asset = {
    url: "https://cargo.kandelo.invalid/kandelo-rust-sdk.zip", bytes: bundle,
    size: bundle.byteLength, sha256: createHash("sha256").update(bundle).digest("hex"),
  };
  const entries = parseZipCentralDirectory(bundle);
  const symlinkTargets = new Map(entries.filter(entry => entry.isSymlink).map(entry =>
    [entry.fileName, new TextDecoder("utf-8", { fatal: true }).decode(extractZipEntry(bundle, entry))]));
  fs.registerLazyArchive({ url: asset.url, mountPrefix: "/usr", entries, symlinkTargets,
    integrity: { sha256: asset.sha256, bytes: asset.size } });
  return { image: await fs.saveImage(), assets: [asset] };
}
