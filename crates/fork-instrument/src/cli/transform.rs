//! Bounded instrumentation, optimization and atomic publication.
use anyhow::{Context, Result};
use fork_instrument::{Options, native};
use std::{fs::Permissions, path::Path};

#[path = "optimize.rs"]
mod optimize;

pub(super) struct Settings<'a> {
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
    artifact.publish(destination, permissions)
}
