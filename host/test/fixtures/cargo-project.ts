// An offline workspace that exercises dependency order, build scripts,
// generated source and fork-capable executables without a registry service.
export const cargoProjectFiles: Record<string, string> = {
  "Cargo.toml": `[workspace]\nmembers = ["app", "message"]\nresolver = "2"\n[profile.dev]\ndebug = 0\ncodegen-units = 1\nincremental = false\n`,
  "app/Cargo.toml": `[package]\nname = "cargo-hello"\nversion = "0.1.0"\nedition = "2024"\n[dependencies]\nmessage = { path = "../message" }\n`,
  "message/Cargo.toml": `[package]\nname = "message"\nversion = "0.1.0"\nedition = "2024"\n`,
  "message/src/lib.rs": `pub fn value() -> u32 { 42 }\n`,
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
}\n`,
};
export const cargoProjectOutput = "Cargo inside Kandelo: child=42\n";
