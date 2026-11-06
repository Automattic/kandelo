//! Bounded instrumentation, optimization and atomic publication.
use anyhow::{Context, Result};
use fork_instrument::{Options, artifact_io::MappedArtifact, native, original_artifact::{OriginalReference, attach_original_reference}};

#[path = "optimize.rs"]
mod optimize;

pub(super) struct Settings<'a> {
    pub optimize: &'a str,
    pub keep_names: bool,
    pub output_bytes: u64,
    pub original: Option<&'a OriginalReference>,
}
pub(super) fn run(
    input: &[u8],
    options: &Options,
    settings: Settings<'_>,
) -> Result<MappedArtifact> {
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
    let mut artifact = output.bytes;
    let instrumented = output.decision.participates;
    let optimized = instrumented && settings.optimize != "none";
    if optimized {
        artifact = optimize::run(
            &artifact,
            settings.optimize,
            settings.keep_names,
            settings.output_bytes,
        )?;
    }
    if optimized {
        native::validate(artifact.bytes())
            .context("validating output before atomic publication")?;
    }
    if let Some(original) = settings.original {
        artifact = attach_original_reference(&artifact, original, settings.output_bytes)?;
    }
    Ok(artifact)
}
