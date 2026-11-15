//! Binaryen never receives the destination path. Copy its result into a new
//! immutable snapshot before validation, so an open optimizer handle cannot
//! change bytes after they are inspected or published.
use anyhow::{Context, Result, ensure};
use fork_instrument::artifact_io::MappedArtifact;
use std::{io::Write, path::Path, process::Command};

/// [RUNTIME-WORKAROUND: BINARYEN-133-CONSTRAINT-ANALYSIS] Binaryen 133
/// runs its new `constraint-analysis` pass at -O3, -O4, -Os and -Oz (the
/// default `--post-optimize` level is Os), and the pass aborts on code LLVM
/// 23 emits (FFmpeg's `ff_spatial_dwt`, instrumented or not). The fix,
/// WebAssembly/binaryen#9258, is in no release yet. The pass also had a run
/// of wrong-code fixes before 133, and it measured no worthwhile size or
/// speed win on Kandelo's programs, so Kandelo skips it. Re-enabling it is
/// a separate, re-measured decision: see
/// tests/runtime-workarounds/BINARYEN-133-CONSTRAINT-ANALYSIS/entry.md and
/// "Revisit Binaryen's constraint-analysis pass" in
/// docs/future-improvements.md. The SDK's post-link wasm-opt carries the same
/// flag (crates/kandelo-cc/src/driver.rs).
///
/// wasm-opt accepts `--skip-pass` with a pass name it does not know, so the
/// flag is harmless with a Binaryen that lacks the pass and at levels that
/// do not schedule it.
pub(super) const SKIP_CONSTRAINT_ANALYSIS: &str = "--skip-pass=constraint-analysis";

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
    command
        .arg(source.path())
        .arg(format!("-{level}"))
        // [RUNTIME-WORKAROUND: BINARYEN-133-CONSTRAINT-ANALYSIS] at every level.
        .arg(SKIP_CONSTRAINT_ANALYSIS);
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
