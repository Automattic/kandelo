import { createHash } from "node:crypto";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { extractZipEntry, parseZipCentralDirectory } from "../../src/vfs/zip";
export { readRustCompilerJob } from "./rust-guest-job";

export const rustCompilerSource = `fn main() {
    let values: Vec<i32> = vec![1, 2, 3];
    println!("Kandelo compiled Rust: sum={}", values.iter().sum::<i32>());
}
`;
export const rustCompilerArgs = [
  "rustc", "-Zunstable-options", "--sysroot", "/usr",
  "--target", "wasm32-unknown-kandelo-std", "/home/maker/hello.rs",
];
export const rustCompilerEnv = [
  "HOME=/home/maker", "TMPDIR=/tmp", "PATH=/usr/bin:/bin",
  "RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1",
];

export async function createRustCompilerImage(compiler: Uint8Array, std: Uint8Array, sdk: Uint8Array) {
  const fs = KandeloImageFs.create();
  fs.setImageCapacity(6 * 1024 ** 3);
  for (const path of ["/usr", "/usr/bin", "/home", "/home/maker", "/tmp"]) {
    fs.mkdir(path, path === "/tmp" ? 0o1777 : 0o755);
  }
  fs.chown("/home/maker", 1000, 1000);
  fs.writeFile("/home/maker/hello.rs", new TextEncoder().encode(rustCompilerSource), 0o644);
  fs.writeFile("/home/maker/type-error.rs", new TextEncoder().encode('fn main() { let _value: u32 = "wrong type"; }\n'), 0o644);
  fs.chown("/home/maker/hello.rs", 1000, 1000);
  fs.chown("/home/maker/type-error.rs", 1000, 1000);
  const assets = [
    { url: "https://rustc.kandelo.invalid/rustc.wasm", bytes: compiler },
    { url: "https://rustc.kandelo.invalid/rust-std.zip", bytes: std },
    { url: "https://rustc.kandelo.invalid/kandelo-sdk.zip", bytes: sdk },
  ].map(asset => ({ ...asset, size: asset.bytes.byteLength,
    sha256: createHash("sha256").update(asset.bytes).digest("hex") }));
  const compilerAsset = assets[0]!;
  fs.registerLazyFile("/usr/bin/rustc", compilerAsset.url,
    compilerAsset.size, 0o755, compilerAsset.sha256);
  for (const asset of assets.slice(1)) {
    const entries = parseZipCentralDirectory(asset.bytes);
    const symlinkTargets = new Map<string, string>(entries.filter(entry => entry.isSymlink).map(entry =>
      [entry.fileName, new TextDecoder("utf-8", { fatal: true }).decode(extractZipEntry(asset.bytes, entry))]));
    fs.registerLazyArchive({ url: asset.url, mountPrefix: "/usr",
      entries, symlinkTargets,
      integrity: { sha256: asset.sha256, bytes: asset.size } });
  }
  return { image: await fs.saveImage(), assets };
}
