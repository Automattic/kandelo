use fork_instrument::streaming::*;
use std::collections::BTreeMap;
use wasm_encoder::{
    Function, Instruction,
    reencode::{Error, Reencode},
};

struct CallHooks<'a> {
    runtime: &'a mut NativeRuntime,
    routes: &'a [(ReferenceCallKind, u32)],
}
macro_rules! index {
    ($name:ident) => {
        fn $name(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
            self.runtime.$name(i)
        }
    };
}
impl Reencode for CallHooks<'_> {
    type Error = ImportIndexError;
    index!(function_index);
    index!(table_index);
    index!(memory_index);
    index!(global_index);
    index!(tag_index);
    index!(type_index);
}
impl ContinuationHooks for CallHooks<'_> {
    fn emit_continuation_call(
        &mut self,
        _: u32,
        call: &CallContinuation,
        _: &SourceInstruction<'_>,
        _: &FrameLayout,
        output: &mut Function,
        _: usize,
    ) -> anyhow::Result<()> {
        let target =
            if let Some((_, target)) = self.routes.iter().find(|(kind, _)| *kind == call.kind) {
                *target
            } else if let ReferenceCallKind::Direct(source) = call.kind {
                self.runtime.function_index(source)?
            } else {
                anyhow::bail!("fixture has no frozen route for {:?}", call.kind);
            };
        output.instruction(&Instruction::Call(target));
        Ok(())
    }
}
/// Test composition only: fixtures retain a few local plans so they can be
/// emitted twice for determinism checks. Production must discard each plan.
pub struct ActivationModule {
    pub runtime: NativeRuntime,
    pub support: FrozenActivationSupport,
    pub codecs: FrozenFrameCodecs,
    pub declarations: FrozenDeclarations,
    pub module: FrozenModuleDeclarations,
    pub plans: BTreeMap<u32, NativeActivationPlan>,
    pub emission: BTreeMap<u32, ActivationEmission>,
    pub routes: Vec<(ReferenceCallKind, u32)>,
    pub tails: BTreeMap<u32, TailTransferPlan>,
}
impl Reencode for ActivationModule {
    type Error = ImportIndexError;
    index!(function_index);
    index!(table_index);
    index!(memory_index);
    index!(global_index);
    index!(tag_index);
    index!(type_index);
}
impl FunctionTransform for ActivationModule {
    fn imports(&self) -> Option<&FrozenImports> {
        Some(self.runtime.imports_plan())
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.declarations)
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.module)
    }
    fn function_ir_limits(&self) -> Option<IrLimits> {
        Some(Default::default())
    }
    fn transform_ir(&mut self, body: &FunctionIr<'_>, limit: usize) -> anyhow::Result<Function> {
        if let Some(plan) = self.plans.get(&body.function) {
            emit_native_activation(
                body,
                plan,
                self.emission[&body.function],
                &mut CallHooks {
                    runtime: &mut self.runtime,
                    routes: &self.routes,
                },
                DispatchLimits {
                    output_bytes: limit,
                    ..Default::default()
                },
            )
        } else if let Some(tails) = self.tails.get(&body.function) {
            tails.emit_function(body, &mut self.runtime, limit)
        } else {
            body.emit(self, limit)
        }
    }
    fn emit_helper(&mut self, ordinal: u32, limit: usize) -> anyhow::Result<Function> {
        if ordinal < 7 {
            self.runtime.emit_control(ordinal, limit)
        } else if ordinal < 7 + self.support.declarations().function_count() {
            self.support.emit_helper(ordinal - 7, limit)
        } else {
            self.codecs.emit_helper(
                ordinal - 7 - self.support.declarations().function_count(),
                limit,
            )
        }
    }
}
