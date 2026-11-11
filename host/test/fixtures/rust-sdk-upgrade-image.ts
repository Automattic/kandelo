import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../../src/binary-resolver";
import { extractZipEntry, parseZipCentralDirectory } from "../../src/vfs/zip";
import { createRustCargoImage, resolveRustCargoArtifacts } from "./rust-cargo";

export function resolveRustSdkUpgradeArtifacts() {
  const old = process.env.KANDELO_GUEST_RUST_OLD_SDK;
  const unzip =
    process.env.KANDELO_GUEST_RUST_UPGRADE_UNZIP ??
    tryResolveBinary("programs/wasm32/unzip.wasm");
  const [kernel, sdk] = resolveRustCargoArtifacts();
  return [process.env.KANDELO_GUEST_RUST_UPGRADE_KERNEL ?? kernel, sdk, old ?? null, unzip];
}

export async function createRustSdkUpgradeImage(
  old: Uint8Array,
  next: Uint8Array,
  unzip: Uint8Array,
) {
  const entries = parseZipCentralDirectory(next);
  const driver = entries.find((e) => e.fileName === "bin/kandelo-rustc");
  const manifest = entries.find(
    (e) => e.fileName === "share/kandelo/rust-sdk/manifest.json",
  );
  if (!driver || !manifest)
    throw new Error("new SDK lacks its driver or component manifest");
  const { identity } = JSON.parse(
    new TextDecoder().decode(extractZipEntry(next, manifest)),
  );
  const source = readFileSync(
    fileURLToPath(new URL("./rust-sdk-upgrade/installer.rs", import.meta.url)),
    "utf8",
  );
  const initial = await createRustCargoImage(old, {
    "sdk-upgrade/Cargo.toml": `[workspace]\n[package]\nname = "sdk-upgrade-probe"\nversion = "0.1.0"\nedition = "2021"\nbuild = "build.rs"\n[dependencies]\nupgrade-helper = { path = "helper" }\n[profile.dev]\ndebug = 2\ncodegen-units = 1\nincremental = false\n`,
    "sdk-upgrade/helper/Cargo.toml": `[package]\nname = "upgrade-helper"\nversion = "0.1.0"\nedition = "2021"\n`,
    "sdk-upgrade/helper/src/lib.rs": `#[inline(never)]\npub fn capture() -> std::backtrace::Backtrace { std::backtrace::Backtrace::force_capture() }\n`,
    "sdk-upgrade/src/main.rs": `fn main() {\n let trace = upgrade_helper::capture();\n println!("built-sdk: {}", env!("BUILT_SDK"));\n println!("backtrace-status: {:?}", trace.status());\n println!("{}", trace);\n}\n`,
    "sdk-upgrade/build.rs": `fn main() {\n let rustc = std::env::var("RUSTC").unwrap();\n let output = std::process::Command::new(rustc).arg("-vV").output().unwrap();\n assert!(output.status.success());\n let text = String::from_utf8(output.stdout).unwrap();\n let identity = text.lines().find_map(|s| s.strip_prefix("kandelo-sdk: ")).unwrap_or("legacy");\n println!("cargo:rustc-env=BUILT_SDK={}", identity);\n println!("cargo:rerun-if-changed=build.rs");\n}\n`,
    "sdk-upgrade/src/bin/sdk-installer.rs": source,
  });
  const image = KandeloImageFs.create();
  image.loadImage(initial.image);
  for (const path of [
    "/var",
    "/var/lib",
    "/var/lib/kandelo",
    "/var/lib/kandelo/sdk-upgrade",
  ])
    image.mkdir(path);
  const assets = [...initial.assets];
  for (const [path, bytes] of [
    ["/usr/bin/unzip", unzip],
    ["/var/lib/kandelo/sdk-upgrade/new-sdk.zip", next],
  ] as const) {
    const asset = {
      url: "https://cargo.kandelo.invalid/upgrade/" + path.split("/").pop(),
      bytes,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    image.registerLazyFile(
      path,
      asset.url,
      asset.size,
      path.endsWith(".zip") ? 0o644 : 0o755,
      asset.sha256,
    );
    assets.push(asset);
  }
  return {
    image: await image.saveImage({ normalizeTimestampsMs: 0 }),
    assets,
    identity,
    driverSize: driver.uncompressedSize,
  };
}
