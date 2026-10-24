//! One-body emission for the shared real-provider test factory.
use super::{roots, tables};
use fork_instrument::streaming::*;
use wasm_encoder::{
    Function, Instruction,
    reencode::{Error, Reencode},
};
pub(super) struct Provider<'s, 'a> {
    pub(super) scan: &'s Scan<'a>,
    pub(super) activations: Option<NativeActivations<'a>>,
    pub(super) runtime: NativeRuntime,
    pub(super) plan: NativeGcPlan,
    pub(super) constructors: FrozenGcConstructors,
    pub(super) gc: NativeGcCodec,
    pub(super) exception: NativeExceptionCodec,
    pub(super) first_gc: u32,
    pub(super) first_exception: u32,
    pub(super) roots: Option<roots::Components>,
    pub(super) tables: Option<tables::Components>,
    pub(super) declarations: FrozenDeclarations,
    pub(super) module: FrozenModuleDeclarations,
}
macro_rules! remap {
    ($name:ident) => {
        fn $name(&mut self, source: u32) -> Result<u32, Error<Self::Error>> {
            self.runtime.$name(source)
        }
    };
}
impl Reencode for Provider<'_, '_> {
    type Error = ImportIndexError;
    remap!(function_index);
    remap!(table_index);
    remap!(memory_index);
    remap!(global_index);
    remap!(tag_index);
}
impl FunctionTransform for Provider<'_, '_> {
    fn defer_module_initializers(&self) -> bool {
        self.roots.is_some()
    }
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
    fn transform_ir(&mut self, source: &FunctionIr<'_>, limit: usize) -> anyhow::Result<Function> {
        if let Some(activations) = &self.activations {
            return activations.emit_function(
                self.scan,
                source,
                &mut Sources {
                    runtime: &mut self.runtime,
                    plan: &self.plan,
                    constructors: &self.constructors,
                    state: &self.tables.as_ref().expect("stateful activations").rewrites,
                },
                limit,
            );
        }
        if let Some(roots) = &self.roots {
            let mut output = self
                .runtime
                .new_function_with_parsed_locals(&source.source)?;
            for instruction in &source.instructions {
                let operation = if let Some(helper) = self
                    .constructors
                    .replacement(&self.plan, &instruction.operation)?
                {
                    wasm_encoder::Instruction::Call(helper)
                } else {
                    self.runtime.instruction(instruction.operation.clone())?
                };
                if let Some(tables) = &self.tables {
                    tables
                        .rewrites
                        .emit_source(instruction, operation, &mut output, limit)?;
                } else {
                    roots.roots.emit_source(
                        &instruction.operation,
                        operation,
                        &mut output,
                        limit,
                    )?;
                }
            }
            return Ok(output);
        }
        self.constructors
            .emit_function(&self.plan, source, &mut self.runtime, limit)
    }
    fn emit_helper(&mut self, ordinal: u32, limit: usize) -> anyhow::Result<Function> {
        match ordinal {
            0..7 => self.runtime.emit_control(ordinal, limit),
            n if n < self.first_gc => self.constructors.emit_helper(n - 7, &self.plan, limit),
            n if n < self.first_exception => {
                self.gc.emit_helper(n - self.first_gc, &self.plan, limit)
            }
            n if n < self.first_exception + self.exception.declarations().function_count() => {
                self.exception.emit_helper(n - self.first_exception, limit)
            }
            n => {
                let roots = self.roots.as_ref().expect("root catalog");
                let ordinal =
                    n - self.first_exception - self.exception.declarations().function_count();
                if ordinal < roots.declarations.function_count() {
                    roots.emit_helper(ordinal, limit)
                } else {
                    let tables = self.tables.as_ref().expect("table catalog");
                    let ordinal = ordinal - roots.declarations.function_count();
                    if ordinal < tables.declarations.function_count() {
                        tables.emit_helper(ordinal, limit)
                    } else {
                        self.activations
                            .as_ref()
                            .expect("activation catalog")
                            .emit_helper(ordinal - tables.declarations.function_count(), limit)
                    }
                }
            }
        }
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
    remap!(function_index);
    remap!(table_index);
    remap!(memory_index);
    remap!(global_index);
    remap!(tag_index);
    remap!(type_index);
    remap!(data_index);
    remap!(element_index);
}
impl NativeSourceHooks for Sources<'_> {
    fn emit_native_source(
        &mut self,
        source: &SourceInstruction<'_>,
        instruction: Instruction<'_>,
        output: &mut Function,
        limit: usize,
    ) -> anyhow::Result<()> {
        let instruction = if let Some(helper) = self
            .constructors
            .replacement(self.plan, &source.operation)?
        {
            Instruction::Call(helper)
        } else {
            instruction
        };
        self.state.emit_source(source, instruction, output, limit)
    }
}
