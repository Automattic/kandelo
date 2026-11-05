//! Staged loader adapters preserve original function identities while moving
//! initializer execution out of the historical reentrant host import.
use super::{
    FrozenDeclarations, FrozenImports, FunctionAdapter, ModuleDeclarationBuilder, PlannedImport,
    RuntimeInputs, Scan,
};
use anyhow::{Context, Result, ensure};
use wasm_encoder::{
    EntityType, FuncType, Function, RefType, TableType, ValType, reencode::Reencode,
};

mod activation;
mod bindings;
mod emit;
mod planning;
pub use activation::{LoaderActivationOptions, NativeLoaderActivation};

#[derive(Clone, Copy, Debug)]
pub struct LoaderLimits {
    pub metadata_bytes: usize,
    pub work: usize,
}
impl Default for LoaderLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            work: crate::limits::TOTAL_WORK,
        }
    }
}
#[derive(Clone, Copy)]
enum Binding {
    Source(u32),
    Planned(u32),
}
impl Binding {
    fn resolve(self, imports: &mut FrozenImports) -> Result<u32> {
        match self {
            Self::Source(source) => Ok(imports.function_index(source)?),
            Self::Planned(ordinal) => imports
                .index(ordinal)
                .context("loader import was not frozen"),
        }
    }
}
struct Adapter {
    source: u32,
    ty: u32,
    parameters: Vec<ValType>,
    prepare: Binding,
}
struct Protocol {
    main: Binding,
    next: Binding,
    commit: Binding,
    driver_type: u32,
    initializer_type: u32,
    table: Option<(u32, bool)>,
    checkpoint: Option<u32>,
}
pub struct LegacyLoaderPlan {
    source: [u8; 32],
    first_helper: u32,
    adapters: Vec<Adapter>,
    protocol: Option<Protocol>,
    limits: LoaderLimits,
}
struct FrozenAdapter {
    source: u32,
    parameters: Vec<ValType>,
    prepare: u32,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct DriverIndices {
    next: u32,
    commit: u32,
    checkpoint: Option<u32>,
    table: u32,
    initializer_type: u32,
}
pub struct NativeLegacyLoader {
    source: [u8; 32],
    imports: Option<[u8; 32]>,
    declarations: FrozenDeclarations,
    adapters: Vec<FrozenAdapter>,
    pub(crate) driver: Option<u32>,
    pub(crate) main: u32,
    pub(crate) next: u32,
    pub(crate) commit: u32,
    pub(crate) table: u32,
    pub(crate) table64: bool,
    pub(crate) checkpoint: Option<u32>,
    pub(crate) initializer_type: u32,
}
impl LegacyLoaderPlan {
    /// Reserve helper ordinals before freezing imports. The runtime occupies
    /// ordinals 0..7; standalone reencoders may start at zero instead.
    pub fn reserve(
        scan: &Scan<'_>,
        inputs: &mut RuntimeInputs,
        first_helper: u32,
        limits: LoaderLimits,
    ) -> Result<Self> {
        planning::reserve(scan, inputs, first_helper, limits)
    }
    pub fn helper_count(&self) -> u32 {
        if self.protocol.is_none() {
            0
        } else {
            self.adapters.len() as u32 + 1
        }
    }
    pub fn source_functions(&self) -> impl Iterator<Item = u32> + '_ {
        self.adapters.iter().map(|adapter| adapter.source)
    }
    pub fn freeze(
        self,
        scan: &Scan<'_>,
        imports: &FrozenImports,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
    ) -> Result<NativeLegacyLoader> {
        ensure!(
            self.source == scan.source_fingerprint(),
            "loader plan belongs to another original module"
        );
        imports.validate_source(scan)?;
        let mut mapping = imports.clone();
        let mut output = NativeLegacyLoader {
            source: self.source,
            imports: imports.layout_identity(),
            declarations: FrozenDeclarations::new(
                Vec::new(),
                Vec::new(),
                self.limits.metadata_bytes,
            )?,
            adapters: Vec::new(),
            driver: None,
            main: 0,
            next: 0,
            commit: 0,
            table: 0,
            table64: false,
            checkpoint: None,
            initializer_type: 0,
        };
        let Some(protocol) = self.protocol else {
            return Ok(output);
        };
        let driver = imports
            .helper_function_base()
            .checked_add(self.first_helper)
            .context("loader helper index overflow")?;
        let mut functions = vec![protocol.driver_type];
        for (ordinal, adapter) in self.adapters.into_iter().enumerate() {
            let expected = driver
                .checked_add(1)
                .and_then(|index| index.checked_add(ordinal.try_into().ok()?))
                .context("loader adapter index overflow")?;
            ensure!(
                mapping.function_index(adapter.source)? == expected,
                "loader import does not resolve to its reserved adapter"
            );
            functions.push(adapter.ty);
            output.adapters.push(FrozenAdapter {
                source: adapter.source,
                parameters: adapter.parameters,
                prepare: adapter.prepare.resolve(&mut mapping)?,
            });
        }
        output.main = protocol.main.resolve(&mut mapping)?;
        output.next = protocol.next.resolve(&mut mapping)?;
        output.commit = protocol.commit.resolve(&mut mapping)?;
        output.checkpoint = protocol
            .checkpoint
            .map(|source| mapping.function_index(source))
            .transpose()?;
        let (table, table64) = match protocol.table {
            Some((source, wide)) => (mapping.table_index(source)?, wide),
            // Preserve the old malformed/dead-import boundary. Prepare reports
            // the missing canonical linker table before this fallback is used.
            None => (
                module.table(
                    TableType {
                        element_type: RefType::FUNCREF,
                        minimum: 1,
                        maximum: None,
                        table64: false,
                        shared: false,
                    },
                    None,
                )?,
                false,
            ),
        };
        output.table = table;
        output.table64 = table64;
        output.initializer_type = protocol.initializer_type;
        output.driver = Some(driver);
        output.declarations =
            FrozenDeclarations::new(Vec::new(), functions, self.limits.metadata_bytes)?;
        Ok(output)
    }
}
impl NativeLegacyLoader {
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn driver(&self) -> Option<u32> {
        self.driver
    }
    pub fn source_functions(&self) -> impl Iterator<Item = u32> + '_ {
        self.adapters.iter().map(|adapter| adapter.source)
    }
    /// Raw staged protocol only. The complete pipeline must instrument the
    /// driver's initializer/checkpoint calls before certifying fork support.
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        if ordinal == 0 && self.driver.is_some() {
            return self.emit_driver(limit);
        }
        let adapter = ordinal
            .checked_sub(1)
            .and_then(|index| self.adapters.get(index as usize))
            .context("unknown loader helper")?;
        self.emit_adapter(adapter, limit)
    }
}
