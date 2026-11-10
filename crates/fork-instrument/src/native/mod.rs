//! Instrumentation policy and artifact admission over exact source bytes.
use crate::{
    PlanSource,
    facts::{FactsReport, storage::StorageLimits},
    streaming::*,
};
use std::collections::BTreeSet;

mod admission;
pub use admission::reject_instrumented_input;
mod analysis;
mod instrument;
mod metadata;
pub(crate) mod reports;
pub use analysis::analyze;
pub use instrument::{
    Artifact, Limits, instrument, instrument_with_debug, instrument_with_optional_debug, validate,
};

#[derive(Clone, Copy, Debug, Default)]
pub struct AnalysisLimits {
    pub storage: StorageLimits,
    pub program: sink::ProgramLimits,
    pub sinks: sink::SinkLimits,
}

#[derive(Debug)]
pub struct Decision {
    pub participates: bool,
    pub side_module: bool,
    pub dynamic_linker: bool,
    pub entry_imports: Vec<u32>,
    pub source: PlanSource,
    pub facts: Option<FactsReport>,
    pub facts_error: Option<String>,
    pub dlopen_contract: Option<String>,
}

/// Original identities stay stable across facts, sinks and function emission.
/// The private facts database is released before this result is returned.
pub struct Analysis<'a> {
    pub scan: Scan<'a>,
    pub reaching: ReachingPlan,
    pub boundaries: BTreeSet<u32>,
    pub decision: Decision,
    /// Set when the module imports a checkpoint seed.
    pub cover: Option<checkpoint::Cover>,
}

impl<'a> Analysis<'a> {
    /// Carry the plan over to `covered`, this module after
    /// [`checkpoint::cover`]. Function indices are unchanged, and the
    /// rewrite adds no tail call, so each tail site keeps its ordinal.
    pub fn rebase<'b>(self, covered: &'b [u8]) -> anyhow::Result<Analysis<'b>> {
        let scan = scan(covered)?;
        let tail_sites = self
            .reaching
            .tail_sites
            .iter()
            .map(|point| {
                let tails = |scan: &Scan<'_>| {
                    scan.functions
                        .get(point.function as usize)
                        .and_then(|function| function.body.as_ref())
                        .map(|body| body.tails.iter().map(|tail| tail.point).collect::<Vec<_>>())
                        .unwrap_or_default()
                };
                let ordinal = tails(&self.scan).iter().position(|tail| tail == point);
                ordinal
                    .and_then(|ordinal| tails(&scan).get(ordinal).copied())
                    .ok_or_else(|| anyhow::anyhow!("checkpoint coverage moved a tail site"))
            })
            .collect::<anyhow::Result<_>>()?;
        Ok(Analysis {
            scan,
            reaching: ReachingPlan {
                activations: self.reaching.activations,
                control_reachable: self.reaching.control_reachable,
                tail_sites,
            },
            boundaries: self.boundaries,
            decision: self.decision,
            cover: None,
        })
    }

    /// Complete the frozen native assembly after releasing analysis storage.
    /// Nonparticipating modules take the separate unchanged-copy path.
    pub fn freeze(self, limits: PipelineLimits) -> anyhow::Result<(NativePipeline<'a>, Decision)> {
        anyhow::ensure!(
            self.decision.participates,
            "module does not participate in a fork transaction"
        );
        let pipeline = NativePipeline::plan(
            self.scan,
            self.reaching,
            PipelineOptions {
                shared_codecs: true,
                boundaries: self.boundaries,
                side_module: self.decision.side_module,
                ..Default::default()
            },
            limits,
        )?;
        Ok((pipeline, self.decision))
    }
}
