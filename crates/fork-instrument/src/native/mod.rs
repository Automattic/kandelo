//! Instrumentation policy and artifact admission over exact source bytes.
use crate::{
    PlanSource,
    facts::{FactsReport, storage::StorageLimits},
    streaming::*,
};
use std::collections::BTreeSet;

pub(crate) mod admission;
mod analysis;
mod instrument;
mod metadata;
pub(crate) mod reports;
pub use analysis::analyze;
pub use instrument::{Artifact, Limits, instrument, validate};

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
}

impl<'a> Analysis<'a> {
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
