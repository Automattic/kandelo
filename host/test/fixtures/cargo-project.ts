// An offline workspace that exercises dependency order, build scripts,
// generated source and fork-capable executables without a registry service.
import { createHash } from "node:crypto";
import { gzipSync } from "fflate";

// A real local-registry crate exercises Cargo's checksum verification and
// tar unpacker without depending on an external network service.
const archiveName = "archive-message";
const archiveSources: Record<string, { source: string; mode: number }> = {
  "Cargo.toml": { source: '[package]\nname="archive-message"\nversion="0.1.0"\nedition="2024"\n', mode: 0o644 },
  "src/lib.rs": { source: `pub fn value() -> u32 { 42 }
pub fn executable_mode_preserved() -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(concat!(env!("CARGO_MANIFEST_DIR"), "/probe.sh"))
        .unwrap().permissions().mode() & 0o111 != 0
}\n`, mode: 0o644 },
  "probe.sh": { source: "#!/bin/sh\nexit 0\n", mode: 0o755 },
};
function localCrate(): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [path, file] of Object.entries(archiveSources)) {
    const bytes = encoder.encode(file.source), header = new Uint8Array(512);
    const write = (offset: number, value: string) => header.set(encoder.encode(value), offset);
    const octal = (offset: number, width: number, value: number) =>
      write(offset, value.toString(8).padStart(width - 1, "0") + "\0");
    write(0, `${archiveName}-0.1.0/${path}`);
    octal(100, 8, file.mode); octal(108, 8, 0); octal(116, 8, 0);
    octal(124, 12, bytes.length); octal(136, 12, 0);
    header.fill(32, 148, 156); write(156, "0"); write(257, "ustar\0"); write(263, "00");
    write(148, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ");
    chunks.push(header, bytes, new Uint8Array((512 - bytes.length % 512) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const tar = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { tar.set(chunk, offset); offset += chunk.length; }
  return gzipSync(tar, { mtime: 0 });
}
const crate = localCrate();
export const cargoProjectBinaryFiles: Record<string, Uint8Array> = {
  "registry/archive-message-0.1.0.crate": crate,
};
export const cargoProjectFiles: Record<string, string> = {
  ".cargo/config.toml": '[source.crates-io]\nreplace-with="fixture"\n[source.fixture]\nlocal-registry="registry"\n',
  "registry/index/ar/ch/archive-message": JSON.stringify({ name: archiveName, vers: "0.1.0", deps: [],
    cksum: createHash("sha256").update(crate).digest("hex"), features: {}, yanked: false }) + "\n",
  "Cargo.toml": `[workspace]\nmembers = ["app", "message"]\nresolver = "2"\n[profile.dev]\ndebug = 0\ncodegen-units = 1\nincremental = false\n`,
  "app/Cargo.toml": `[package]\nname = "cargo-hello"\nversion = "0.1.0"\nedition = "2024"\n[dependencies]\nmessage = { path = "../message" }\n`,
  "message/Cargo.toml": `[package]\nname = "message"\nversion = "0.1.0"\nedition = "2024"\n[dependencies]\narchive-message = "=0.1.0"\n`,
  "message/src/lib.rs": `pub fn value() -> u32 { archive_message::value() }
#[cfg(test)]
mod tests {
    #[test]
    fn answers() { assert_eq!(super::value(), 42); }
    #[test]
    fn cpu_count_is_available() {
        assert!(std::thread::available_parallelism().unwrap().get() >= 1);
    }
    #[test]
    fn crate_unpacker_preserves_executable_permissions() {
        assert!(archive_message::executable_mode_preserved());
    }
    #[test]
    #[should_panic(expected = "intentional expected panic")]
    fn expected_panic() { panic!("intentional expected panic"); }
    #[test]
    #[ignore = "acceptance exercises failure propagation separately"]
    fn deliberately_fails() { assert_eq!(super::value(), 0); }
    #[test]
    #[ignore = "acceptance exercises expected-panic matching separately"]
    #[should_panic(expected = "the expected message")]
    fn wrong_panic_message() { panic!("a different message"); }
}\n`,
  "app/tests/child.rs": `#[test]
fn compiled_binary_runs_as_a_child() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_cargo-hello"))
        .arg("--child").output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "child=42\\n");
}\n`,
  "app/build.rs": `use std::{env, fs, path::PathBuf, process::Command};
fn main() {
    let status = Command::new("rustc").arg("--version").status().unwrap();
    assert!(status.success());
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    fs::write(out.join("generated.rs"), r#"const GREETING: &str = "Cargo inside Kandelo";"#).unwrap();
    println!("cargo:rerun-if-changed=build.rs");
}\n`,
  "app/src/main.rs": `use std::process::Command;
include!(concat!(env!("OUT_DIR"), "/generated.rs"));
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--child") {
        println!("child={}", message::value());
        return;
    }
    let child = Command::new(std::env::current_exe().unwrap()).arg("--child").output().unwrap();
    assert!(child.status.success());
    print!("{GREETING}: {}", String::from_utf8(child.stdout).unwrap());
}
#[cfg(test)]
mod tests {
    #[test]
    fn build_script_generated_source_is_available() {
        assert_eq!(super::GREETING, "Cargo inside Kandelo");
    }
}\n`,
};
export const cargoProjectOutput = "Cargo inside Kandelo: child=42\n";
// Explicit target selection runs unit and integration tests without invoking
// rustdoc, which the guest SDK does not ship yet. No tests are disabled.
export const cargoTestArgs = ["test", "--offline", "-j1", "--workspace", "--tests", "--", "--test-threads=1"];
export const cargoFailingTestArgs = ["test", "--offline", "-j1", "-p", "message", "--lib", "--",
  "--test-threads=1", "--ignored", "--exact", "tests::deliberately_fails"];
export const cargoWrongPanicArgs = [...cargoFailingTestArgs.slice(0, -1), "tests::wrong_panic_message"];
