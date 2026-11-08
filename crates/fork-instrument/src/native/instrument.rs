//! Full native emission uses bounded private files through feature declaration
//! and serial validation. The production host still validates the ABI contract.
use super::{AnalysisLimits, Decision, analyze, metadata};
use crate::{
    Options,
    artifact_io::{ArtifactSpool, MappedArtifact, copy_without_custom},
    streaming::{EmitReport, PipelineLimits, features},
};
use anyhow::{Context, Result, bail};
use wasmparser::{Encoding, Parser, Payload, ValidPayload, Validator};

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub analysis: AnalysisLimits,
    pub pipeline: PipelineLimits,
    pub output_bytes: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            analysis: Default::default(),
            pipeline: Default::default(),
            output_bytes: 8 * 1024 * 1024 * 1024,
        }
    }
}
pub struct Artifact {
    pub bytes: MappedArtifact,
    pub decision: Decision,
    pub emission: Option<EmitReport>,
    /// Source-map v3 for these exact bytes, when explicitly requested. No map
    /// is allocated or parsed in the default instrumentation path.
    pub source_map: Option<MappedArtifact>,
}

pub fn instrument(input: &[u8], options: &Options, limits: Limits) -> Result<Artifact> {
    instrument_inner(input, options, limits, None)
}

pub fn instrument_with_debug(
    input: &[u8],
    options: &Options,
    limits: Limits,
    debug: crate::debug_info::Limits,
) -> Result<Artifact> {
    instrument_inner(input, options, limits, Some((debug, true)))
}

/// Preserve available source locations while admitting builds without DWARF.
/// Present but malformed or over-budget metadata is an error.
pub fn instrument_with_optional_debug(
    input: &[u8],
    options: &Options,
    limits: Limits,
    debug: crate::debug_info::Limits,
) -> Result<Artifact> {
    instrument_inner(input, options, limits, Some((debug, false)))
}

fn instrument_inner(
    input: &[u8],
    options: &Options,
    mut limits: Limits,
    debug: Option<(crate::debug_info::Limits, bool)>,
) -> Result<Artifact> {
    let lines = debug
        .map(|(debug, required)| {
            if required {
                crate::debug_info::LineTable::read(input, debug).map(Some)
            } else {
                crate::debug_info::LineTable::read_if_present(input, debug)
            }
        })
        .transpose()?
        .flatten()
        .map(std::sync::Arc::new);
    let progress = crate::progress::Progress::new("transform");
    progress.note(format_args!("analysis, {} input bytes", input.len()));
    let analysis = analyze(input, options, limits.analysis)?;
    let mut raw = ArtifactSpool::new(limits.output_bytes)?;
    if !analysis.decision.participates {
        copy_without_custom(input, &mut raw, |name| {
            name == crate::facts::SECTION
                || name == crate::facts::CODE_HASH_SECTION
                || name == crate::debug_info::SECTION
        })?;
        let bytes = raw.freeze()?;
        let source_map = lines
            .as_ref()
            .map(|lines| {
                lines.copied_map(input, bytes.bytes(), debug.unwrap().0.section_bytes as u64)
            })
            .transpose()?;
        return Ok(Artifact {
            bytes,
            decision: analysis.decision,
            emission: None,
            source_map,
        });
    }
    limits.pipeline.emission.max_spooled_section_bytes = limits
        .pipeline
        .emission
        .max_spooled_section_bytes
        .min(limits.output_bytes);
    progress.note(format_args!("freeze plan"));
    let (mut pipeline, decision) = analysis.freeze(limits.pipeline)?;
    if let Some(lines) = &lines {
        pipeline.enable_debug(debug.unwrap().0.rows, lines.clone())?;
    }
    progress.note(format_args!("emission"));
    let emission = pipeline.emit(&mut raw)?;
    metadata::write(
        pipeline.runtime(),
        &decision,
        options,
        &mut raw,
        limits.pipeline.metadata_bytes,
    )?;
    let debug_records = pipeline.take_debug();
    drop(pipeline);
    let raw = raw.freeze()?;
    progress.note(format_args!("declare features"));
    let mut declared = ArtifactSpool::new(limits.output_bytes)?;
    crate::target_features::write_declared_features(
        raw.bytes(),
        &mut declared,
        limits.pipeline.emission.max_metadata_section_bytes,
    )?;
    drop(raw);
    let bytes = declared.freeze()?;
    progress.note(format_args!(
        "validate, {} output bytes",
        bytes.bytes().len()
    ));
    validate(bytes.bytes())?;
    let source_map = debug_records
        .map(|records| records.finish(bytes.bytes(), debug.unwrap().0.section_bytes as u64))
        .transpose()?;
    progress.note(format_args!("complete"));
    Ok(Artifact {
        bytes,
        decision,
        emission: Some(emission),
        source_map,
    })
}

/// Validate immediately and recycle one function validator's scratch. Unlike
/// whole-module validation helpers, no queue of pending body validators exists.
pub fn validate(input: &[u8]) -> Result<()> {
    let mut parser = Parser::new(0);
    parser.set_features(features());
    let mut validator = Validator::new_with_features(features());
    let mut allocations = Default::default();
    for payload in parser.parse_all(input) {
        let payload = payload?;
        if let Payload::Version { encoding, .. } = &payload {
            anyhow::ensure!(*encoding == Encoding::Module, "expected a core Wasm module");
        }
        match validator
            .payload(&payload)
            .context("validating native artifact")?
        {
            ValidPayload::Func(function, body) => {
                let mut function = function.into_validator(allocations);
                function
                    .validate(&body)
                    .context("validating emitted function")?;
                allocations = function.into_allocations();
            }
            ValidPayload::Parser(_) => bail!("expected a core Wasm module"),
            ValidPayload::End(_) | ValidPayload::Ok => {}
        }
    }
    Ok(())
}
