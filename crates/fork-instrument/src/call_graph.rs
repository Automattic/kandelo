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

/// A classification of a discovered function for JSON output.
#[derive(Debug)]
pub struct FuncEntry {
    pub name: String,
    pub is_import: bool,
}
