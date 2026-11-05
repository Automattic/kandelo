//! Original identities are frozen after executable helper indices settle.
use super::*;

pub(super) struct Catalogs {
    pub roots: NativeStaticRoots,
    pub resume: NativeResumeCatalog,
}
impl Catalogs {
    #[allow(clippy::too_many_arguments)]
    pub fn plan(
        scan: &Scan<'_>,
        runtime: &mut NativeRuntime,
        bootstrap: &FrozenModuleBootstrap,
        activations: &NativeActivations<'_>,
        generated: Option<NativeActivationEntry>,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        cursor: &mut Cursor,
        limits: PipelineLimits,
    ) -> Result<Self> {
        let imports = runtime.imports_plan().clone();
        let roots = StaticRootPlan::discover(scan, limits.static_roots)?.freeze(
            scan,
            Some(&imports),
            runtime,
            module,
            cursor.ty,
            cursor.function,
        )?;
        cursor.advance(roots.declarations())?;
        declare_function_catalog(
            scan,
            runtime,
            module,
            bootstrap.parent,
            limits.metadata_bytes,
        )?;
        let entries = activations
            .entries()
            .map(|(_, entry)| (entry.ordinal, entry.resume))
            .chain(generated.map(|entry| (entry.ordinal, entry.resume)));
        let resume = NativeResumeCatalog::declare(entries, module, limits.metadata_bytes)?;
        Ok(Self { roots, resume })
    }
}
