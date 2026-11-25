// Reuse the canonical digest calculation, not a private reconstruction of the
// ABI snapshot. Normal packages pass the same explicitly verified SDK value;
// native development builds calculate it from this workspace's snapshot.
#[path = "../../tools/xtask/src/local_abi_identity.rs"]
mod local_abi_identity;

fn main() {
    use std::path::PathBuf;
    println!("cargo:rerun-if-env-changed=KANDELO_GUEST_PROGRAM_ABI_DIGEST");
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    println!(
        "cargo:rerun-if-changed={}",
        root.join("abi/snapshot.json").display()
    );
    let digest = match std::env::var("KANDELO_GUEST_PROGRAM_ABI_DIGEST") {
        Ok(value) => value,
        Err(_) => local_abi_identity::local_abi_contract_digest(
            &root,
            wasm_posix_program_abi::ABI_VERSION,
        )
        .expect("canonical SDK program ABI digest")
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect(),
    };
    assert!(
        digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "SDK ABI digest must be64lowercase hexadecimal digits"
    );
    println!("cargo:rustc-env=KANDELO_GUEST_PROGRAM_ABI_DIGEST={digest}");
}
