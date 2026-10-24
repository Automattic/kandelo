//! One-body emission for the shared real-provider test factory.
use super::{catalogs, roots, tables};
use fork_instrument::streaming::*;
use wasm_encoder::{
    Function,
    reencode::{Error, Reencode},
};
pub(super) struct Provider {
    pub(super) identities: Option<catalogs::Components>,
    pub(super) loader: NativeLegacyLoader,
    pub(super) first_constructors: u32,
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
impl Reencode for Provider {
    type Error = ImportIndexError;
    remap!(function_index);
    remap!(table_index);
    remap!(memory_index);
    remap!(global_index);
    remap!(tag_index);
}
impl FunctionTransform for Provider {
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
            n if n < self.first_constructors => self.loader.emit_helper(n - 7, limit),
            n if n < self.first_gc => {
                self.constructors
                    .emit_helper(n - self.first_constructors, &self.plan, limit)
            }
            n if n < self.first_exception => {
                self.gc.emit_helper(n - self.first_gc, &self.plan, limit)
            }
            n if n < self.first_exception + self.exception.declarations().function_count() => {
                self.exception.emit_helper(n - self.first_exception, limit)
            }
            n => {
                let roots = self.roots.as_ref().expect("root catalog");
                let mut ordinal =
                    n - self.first_exception - self.exception.declarations().function_count();
                if ordinal < roots.declarations.function_count() {
                    return roots.emit_helper(ordinal, limit);
                }
                ordinal -= roots.declarations.function_count();
                if let Some(tables) = &self.tables {
                    if ordinal < tables.declarations.function_count() {
                        return tables.emit_helper(ordinal, limit);
                    }
                    ordinal -= tables.declarations.function_count();
                }
                self.identities
                    .as_ref()
                    .expect("identity catalogs")
                    .emit_helper(ordinal, limit)
            }
        }
    }
}
