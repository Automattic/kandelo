//! Emission consumes frozen helpers and drops each original body before the
//! next decode. Every source body receives constructor and module-state hooks.
use super::*;
use wasm_encoder::{
    Function, Instruction,
    reencode::{Error, Reencode},
};

pub(super) struct Emitter<'s, 'a> {
    pub scan: &'s Scan<'a>,
    pub components: &'s mut Components<'a>,
    pub ir: IrLimits,
}
macro_rules! remap {
    ($name:ident, $($field:ident).+) => {
        fn $name(&mut self, source: u32) -> Result<u32, Error<Self::Error>> {
            self.$($field).+.$name(source)
        }
    };
}
impl Reencode for Emitter<'_, '_> {
    type Error = ImportIndexError;
    remap!(function_index, components.runtime);
    remap!(table_index, components.runtime);
    remap!(memory_index, components.runtime);
    remap!(global_index, components.runtime);
    remap!(tag_index, components.runtime);
}
impl FunctionTransform for Emitter<'_, '_> {
    fn defer_module_initializers(&self) -> bool {
        true
    }
    fn imports(&self) -> Option<&FrozenImports> {
        Some(self.components.runtime.imports_plan())
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.components.declarations)
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.components.module)
    }
    fn function_ir_limits(&self) -> Option<IrLimits> {
        Some(self.ir)
    }
    fn transform_ir(&mut self, source: &FunctionIr<'_>, limit: usize) -> Result<Function> {
        let components = &mut self.components;
        components.activations.emit_function(
            self.scan,
            source,
            &mut Sources {
                runtime: &mut components.runtime,
                plan: &components.gc_plan,
                constructors: &components.constructors,
                state: &components.state.rewrites,
            },
            limit,
        )
    }
    fn emit_helper(&mut self, mut ordinal: u32, limit: usize) -> Result<Function> {
        let components = &self.components;
        ensure!(
            ordinal < components.declarations.function_count(),
            "unknown native pipeline helper"
        );
        macro_rules! stage {
            ($declarations:expr, $body:expr) => {
                if ordinal < $declarations.function_count() {
                    return $body;
                }
                ordinal -= $declarations.function_count();
            };
        }
        stage!(
            components.runtime.function_declarations(),
            components.runtime.emit_control(ordinal, limit)
        );
        if ordinal < components.loader.declarations().function_count() {
            if ordinal == 0
                && let Some(activation) = &components.loader_activation
            {
                return activation.emit_driver(&components.loader, limit);
            }
            return components.loader.emit_helper(ordinal, limit);
        }
        ordinal -= components.loader.declarations().function_count();
        stage!(
            components.constructors.declarations(),
            components
                .constructors
                .emit_helper(ordinal, &components.gc_plan, limit)
        );
        stage!(
            components.gc.declarations(),
            components
                .gc
                .emit_helper(ordinal, &components.gc_plan, limit)
        );
        stage!(
            components.exception.declarations(),
            components.exception.emit_helper(ordinal, limit)
        );
        let state_count = components
            .state
            .declarations()
            .iter()
            .map(|part| part.function_count())
            .sum::<u32>();
        if ordinal < state_count {
            return components.state.emit_helper(ordinal, limit);
        }
        ordinal -= state_count;
        stage!(
            components.activations.declarations(),
            components.activations.emit_helper(ordinal, limit)
        );
        if let Some(activation) = &components.loader_activation {
            stage!(
                activation.declarations(),
                activation.emit_helper(ordinal, limit)
            );
        }
        components.catalogs.roots.emit_helper(ordinal, limit)
    }
}

struct Sources<'a> {
    runtime: &'a mut NativeRuntime,
    plan: &'a NativeGcPlan,
    constructors: &'a FrozenGcConstructors,
    state: &'a FrozenStateRewrites,
}
impl Reencode for Sources<'_> {
    type Error = ImportIndexError;
    remap!(function_index, runtime);
    remap!(table_index, runtime);
    remap!(memory_index, runtime);
    remap!(global_index, runtime);
    remap!(tag_index, runtime);
    remap!(type_index, runtime);
    remap!(data_index, runtime);
    remap!(element_index, runtime);
}
impl NativeSourceHooks for Sources<'_> {
    fn emit_native_source(
        &mut self,
        source: &SourceInstruction<'_>,
        instruction: Instruction<'_>,
        output: &mut Function,
        limit: usize,
    ) -> Result<()> {
        let instruction = match self
            .constructors
            .replacement(self.plan, &source.operation)?
        {
            Some(helper) => Instruction::Call(helper),
            None => instruction,
        };
        self.state.emit_source(source, instruction, output, limit)
    }
}
