//! Production entry selection and sink decisions without a module body arena.
use super::*;
use crate::{
    Options, SideModules,
    facts::{FactsOptions, storage::FactsStore},
    sink::SinkPolicy,
};
use anyhow::{Context, Result, ensure};

pub fn analyze<'a>(
    input: &'a [u8],
    options: &Options,
    limits: AnalysisLimits,
) -> Result<Analysis<'a>> {
    let scan = scan(input)?;
    admission::reject_instrumented(&scan)?;
    ensure!(
        scan.functions.len() <= limits.program.metadata_bytes / 128,
        "native entry selection exceeds metadata budget"
    );
    let side_module =
        options.entry_import == "env.fork" || scan.custom_data("dylink.0").next().is_some();
    let mut entry_imports = Vec::new();
    let mut seeds = Vec::new();
    let mut dynamic_linker = false;
    for (index, source) in scan.functions.iter().enumerate() {
        let Some((module, name)) = &source.import else {
            continue;
        };
        let index = u32::try_from(index)?;
        let entry = options
            .entry_import
            .split_once('.')
            .is_some_and(|(m, n)| m == module && n == name);
        if entry {
            entry_imports.push(index);
        }
        dynamic_linker |= crate::call_graph::is_dynamic_linker_function_import(module, name);
        if side_module || entry || (module == "env" && name == "__wasm_dlopen") {
            seeds.push(index);
        }
    }
    let participates = side_module || dynamic_linker || !entry_imports.is_empty();
    let reaching = if participates {
        scan.reaching_from_seeds(seeds, side_module || dynamic_linker)?
    } else {
        ReachingPlan {
            activations: BTreeSet::new(),
            control_reachable: BTreeSet::new(),
            tail_sites: BTreeSet::new(),
        }
    };
    let mut analysis = Analysis {
        scan,
        reaching,
        boundaries: BTreeSet::new(),
        decision: Decision {
            participates,
            side_module,
            dynamic_linker,
            entry_imports,
            source: PlanSource::Closure,
            facts: None,
            facts_error: None,
            dlopen_contract: None,
        },
    };
    if participates
        && options.sinks
        && !side_module
        && options.entry_import == "kernel.kernel_fork"
        && analysis.decision.entry_imports.len() == 1
    {
        refine(&mut analysis, options, limits)?;
    }
    Ok(analysis)
}

fn refine(analysis: &mut Analysis<'_>, options: &Options, limits: AnalysisLimits) -> Result<()> {
    let progress = crate::progress::Progress::new("analysis");
    let seed = analysis.decision.entry_imports[0];
    if options.facts
        && analysis
            .scan
            .custom_data(crate::facts::SECTION)
            .next()
            .is_some()
    {
        match facts_plan(analysis, seed, options, limits) {
            Ok((plan, report, mode)) => {
                if analysis.decision.dynamic_linker {
                    analysis.decision.dlopen_contract = Some(dlopen_contract(
                        &analysis.scan,
                        &plan,
                        mode,
                        limits.program.metadata_bytes,
                    )?);
                }
                apply(analysis, plan);
                analysis.decision.source = PlanSource::Facts;
                analysis.decision.facts = Some(report);
                return Ok(());
            }
            Err(error) => {
                progress.note(format_args!(
                    "unavailable: {error:#}; trying builtin analysis"
                ));
                analysis.decision.facts_error = Some(format!("{error:#}"));
            }
        }
    }
    let mut store = FactsStore::empty(limits.storage)?;
    let mut program = sink::Program::build(&analysis.scan, &mut store, limits.program)?;
    let dynamic = analysis.decision.dynamic_linker;
    let mut mode = options.side_modules;
    program.dynamic_linking &= mode != SideModules::TracedEntries;
    if let Some(mut plan) = sink::plan_sinks(
        &mut program,
        seed,
        &analysis.reaching,
        SinkPolicy::default(),
        limits.sinks,
    )? {
        if dynamic && mode == SideModules::TracedEntries && address_taken(&analysis.scan, &plan) {
            program.dynamic_linking = true;
            mode = SideModules::AssumeAllEntriesForkReturning;
            let Some(full) = sink::plan_sinks(
                &mut program,
                seed,
                &analysis.reaching,
                SinkPolicy::default(),
                limits.sinks,
            )?
            else {
                return Ok(());
            };
            plan = full;
        }
        drop(program);
        if dynamic {
            analysis.decision.dlopen_contract = Some(dlopen_contract(
                &analysis.scan,
                &plan,
                mode,
                limits.program.metadata_bytes,
            )?);
        }
        apply(analysis, plan);
        analysis.decision.source = PlanSource::Builtin;
    }
    Ok(())
}

