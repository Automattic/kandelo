use super::*;

/// Independent catalog/body limits remain explicit. Their bounded sum, plus
/// the scanner's compact source summaries, bounds resident planning storage.
#[derive(Clone, Copy, Debug)]
pub struct PipelineLimits {
    pub metadata_bytes: usize,
    pub state_rewrite_work: usize,
    pub gc_plan: GcPlanLimits,
    pub constructors: GcConstructorLimits,
    pub gc_codec: GcCodecLimits,
    pub exceptions: ExceptionCodecLimits,
    pub loader: LoaderLimits,
    pub bootstrap: BootstrapLimits,
    pub roots: RootStateLimits,
    pub tables: TableStateLimits,
    pub static_roots: StaticRootLimits,
    pub activations: ActivationModuleLimits,
    pub emission: EmitLimits,
}
impl Default for PipelineLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: crate::limits::MODULE_METADATA_BYTES,
            state_rewrite_work: crate::limits::TOTAL_WORK,
            gc_plan: Default::default(),
            constructors: Default::default(),
            gc_codec: Default::default(),
            exceptions: Default::default(),
            loader: Default::default(),
            bootstrap: Default::default(),
            roots: Default::default(),
            tables: Default::default(),
            static_roots: Default::default(),
            activations: Default::default(),
            emission: Default::default(),
        }
    }
}
