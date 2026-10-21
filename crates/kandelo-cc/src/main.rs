//! `kandelo-cc`: every Kandelo SDK tool, selected by the name it runs as.
//!
//! `wasm32posix-<tool>` and `wasm64posix-<tool>`, for the tools `cc`, `c++`,
//! `ar`, `ranlib`, `nm`, `strip`, `configure` and `pkg-config`; inside
//! Kandelo also the conventional `cc`, `c89`, `c99` and `c++`. The SDK's
//! wrapper scripts pass the name in `WASM_POSIX_INVOKED_AS`; otherwise the
//! program's own name decides. Run as `kandelo-cc`, it offers:
//!
//!   kandelo-cc calltypes-plugin <clang>   print the compiler plugin for <clang>,
//!                                         building it if needed (used by
//!                                         builds that call clang directly)

use kandelo_cc::arch::{Language, WasmArch, detect};
use kandelo_cc::driver::compiler_main;
use kandelo_cc::flags::CallTypesPlugin;
use kandelo_cc::plugin::ensure_calltypes_plugin;
use kandelo_cc::{Result, tools};
use std::process::ExitCode;

fn exit(code: i32) -> ExitCode {
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

/// The tool a program name selects, without its arch prefix.
fn tool_name(name: &str) -> &str {
    if let Some(tool) = name
        .strip_prefix("wasm32posix-")
        .or_else(|| name.strip_prefix("wasm64posix-"))
    {
        return tool;
    }
    match name {
        "c89" | "c99" => "cc",
        other => other,
    }
}

fn run_tool(tool: &str, arch: WasmArch, args: &[String]) -> Option<Result<i32>> {
    Some(match tool {
        "cc" => compiler_main(arch, Language::C, args),
        "c++" => compiler_main(arch, Language::Cxx, args),
        "ar" => tools::llvm_passthrough("llvm-ar", args),
        "ranlib" => tools::llvm_passthrough("llvm-ranlib", args),
        "nm" => tools::llvm_passthrough("llvm-nm", args),
        // Stripping is a no-op for Wasm targets: the linker and wasm-opt own it.
        "strip" => Ok(0),
        "configure" => tools::configure(arch, args),
        "pkg-config" => tools::pkg_config(arch, args),
        _ => return None,
    })
}

fn calltypes_plugin_command(args: &[String]) -> ExitCode {
    if args.len() != 2 || args[0] != "calltypes-plugin" {
        eprintln!("usage: kandelo-cc calltypes-plugin <clang>");
        return exit(2);
    }
    match ensure_calltypes_plugin(&args[1]) {
        Ok(CallTypesPlugin::Library(path)) => {
            println!("{path}");
            ExitCode::SUCCESS
        }
        Ok(CallTypesPlugin::BuiltIn) => {
            eprintln!("kandelo-cc: this compiler has the plugin built in");
            ExitCode::FAILURE
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn main() -> ExitCode {
    let mut argv = std::env::args_os().map(|a| a.to_string_lossy().into_owned());
    let argv0 = argv.next().unwrap_or_default();
    let args: Vec<String> = argv.collect();
    let invoked_as = std::env::var("WASM_POSIX_INVOKED_AS")
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or(argv0);
    // The name is for this process only. A child that is the SDK driver
    // again (configure running cc, which inside Kandelo is this program
    // under another name) must decide from its own name.
    // SAFETY: no other thread exists yet.
    unsafe { std::env::remove_var("WASM_POSIX_INVOKED_AS") };
    let name = invoked_as
        .rsplit('/')
        .next()
        .unwrap_or(&invoked_as)
        .to_string();

    if name == "kandelo-cc" {
        return calltypes_plugin_command(&args);
    }

    let (arch, _) = detect(&name);
    match run_tool(tool_name(&name), arch, &args) {
        Some(Ok(code)) => exit(code),
        Some(Err(message)) => {
            eprintln!("{name}: error: {message}");
            ExitCode::FAILURE
        }
        None => {
            eprintln!("kandelo-cc: unknown SDK tool name {name:?}");
            exit(2)
        }
    }
}
