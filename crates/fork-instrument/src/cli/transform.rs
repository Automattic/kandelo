//! Bounded instrumentation, optimization and atomic publication.
use anyhow::{Context, Result};
use fork_instrument::{
    Options,
    artifact_io::MappedArtifact,
    native,
    original_artifact::{OriginalReference, attach_original_reference},
};

#[path = "optimize.rs"]
mod optimize;

pub(super) struct Settings<'a> {
    pub optimize: &'a str,
    pub keep_names: bool,
    pub debug_map: bool,
    pub debug_map_if_present: bool,
    pub output_bytes: u64,
    pub original: Option<&'a OriginalReference>,
}
pub(super) fn run(
    input: &[u8],
    options: &Options,
    settings: Settings<'_>,
) -> Result<MappedArtifact> {
    let limits = native::Limits {
        output_bytes: settings.output_bytes,
        ..Default::default()
    };
    let output = if settings.debug_map {
        native::instrument_with_debug(input, options, limits, Default::default())?
    } else if settings.debug_map_if_present {
        native::instrument_with_optional_debug(input, options, limits, Default::default())?
    } else {
        native::instrument(input, options, limits)?
    };
    if let Some(error) = &output.decision.facts_error {
        eprintln!(
            "wasm-fork-instrument: compiler facts not used ({error}); using bounded native baseline"
        );
    }
    let mut artifact = output.bytes;
    let mut source_map = output.source_map;
    let instrumented = output.decision.participates;
    let optimized = instrumented && settings.optimize != "none";
    if optimized {
        (artifact, source_map) = optimize::run(
            &artifact,
            settings.optimize,
            settings.keep_names,
            settings.output_bytes,
            source_map.as_ref(),
        )?;
    }
    if optimized {
        native::validate(artifact.bytes())
            .context("validating output before atomic publication")?;
    }
    if let Some(original) = settings.original {
        artifact = attach_original_reference(&artifact, original, settings.output_bytes)?;
    }
    if let Some(map) = source_map {
        artifact = fork_instrument::debug_info::attach_map(
            &artifact,
            map.bytes(),
            Default::default(),
            settings.output_bytes,
        )?;
    }
    Ok(artifact)
}
