//! Diagnostic reports use original function ordinals, without a Walrus arena.
use anyhow::{Result, ensure};
use fork_instrument::{Analysis, Options, SinkReport, call_graph::FuncEntry, native};

pub(super) fn sinks(input: &[u8], options: &Options) -> Result<SinkReport> {
    let analysis = native::analyze(input, options, Default::default())?;
    let names = |set: &std::collections::BTreeSet<u32>| {
        let mut names: Vec<_> = set
            .iter()
            .filter(|&&function| analysis.scan.functions[function as usize].body.is_some())
            .map(|&function| name(&analysis, function))
            .collect();
        names.sort();
        names
    };
    Ok(SinkReport {
        source: analysis.decision.source,
        instrumented: names(&analysis.reaching.activations),
        boundaries: names(&analysis.boundaries),
        facts: analysis.decision.facts,
        facts_error: analysis.decision.facts_error,
    })
}
pub(super) fn discover(input: &[u8], options: &Options) -> Result<Analysis> {
    let analysis = native::analyze(
        input,
        &Options {
            sinks: false,
            ..options.clone()
        },
        Default::default(),
    )?;
    ensure!(
        analysis.decision.participates,
        "entry import `{}` not found (or not a function) in the module. If this module does not use fork, there is nothing to instrument.",
        options.entry_import
    );
    let mut fork_path: Vec<_> = analysis
        .reaching
        .activations
        .iter()
        .map(|&function| FuncEntry {
            name: name(&analysis, function),
            is_import: function < analysis.scan.imported_functions,
        })
        .collect();
    fork_path.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(Analysis { fork_path })
}
fn name(analysis: &native::Analysis<'_>, function: u32) -> String {
    analysis.scan.functions[function as usize]
        .name
        .clone()
        .unwrap_or_else(|| format!("func#{function}"))
}
