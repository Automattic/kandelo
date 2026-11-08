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
    source_map: Option<&MappedArtifact>,
) -> Result<(MappedArtifact, Option<MappedArtifact>)> {
    let mut source = tempfile::NamedTempFile::new().context("creating private optimizer input")?;
    source.write_all(input.bytes())?;
    let output = tempfile::NamedTempFile::new().context("creating private optimizer output")?;
    let executable = std::env::var_os("WASM_OPT").unwrap_or_else(|| "wasm-opt".into());
    let mut command = Command::new(&executable);
    let mut map_input = None;
    let mut map_output = None;
    if let Some(map) = source_map {
        // Generated helper bodies intentionally have no user source rows.
        // Keep the mapped call sites: inlining a helper would replace that
        // call with its unmapped body inside the user's function.
        // The mark covers both full and partial inlining, before -O runs.
        command.arg("--no-inline=*");
        let mut source =
            tempfile::NamedTempFile::new().context("creating private optimizer map input")?;
        source.write_all(map.bytes())?;
        let output =
            tempfile::NamedTempFile::new().context("creating private optimizer map output")?;
        command
            .arg("--input-source-map")
            .arg(source.path())
            .arg("--output-source-map")
            .arg(output.path());
        map_input = Some(source);
        map_output = Some(output);
    }
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
    drop(map_input);
    let map = map_output
        .map(|map| {
            MappedArtifact::read(
                map.path(),
                fork_instrument::debug_info::Limits::default().section_bytes as u64,
            )
            .map(|(bytes, _)| bytes)
        })
        .transpose()?;
    Ok((MappedArtifact::read(output.path(), limit)?.0, map))
}
