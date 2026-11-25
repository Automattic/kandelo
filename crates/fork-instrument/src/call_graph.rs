//! Original function identities used by analysis reports and loader discovery.

pub(crate) fn is_dynamic_linker_function_import(module: &str, name: &str) -> bool {
    module == "env"
        && matches!(
            name,
            "__wasm_dlopen"
                | "__wasm_dlopen_main"
                | "__wasm_dlopen_prepare"
                | "__wasm_dlopen_next"
                | "__wasm_dlopen_commit"
                | "__wasm_dlsym"
                | "__wasm_dlclose"
                | "__wasm_dlerror"
        )
}

/// Function exports the host's dynamic linker can append to the exported
/// `__indirect_function_table` at run time, and that table's index.
///
/// WHY: `dlsym(RTLD_DEFAULT, name)` and a side module's `GOT.func`
/// relocation against a main-program symbol both install the export in that
/// table (host/src/dylink.ts `symbolAddress`), so with no element segment
/// naming it the export is still a target of the program's own indirect
/// calls. Empty unless the module imports a dynamic-linker function.
pub(crate) fn runtime_table_exports(scan: &crate::streaming::Scan<'_>) -> (Option<u32>, Vec<u32>) {
    let dynamic_linker = scan.functions.iter().any(|function| {
        function
            .import
            .as_ref()
            .is_some_and(|(module, name)| is_dynamic_linker_function_import(module, name))
    });
    if !dynamic_linker {
        return (None, Vec::new());
    }
    let table = scan.exports.iter().find_map(|(name, kind, index)| {
        (*kind == wasmparser::ExternalKind::Table && name == "__indirect_function_table")
            .then_some(*index)
    });
    let mut functions: Vec<u32> = scan
        .exports
        .iter()
        .filter_map(|(_, kind, index)| (*kind == wasmparser::ExternalKind::Func).then_some(*index))
        .collect();
    functions.sort_unstable();
    functions.dedup();
    (table, functions)
}

/// A classification of a discovered function for JSON output.
#[derive(Debug)]
pub struct FuncEntry {
    pub name: String,
    pub is_import: bool,
}
