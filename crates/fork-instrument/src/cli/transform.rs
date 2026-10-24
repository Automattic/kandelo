//! Backend selection and atomic publication share one file lifecycle.
use anyhow::{Context, Result, bail};
use fork_instrument::{Options, artifact_io::MappedArtifact, native};
use std::{fs::Permissions, path::Path};
use wasmparser::{Parser, Payload};

#[path = "optimize.rs"]
mod optimize;

pub(super) struct Settings<'a> {
    pub backend: &'a str,
    pub optimize: &'a str,
    pub keep_names: bool,
    pub output_bytes: u64,
}
pub(super) fn run(
    input: &[u8],
    options: &Options,
    destination: &Path,
    permissions: Permissions,
    settings: Settings<'_>,
) -> Result<()> {
    let (mut artifact, instrumented) = match settings.backend {
        "native" => {
            let output = native::instrument(
                input,
                options,
                native::Limits {
                    output_bytes: settings.output_bytes,
                    ..Default::default()
                },
            )?;
            if let Some(error) = &output.decision.facts_error {
                eprintln!(
                    "wasm-fork-instrument: compiler facts not used ({error}); using bounded native baseline"
                );
            }
            (output.bytes, output.decision.participates)
        }
        "walrus" => {
            // The oracle API intentionally retains its Vec result. Only its
            // surrounding publication path changes; its algorithms do not.
            let output = fork_instrument::instrument(input, options)?;
            let mut instrumented = false;
            for payload in Parser::new(0).parse_all(&output) {
                if matches!(payload?, Payload::CustomSection(section)
                    if section.name() == wasm_posix_shared::abi::WPK_FORK_CAPABILITIES_SECTION)
                {
                    instrumented = true;
                    break;
                }
            }
            (
                MappedArtifact::snapshot(output.as_slice(), settings.output_bytes)?,
                instrumented,
            )
        }
        other => bail!("unknown instrumentation backend {other}"),
    };
    let optimized = instrumented && settings.optimize != "none";
    if optimized {
        artifact = optimize::run(
            &artifact,
            settings.optimize,
            settings.keep_names,
            settings.output_bytes,
        )?;
    }
    if optimized || settings.backend == "walrus" {
        native::validate(artifact.bytes())
            .context("validating output before atomic publication")?;
    }
    artifact.publish(destination, permissions)
}
