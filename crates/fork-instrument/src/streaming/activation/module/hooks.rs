use super::*;
use wasm_encoder::reencode::Error;

/// Source operations arrive after branch/local/index lowering. Implementations
/// can compose constructor provenance and table/segment tracking at original
/// program points without introducing a second instruction arena.
pub trait NativeSourceHooks: Reencode {
    fn emit_native_source(
        &mut self,
        _source: &SourceInstruction<'_>,
        instruction: Instruction<'_>,
        output: &mut Function,
        _limit: usize,
    ) -> Result<()>
    where
        Self::Error: std::error::Error + Send + Sync + 'static,
    {
        output.instruction(&instruction);
        Ok(())
    }
}
pub(super) struct Calls<'m, 's, 'a, T> {
    pub catalog: &'m NativeActivations<'a>,
    pub scan: &'s Scan<'a>,
    pub hooks: &'m mut T,
}
macro_rules! index {
    ($name:ident) => {
        fn $name(&mut self, index: u32) -> std::result::Result<u32, Error<Self::Error>> {
            self.hooks.$name(index)
        }
    };
}
impl<T: Reencode> Reencode for Calls<'_, '_, '_, T> {
    type Error = T::Error;
    index!(function_index);
    index!(table_index);
    index!(memory_index);
    index!(global_index);
    index!(tag_index);
    index!(type_index);
    index!(data_index);
    index!(element_index);
    fn instruction<'a>(
        &mut self,
        op: wasmparser::Operator<'a>,
    ) -> std::result::Result<Instruction<'a>, Error<Self::Error>> {
        self.hooks.instruction(op)
    }
}
impl<T: NativeSourceHooks> ContinuationHooks for Calls<'_, '_, '_, T> {
    fn emit_continuation_call(
        &mut self,
        _: u32,
        call: &CallContinuation,
        _: &SourceInstruction<'_>,
        _: &FrameLayout,
        output: &mut Function,
        limit: usize,
    ) -> Result<()>
    where
        Self::Error: std::error::Error + Send + Sync + 'static,
    {
        let (target, source_type) = planning::target(self.scan, self.hooks, call.kind)?;
        let (params, results) = planning::signature(
            self.scan,
            &self.catalog.types,
            self.hooks,
            source_type,
            self.catalog.limits.metadata_bytes,
        )?;
        let transport = self
            .catalog
            .support
            .lookup_transport(target, &params, &results)?;
        output.instruction(&Instruction::Call(transport));
        ensure!(
            output.byte_len() <= limit,
            "activation call exceeds output budget"
        );
        Ok(())
    }
    fn emit_continuation_source(
        &mut self,
        source: &SourceInstruction<'_>,
        instruction: Instruction<'_>,
        _: &FrameLayout,
        output: &mut Function,
        limit: usize,
    ) -> Result<()>
    where
        Self::Error: std::error::Error + Send + Sync + 'static,
    {
        self.hooks
            .emit_native_source(source, instruction, output, limit)
    }
}
