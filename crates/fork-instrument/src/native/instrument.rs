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
}

pub fn instrument(input: &[u8], options: &Options, mut limits: Limits) -> Result<Artifact> {
    #[cfg(feature = "size-attribution")]
    anyhow::ensure!(
        std::env::var_os("WPK_FORK_SIZE_ATTRIBUTION").is_none(),
        "native size attribution is not implemented; select the explicit Walrus backend for that report"
    );
    let analysis = analyze(input, options, limits.analysis)?;
    let mut raw = ArtifactSpool::new(limits.output_bytes)?;
    if !analysis.decision.participates {
        copy_without_custom(input, &mut raw, |name| {
            name == crate::facts::SECTION || name == crate::facts::CODE_HASH_SECTION
        })?;
        return Ok(Artifact {
            bytes: raw.freeze()?,
            decision: analysis.decision,
            emission: None,
        });
    }
    limits.pipeline.emission.max_spooled_section_bytes = limits
        .pipeline
        .emission
        .max_spooled_section_bytes
        .min(limits.output_bytes);
    let (mut pipeline, decision) = analysis.freeze(limits.pipeline)?;
    let emission = pipeline.emit(&mut raw)?;
    metadata::write(
        pipeline.runtime(),
        &decision,
        options,
        &mut raw,
        limits.pipeline.metadata_bytes,
    )?;
    drop(pipeline);
    let raw = raw.freeze()?;
    let mut declared = ArtifactSpool::new(limits.output_bytes)?;
    crate::target_features::write_declared_features(
        raw.bytes(),
        &mut declared,
        limits.pipeline.emission.max_metadata_section_bytes,
    )?;
    drop(raw);
    let bytes = declared.freeze()?;
    validate(bytes.bytes())?;
    Ok(Artifact {
        bytes,
        decision,
        emission: Some(emission),
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
