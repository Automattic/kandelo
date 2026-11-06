//! Root-state composition used by provider tests. This does not install sparse
//! table snapshots or certify a complete fork artifact.
use fork_instrument::streaming::*;
use wasm_encoder::{ExportKind, Function};

pub struct Components {
    pub bootstrap: FrozenModuleBootstrap,
    pub roots: NativeRootState,
    pub declarations: FrozenDeclarations,
}
impl Components {
    pub fn plan(
        scan: &Scan<'_>,
        runtime: &mut NativeRuntime,
        imports: &RootStateImports,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        first_type: u32,
        first_function: u32,
    ) -> Self {
        let frozen = runtime.imports_plan().clone();
        let bootstrap = ModuleBootstrapPlan::discover(scan, Default::default())
            .unwrap()
            .freeze(
                scan,
                Some(&frozen),
                runtime,
                module,
                first_type,
                first_function,
            )
            .unwrap();
        let roots = NativeRootState::plan(
            scan,
            &SourceTypes::new(scan),
            runtime,
            imports,
            &bootstrap,
            module,
            first_type + bootstrap.declarations().type_count(),
            first_function + bootstrap.declarations().function_count(),
            Default::default(),
        )
        .unwrap();
        for (name, index) in [
            ("save_roots", roots.save),
            ("restore_roots", roots.restore),
            ("finish_roots", roots.finish_segments),
        ] {
            module.export(name, ExportKind::Func, index).unwrap();
        }
        let declarations = FrozenDeclarations::concatenate(
            &[bootstrap.declarations(), roots.declarations()],
            1 << 20,
        )
        .unwrap();
        Self {
            bootstrap,
            roots,
            declarations,
        }
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> anyhow::Result<Function> {
        if ordinal < self.bootstrap.declarations().function_count() {
            self.bootstrap.emit_helper(ordinal, limit)
        } else {
            self.roots.emit_helper(
                ordinal - self.bootstrap.declarations().function_count(),
                limit,
            )
        }
    }
}
