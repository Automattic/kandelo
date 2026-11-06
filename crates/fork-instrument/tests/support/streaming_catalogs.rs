//! Original identity catalogs appended after all executable helper schedules.
use fork_instrument::{instrument, static_reference_catalog, streaming::*};
use wasm_encoder::Function;

pub struct Components {
    pub roots: NativeStaticRoots,
    pub resume: NativeResumeCatalog,
}
impl Components {
    pub fn plan(
        scan: &Scan<'_>,
        runtime: &mut NativeRuntime,
        bootstrap: &FrozenModuleBootstrap,
        activations: Option<&NativeActivations<'_>>,
        generated: Option<NativeActivationEntry>,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        first_type: u32,
        first_function: u32,
    ) -> Self {
        let imports = runtime.imports_plan().clone();
        let roots = StaticRootPlan::discover(scan, Default::default())
            .unwrap()
            .freeze(
                scan,
                Some(&imports),
                runtime,
                module,
                first_type,
                first_function,
            )
            .unwrap();
        declare_function_catalog(scan, runtime, module, bootstrap.parent, 1 << 20).unwrap();
        let entries = activations
            .into_iter()
            .flat_map(NativeActivations::entries)
            .map(|(_, entry)| (entry.ordinal, entry.resume))
            .chain(generated.map(|entry| (entry.ordinal, entry.resume)));
        let resume = NativeResumeCatalog::declare(entries, module, 1 << 20).unwrap();
        Self { roots, resume }
    }
    pub fn declarations(&self) -> &FrozenDeclarations {
        self.roots.declarations()
    }
    pub fn descriptors(&self) -> [(&'static str, Vec<u8>); 2] {
        [
            (
                static_reference_catalog::FORMAT_SECTION,
                self.roots.descriptor(),
            ),
            (
                instrument::RESUME_CATALOG_SECTION,
                self.resume.descriptor().to_vec(),
            ),
        ]
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> anyhow::Result<Function> {
        self.roots.emit_helper(ordinal, limit)
    }
}