fn facts_plan(
    analysis: &Analysis<'_>,
    seed: u32,
    options: &Options,
    limits: AnalysisLimits,
) -> Result<(sink::NativeSinkPlan, FactsReport, SideModules)> {
    ensure!(
        !(0..analysis.scan.types.as_ref().memory_count()).any(|memory| analysis
            .scan
            .types
            .as_ref()
            .memory_at(memory)
            .memory64),
        "the facts analysis models wasm32 only"
    );
    let progress = crate::progress::Progress::new("facts");
    progress.note(format_args!("load"));
    let mut store = FactsStore::from_scan(&analysis.scan, limits.storage)?;
    progress.note(format_args!("resolve calls"));
    let report = store.resolve_calls(
        &analysis.scan,
        FactsOptions {
            effective_types: options.effective_types,
        },
    )?;
    progress.note(format_args!("program summaries"));
    let mut program = sink::Program::build(&analysis.scan, &mut store, limits.program)?;
    progress.note(format_args!("sink plan"));
    let mut mode = options.side_modules;
    let dynamic_linking = program.dynamic_linking;
    program.dynamic_linking &= mode != SideModules::TracedEntries;
    let first = sink::plan_sinks(
        &mut program,
        seed,
        &analysis.reaching,
        SinkPolicy::default(),
        limits.sinks,
    )?
    .context("the facts analysis could not model this module")?;
    if dynamic_linking
        && mode == SideModules::TracedEntries
        && address_taken(&analysis.scan, &first)
    {
        // WHY: a returning function pointer can enter an untraced side module.
        // Preserve loading by selecting the conservative full-entry contract.
        program.dynamic_linking = true;
        mode = SideModules::AssumeAllEntriesForkReturning;
        let plan = sink::plan_sinks(
            &mut program,
            seed,
            &analysis.reaching,
            SinkPolicy::default(),
            limits.sinks,
        )?
        .context("full-entry facts analysis could not model this module")?;
        Ok((plan, report, mode))
    } else {
        Ok((first, report, mode))
    }
}

fn apply(analysis: &mut Analysis<'_>, plan: sink::NativeSinkPlan) {
    analysis.reaching.activations.retain(|function| {
        *function < analysis.scan.imported_functions || plan.activations.contains(function)
    });
    analysis.reaching.control_reachable.retain(|function| {
        *function < analysis.scan.imported_functions || plan.control_reachable.contains(function)
    });
    analysis.reaching.tail_sites.retain(|point| {
        analysis
            .reaching
            .control_reachable
            .contains(&point.function)
    });
    analysis.boundaries = plan
        .boundaries
        .into_iter()
        .filter(|function| analysis.reaching.activations.contains(function))
        .collect();
}

fn address_taken(scan: &Scan<'_>, plan: &sink::NativeSinkPlan) -> bool {
    scan.elements.iter().flat_map(|element| &element.items)
        .any(|value| matches!(value, ValueProof::Function(function) if plan.fork_returning.contains(function)))
}
fn dlopen_contract(
    scan: &Scan<'_>,
    plan: &sink::NativeSinkPlan,
    mode: SideModules,
    budget: usize,
) -> Result<String> {
    let mut text = format!(
        "v1\nmode\t{}\naddress-taken\t{}\n",
        mode.as_str(),
        u8::from(address_taken(scan, plan))
    );
    let mut names = BTreeSet::new();
    let mut used = text.len();
    for name in scan.exports.iter().filter_map(|(name, kind, index)| {
        (*kind == wasmparser::ExternalKind::Func && plan.fork_returning.contains(index))
            .then_some(name)
    }) {
        if !names.contains(name) {
            used = used
                .checked_add(name.len())
                .and_then(|bytes| bytes.checked_add(64))
                .context("dlopen contract size overflow")?;
            ensure!(used <= budget, "dlopen contract exceeds metadata budget");
            names.insert(name);
        }
    }
    for name in names {
        text.push_str("fork-returning\t");
        text.push_str(name);
        text.push('\n');
    }
    Ok(text)
}
