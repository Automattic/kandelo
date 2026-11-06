//! `xtask stamp-abi-contract <wasm>...`
//!
//! Stamp locally built guest wasm with this checkout's ABI-contract digest.
//!
//! The package build engine (`build_deps`) stamps every `.wasm` member it
//! installs, so package-owned programs carry `kandelo.abi.contract`. Programs
//! and test fixtures built directly by `scripts/build-programs.sh` bypass that
//! engine, and the host then reports them as legacy pre-rollout binaries — a
//! warning that is false for a binary built seconds ago, and that pollutes
//! stderr for tests which assert the host stays quiet.
//!
//! Stamping is idempotent per file: a wasm that already carries the section is
//! left alone when its digest already matches, and reported as an error when it
//! does not (that is a genuinely stale artifact, not something to overwrite).
use std::path::Path;

pub(crate) fn run(args: &[String]) -> Result<(), String> {
    if args.is_empty() {
        return Err(
            "usage: xtask stamp-abi-contract <wasm>...\n       \
             stamps this checkout's kandelo.abi.contract digest onto each wasm"
                .to_string(),
        );
    }
    let repo_root = crate::repo_root();
    let digest = crate::local_abi_identity::local_abi_contract_digest(
        &repo_root,
        wasm_posix_shared::ABI_VERSION,
    )?;

    let mut stamped = 0usize;
    let mut already = 0usize;
    for arg in args {
        match stamp_one(Path::new(arg), &digest)? {
            Outcome::Stamped => stamped += 1,
            Outcome::AlreadyCurrent => already += 1,
            Outcome::NotWasm => {}
        }
    }
    println!(
        "stamp-abi-contract: stamped {stamped}, already current {already}"
    );
    Ok(())
}

/// `xtask abi-program-digest [snapshot.json]`: print the program digest of a
/// snapshot (default: this checkout's) as hex. It answers "does this ABI change
/// force every program to be rebuilt?" by comparing two snapshots.
pub(crate) fn run_print(args: &[String]) -> Result<(), String> {
    let path = match args {
        [] => crate::repo_root().join("abi/snapshot.json"),
        [path] => path.into(),
        _ => return Err("usage: xtask abi-program-digest [snapshot.json]".to_string()),
    };
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    let snapshot: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    let version = snapshot["abi_version"]
        .as_u64()
        .and_then(|version| u32::try_from(version).ok())
        .ok_or_else(|| format!("{}: missing abi_version", path.display()))?;
    let digest = crate::local_abi_identity::program_contract_digest(&snapshot, version)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    println!("{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>());
    Ok(())
}

enum Outcome {
    Stamped,
    AlreadyCurrent,
    NotWasm,
}

fn stamp_one(path: &Path, digest: &[u8; 32]) -> Result<Outcome, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    // A non-wasm artifact carries no module-level ABI identity. Skipping keeps
    // callers free to pass a whole build output list.
    if !bytes.starts_with(b"\0asm") {
        return Ok(Outcome::NotWasm);
    }
    if let Some(existing) =
        crate::build_stamp::read_named_section(&bytes, crate::build_stamp::ABI_CONTRACT_SECTION)?
    {
        if existing == *digest {
            return Ok(Outcome::AlreadyCurrent);
        }
        return Err(format!(
            "{}: carries a kandelo.abi.contract digest from a different ABI \
             snapshot; rebuild it rather than restamping",
            path.display()
        ));
    }
    let stamped = crate::build_stamp::stamp_named_section(
        &bytes,
        crate::build_stamp::ABI_CONTRACT_SECTION,
        digest,
    )
    .map_err(|error| format!("{}: {error}", path.display()))?;
    // A fork-instrumented or `make install`ed artifact is commonly read-only.
    let mode = std::fs::metadata(path)
        .map_err(|error| format!("stat {}: {error}", path.display()))?
        .permissions();
    let restore = mode.readonly();
    if restore {
        let mut writable = mode.clone();
        #[allow(clippy::permissions_set_readonly_false)]
        writable.set_readonly(false);
        std::fs::set_permissions(path, writable)
            .map_err(|error| format!("chmod {}: {error}", path.display()))?;
    }
    std::fs::write(path, &stamped)
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    if restore {
        std::fs::set_permissions(path, mode)
            .map_err(|error| format!("restore mode on {}: {error}", path.display()))?;
    }
    Ok(Outcome::Stamped)
}
