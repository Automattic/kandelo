//! Sparse table providers and source-operation barriers in one frozen suffix.
use fork_instrument::streaming::*;
use wasm_encoder::{ExportKind, Function};
pub struct Components {
    pub tables: NativeTableState,
    pub rewrites: FrozenStateRewrites,
    state: NativeModuleState,
    pub declarations: FrozenDeclarations,
}
impl Components {
    #[allow(clippy::too_many_arguments)]
    pub fn plan(
        scan: &Scan<'_>,
        runtime: &mut NativeRuntime,
        records: &RootStateImports,
        host: &TableStateImports,
        roots: &NativeRootState,
        bootstrap: &FrozenModuleBootstrap,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        first_type: u32,
        first_function: u32,
    ) -> Self {
        let tables = NativeTableState::plan(
            scan,
            runtime,
            records,
            host,
            module,
            first_type,
            first_function,
            Default::default(),
        )
        .unwrap();
        for (name, function) in [
            ("save_tables", tables.save),
            ("restore_tables", tables.restore),
            ("reconcile_tables", tables.reconcile),
        ] {
            module.export(name, ExportKind::Func, function).unwrap();
        }
        let rewrites = StateRewrites::discover(scan, tables.synchronized_tables(), None, 100_000)
            .unwrap()
            .freeze(
                scan,
                runtime,
                first_type + tables.declarations().type_count(),
                first_function + tables.declarations().function_count(),
                StateHooks {
                    mutation_begin: tables.mutation_begin,
                    reconcile: tables.reconcile,
                    tables: tables.markers(),
                    data: roots.data_drop_bits().unwrap(),
                    elements: roots.element_drop_bits().unwrap(),
                },
                1 << 20,
            )
            .unwrap();
        let state = NativeModuleState::compose(
            roots,
            &tables,
            bootstrap,
            module,
            first_type + tables.declarations().type_count() + rewrites.declarations().type_count(),
            first_function
                + tables.declarations().function_count()
                + rewrites.declarations().function_count(),
        )
        .unwrap();
        let declarations = FrozenDeclarations::concatenate(
            &[
                tables.declarations(),
                rewrites.declarations(),
                state.declarations(),
            ],
            1 << 20,
        )
        .unwrap();
        Self {
            tables,
            rewrites,
            state,
            declarations,
        }
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> anyhow::Result<Function> {
        if ordinal < self.tables.declarations().function_count() {
            self.tables.emit_helper(ordinal, limit)
        } else {
            let ordinal = ordinal - self.tables.declarations().function_count();
            if ordinal < self.rewrites.declarations().function_count() {
                self.rewrites.emit_helper(ordinal, limit)
            } else {
                self.state.emit_helper(
                    ordinal - self.rewrites.declarations().function_count(),
                    limit,
                )
            }
        }
    }
}
