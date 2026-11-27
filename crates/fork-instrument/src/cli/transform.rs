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

pub(super) fn preoptimize(input: &MappedArtifact, level: &str, limit: u64) -> Result<MappedArtifact> {
    let (artifact, _) = optimize::run(input, level, true, limit, None, true)?;
    native::validate(artifact.bytes()).context("validating pre-optimized module")?;
    Ok(artifact)
}

pub(super) struct Settings<'a> {
    pub optimize: &'a str,
    pub keep_names: bool,
    pub debug_map: bool,
    pub debug_map_if_present: bool,
    pub output_bytes: u64,
    pub original: Option<&'a OriginalReference>,
    pub require_facts: bool,
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
    if settings.require_facts {
        anyhow::ensure!(
            output.decision.source == fork_instrument::PlanSource::Facts
                && output.decision.facts.as_ref().is_some_and(|facts| facts.bound > 0),
            "fork instrumentation requires compiler facts with linked function bindings (source {}): {}",
            output.decision.source.as_str(),
            output.decision.facts_error.as_deref().unwrap_or(
                "preserve linked code, function names and compiler facts until instrumentation"
            ),
        );
    }
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
            false,
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
