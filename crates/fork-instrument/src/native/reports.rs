//! Diagnostic reports use original function ordinals, without retaining module instruction bodies.
use crate::{Analysis, Options, SinkReport, call_graph::FuncEntry, native};
use anyhow::{Result, ensure};

pub(crate) fn sinks(input: &[u8], options: &Options) -> Result<SinkReport> {
    let local = crate::streaming::local_continuation::prepare(input, Default::default())?;
    let input = local.as_ref().map_or(input, |artifact| artifact.bytes());
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
pub(crate) fn discover(input: &[u8], options: &Options) -> Result<Analysis> {
    let local = crate::streaming::local_continuation::prepare(input, Default::default())?;
    let input = local.as_ref().map_or(input, |artifact| artifact.bytes());
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
/// For each named function, the shortest call chain that puts it in the
/// instrumented set, as `(function, edge to the next function)` pairs.
pub(crate) fn explain(
    input: &[u8],
    options: &Options,
    targets: &[String],
) -> Result<Vec<(String, Option<Vec<(String, &'static str)>>)>> {
    let local = crate::streaming::local_continuation::prepare(input, Default::default())?;
    let input = local.as_ref().map_or(input, |artifact| artifact.bytes());
    let analysis = native::analyze(input, options, Default::default())?;
    let seeds: std::collections::BTreeSet<u32> =
        analysis.decision.entry_imports.iter().copied().collect();
    let mut out = Vec::new();
    for target in targets {
        let index = analysis
            .scan
            .functions
            .iter()
            .position(|f| f.name.as_deref() == Some(target.as_str()));
        let chain = index.and_then(|index| {
            analysis
                .scan
                .explain(&seeds, &analysis.reaching.activations, index as u32)
        });
        out.push((
            target.clone(),
            chain.map(|chain| {
                chain
                    .into_iter()
                    .map(|(f, edge)| (name(&analysis, f), edge.as_str()))
                    .collect()
            }),
        ));
    }
    Ok(out)
}
fn name(analysis: &native::Analysis<'_>, function: u32) -> String {
    analysis.scan.functions[function as usize]
        .name
        .clone()
        .unwrap_or_else(|| format!("func#{function}"))
}
