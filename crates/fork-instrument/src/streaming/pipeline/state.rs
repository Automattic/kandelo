//! Freeze bootstrap, roots, sparse tables and their source barriers together.
use super::*;

pub(super) struct ModuleState {
    pub bootstrap: FrozenModuleBootstrap,
    pub roots: NativeRootState,
    pub tables: NativeTableState,
    pub rewrites: FrozenStateRewrites,
    pub entry_points: NativeModuleState,
}
impl ModuleState {
    #[allow(clippy::too_many_arguments)]
    pub fn plan(
        scan: &Scan<'_>,
        runtime: &mut NativeRuntime,
        records: &RootStateImports,
        table_imports: &TableStateImports,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        cursor: &mut Cursor,
        limits: PipelineLimits,
    ) -> Result<Self> {
        let imports = runtime.imports_plan().clone();
        let bootstrap = ModuleBootstrapPlan::discover(scan, limits.bootstrap)?.freeze(
            scan,
            Some(&imports),
            runtime,
            module,
            cursor.ty,
            cursor.function,
        )?;
        cursor.advance(bootstrap.declarations())?;
        let roots = NativeRootState::plan(
            scan,
            &SourceTypes::new(scan),
            runtime,
            records,
            &bootstrap,
            module,
            cursor.ty,
            cursor.function,
            limits.roots,
        )?;
        cursor.advance(roots.declarations())?;
        let tables = NativeTableState::plan(
            scan,
            runtime,
            records,
            table_imports,
            module,
            cursor.ty,
            cursor.function,
            limits.tables,
        )?;
        cursor.advance(tables.declarations())?;
        let rewrites = StateRewrites::discover(
            scan,
            tables.synchronized_tables(),
            None,
            limits.state_rewrite_work,
        )?
        .freeze(
            scan,
            runtime,
            cursor.ty,
            cursor.function,
            StateHooks {
                mutation_begin: tables.mutation_begin,
                reconcile: tables.reconcile,
                tables: tables.markers(),
                data: roots.data_drop_bits()?,
                elements: roots.element_drop_bits()?,
            },
            limits.metadata_bytes,
        )?;
        cursor.advance(rewrites.declarations())?;
        let entry_points = NativeModuleState::compose(
            &roots,
            &tables,
            &bootstrap,
            module,
            cursor.ty,
            cursor.function,
        )?;
        cursor.advance(entry_points.declarations())?;
        Ok(Self {
            bootstrap,
            roots,
            tables,
            rewrites,
            entry_points,
        })
    }
    pub fn declarations(&self) -> [&FrozenDeclarations; 5] {
        [
            self.bootstrap.declarations(),
            self.roots.declarations(),
            self.tables.declarations(),
            self.rewrites.declarations(),
            self.entry_points.declarations(),
        ]
    }
    pub fn emit_helper(&self, mut ordinal: u32, limit: usize) -> Result<wasm_encoder::Function> {
        macro_rules! stage {
            ($stage:expr) => {
                if ordinal < $stage.declarations().function_count() {
                    return $stage.emit_helper(ordinal, limit);
                }
                ordinal -= $stage.declarations().function_count();
            };
        }
        stage!(self.bootstrap);
        stage!(self.roots);
        stage!(self.tables);
        stage!(self.rewrites);
        self.entry_points.emit_helper(ordinal, limit)
    }
}
