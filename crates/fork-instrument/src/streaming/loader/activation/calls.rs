use super::*;
use wasm_encoder::reencode::Error;

pub(super) fn target(
    mapping: &mut source::Mapping<'_>,
    kind: ReferenceCallKind,
) -> Result<ActivationCallTarget> {
    Ok(match kind {
        ReferenceCallKind::Direct(index) => {
            ActivationCallTarget::Direct(mapping.function_index(index)?)
        }
        ReferenceCallKind::Indirect { table, ty } => ActivationCallTarget::Indirect {
            table: mapping.table_index(table)?,
            signature: mapping.type_index(ty)?,
            table64: mapping.0.table64,
        },
        ReferenceCallKind::Ref { .. } => anyhow::bail!("generated loader has no call_ref"),
    })
}
pub(super) struct Calls<'a> {
    pub mapping: source::Mapping<'a>,
    pub support: &'a FrozenActivationSupport,
}
impl Reencode for Calls<'_> {
    type Error = source::LoaderIndexError;
    fn function_index(&mut self, index: u32) -> std::result::Result<u32, Error<Self::Error>> {
        self.mapping.function_index(index)
    }
    fn type_index(&mut self, index: u32) -> std::result::Result<u32, Error<Self::Error>> {
        self.mapping.type_index(index)
    }
    fn table_index(&mut self, index: u32) -> std::result::Result<u32, Error<Self::Error>> {
        self.mapping.table_index(index)
    }
}
impl ContinuationHooks for Calls<'_> {
    fn emit_continuation_call(
        &mut self,
        _: u32,
        call: &CallContinuation,
        _: &SourceInstruction<'_>,
        _: &FrameLayout,
        output: &mut Function,
        limit: usize,
    ) -> Result<()> {
        let transport =
            self.support
                .lookup_transport(target(&mut self.mapping, call.kind)?, &[], &[])?;
        output.instruction(&Instruction::Call(transport));
        ensure!(
            output.byte_len() <= limit,
            "loader transport exceeds output budget"
        );
        Ok(())
    }
}
