//! Target architecture and tool identity.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WasmArch {
    Wasm32,
    Wasm64,
}

impl WasmArch {
    pub fn as_str(self) -> &'static str {
        match self {
            WasmArch::Wasm32 => "wasm32",
            WasmArch::Wasm64 => "wasm64",
        }
    }
}

/// Which compiler driver an invocation names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    C,
    Cxx,
}

/// The arch and language an invocation name selects.
///
/// The SDK wrappers export `WASM_POSIX_INVOKED_AS` with the name they were
/// called as (for example `wasm64posix-c++`); otherwise the program's own
/// name decides, which is how the Kandelo SDK's `cc`, `c99` and `c++` links
/// reach the same driver. A `wasm64posix-` prefix selects wasm64; a name
/// ending in `++` selects C++.
pub fn detect(invoked_as: &str) -> (WasmArch, Language) {
    let name = invoked_as.rsplit('/').next().unwrap_or(invoked_as);
    let arch = if name.starts_with("wasm64posix-") {
        WasmArch::Wasm64
    } else {
        WasmArch::Wasm32
    };
    let language = if name.ends_with("++") {
        Language::Cxx
    } else {
        Language::C
    };
    (arch, language)
}

pub fn target_triple(arch: WasmArch) -> String {
    format!("{}-unknown-unknown", arch.as_str())
}

pub fn tool_prefix(arch: WasmArch) -> String {
    format!("{}posix", arch.as_str())
}

pub fn sysroot_dir(arch: WasmArch) -> &'static str {
    match arch {
        WasmArch::Wasm32 => "sysroot",
        WasmArch::Wasm64 => "sysroot64",
    }
}
