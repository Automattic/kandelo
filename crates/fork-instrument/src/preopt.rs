//! Stock Binaryen pre-optimization over private bounded artifacts.
//! Original compiler facts must never survive a code rewrite.
use crate::artifact_io::{MappedArtifact, copy_without_custom};
use anyhow::{Context, Result, ensure};
use std::{io::Write, path::Path, process::Command};

pub const SECTION: &str = "metadata.code.kandelo.fork-targets";
pub const REPORT_SECTION: &str = "kandelo.fork-facts.report";

pub fn prepare_wasm(input: &[u8], output: &mut impl Write) -> Result<()> {
    let identity = crate::contract_inventory::artifact_identity(input)?;
    ensure!(
        identity.relocatable == 0 && identity.dylink_section_count == 0,
        "pre-optimization requires a main executable"
    );
    ensure!(
        identity.memory64_count == 0,
        "pre-optimization currently supports wasm32 only"
    );
    let scan = crate::streaming::scan(input)?;
    crate::native::admission::reject_instrumented(&scan)?;
    copy_without_custom(input, output, |name| {
        matches!(
            name,
            SECTION | REPORT_SECTION | crate::facts::SECTION | crate::facts::CODE_HASH_SECTION
        ) || name.starts_with(".debug_")
            || name.starts_with(".zdebug_")
    })
}

pub fn run(input: &MappedArtifact, level: &str, limit: u64) -> Result<MappedArtifact> {
    ensure!(
        matches!(level, "O2" | "Oz"),
        "unsupported pre-optimization profile"
    );
    let mut source =
        tempfile::NamedTempFile::new().context("creating private pre-optimizer input")?;
    prepare_wasm(input.bytes(), &mut source)?;
    let output = tempfile::NamedTempFile::new().context("creating private pre-optimizer output")?;
    let executable = std::env::var_os("WASM_OPT").unwrap_or_else(|| "wasm-opt".into());
    let status = Command::new(&executable)
        .arg(source.path())
        .arg(format!("-{level}"))
        .args(["--partial-inlining-ifs=0", "--no-stack-ir", "-g"])
        .arg("-o")
        .arg(output.path())
        .status()
        .with_context(|| {
            format!(
                "running {} before fork instrumentation",
                Path::new(&executable).display()
            )
        })?;
    ensure!(
        status.success(),
        "pre-optimization {level} failed ({status})"
    );
    let artifact = MappedArtifact::read(output.path(), limit)?.0;
    crate::native::validate(artifact.bytes()).context("validating pre-optimized module")?;
    Ok(artifact)
}
