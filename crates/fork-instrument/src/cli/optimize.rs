//! Binaryen never receives the destination path. Copy its result into a new
//! immutable snapshot before validation, so an open optimizer handle cannot
//! change bytes after they are inspected or published.
use anyhow::{Context, Result, ensure};
use fork_instrument::artifact_io::MappedArtifact;
use std::{io::Write, path::Path, process::Command};

pub(super) fn run(
    input: &MappedArtifact,
    level: &str,
    keep_names: bool,
    limit: u64,
) -> Result<MappedArtifact> {
    let mut source = tempfile::NamedTempFile::new().context("creating private optimizer input")?;
    source.write_all(input.bytes())?;
    let output = tempfile::NamedTempFile::new().context("creating private optimizer output")?;
    let executable = std::env::var_os("WASM_OPT").unwrap_or_else(|| "wasm-opt".into());
    let mut command = Command::new(&executable);
    command.arg(source.path()).arg(format!("-{level}"));
    if keep_names {
        command.arg("-g");
    }
    command.arg("-o").arg(output.path());
    let status = command.status().with_context(|| format!(
        "running {} after fork instrumentation (Binaryen is required; run inside scripts/dev-shell.sh or set WASM_OPT)",
        Path::new(&executable).display()))?;
    ensure!(
        status.success(),
        "{} -{level} failed on private instrumented output ({status})",
        Path::new(&executable).display()
    );
    Ok(MappedArtifact::read(output.path(), limit)?.0)
}
