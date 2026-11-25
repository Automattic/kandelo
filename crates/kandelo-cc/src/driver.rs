//! The compiler driver: from a caller's `cc` command to the clang and
//! wasm-ld jobs that build a Kandelo program, and the post-link step that
//! leaves each module with exactly the facts and optimization it needs.

use crate::Result;
use crate::arch::{Language, WasmArch, target_triple};
use crate::exec::{RunResult, run, run_passthrough, run_without_env};
use crate::flags::{
    MAX_EXECUTABLE_MEMORY_SIZE, ParsedArgs, ResponseFileContents, THREAD_SLOT_USE_HOST_DEFAULT,
    calltypes_plugin_flags, compile_flags, compiles_cxx, cxx_compile_flags, expand_response_files,
    filter_args, host_imports_allowance, infer_thread_slot_declaration, join, link_flags,
    main_thread_stack_size, needs_linking, parse_args, read_text_file, requests_cfi,
    shared_link_flags, thread_slot_declaration_define, tokenize_gnu_response_file,
};
use crate::node_path::{self, basename, cwd, is_absolute, resolve};
use crate::toolchain::{Toolchain, read_abi_contract_digest, resolve_lld_major};
use crate::wasm::{
    CALLTYPES_SECTION, imports_function, is_relocatable, is_wasm_module, with_abi_contract_section,
    with_code_hash_section, without_custom_section,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const STABLE_SDK_SOURCE_ROOT: &str = "/usr/src/kandelo-sdk";

fn source_prefix_map_flags(source: &str, destination: &str) -> Vec<String> {
    vec![
        format!("-ffile-prefix-map={source}={destination}"),
        format!("-fdebug-prefix-map={source}={destination}"),
        format!("-fmacro-prefix-map={source}={destination}"),
    ]
}

fn sdk_source_prefix_map_flags(toolchain: &Toolchain, arch: WasmArch) -> Vec<String> {
    let sysroot_name = match arch {
        WasmArch::Wasm64 => "sysroot64",
        WasmArch::Wasm32 => "sysroot",
    };
    let mut flags = source_prefix_map_flags(
        &toolchain.glue_dir,
        &format!("{STABLE_SDK_SOURCE_ROOT}/libc/glue"),
    );
    flags.extend(source_prefix_map_flags(
        &toolchain.sysroot,
        &format!("{STABLE_SDK_SOURCE_ROOT}/{sysroot_name}"),
    ));
    flags
}

const STABLE_BUILD_SOURCE_ROOT: &str = "/usr/src/kandelo-build";

fn absolute_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| is_absolute(value))
}

fn is_package_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

/// During a package build the local-build engine sets WASM_POSIX_DEP_WORK_DIR
/// to the recipe's per-build work directory. Its absolute path embeds the
/// build scratch location and a process-PID-suffixed component, so it varies
/// with the build location and on every rebuild. That path leaks into DWARF,
/// `__FILE__`, assertion strings, and similar. Map it to a stable destination
/// so binaries stay path-independent; doing it here, in the one driver every
/// C/C++ compile flows through, covers each package without per-recipe flags.
///
/// Two maps, from least to most specific (a later -ffile-prefix-map wins for
/// an overlapping path):
///   1. the source-only cache root, under which dependency install dirs live
///      (`<root>/source-only-v1/compiled/programs/<dep>-<key>/…`);
///   2. this package's work dir, keyed by package name and mapped last so it
///      takes precedence and strips the PID-suffixed component.
fn recipe_work_prefix_map_flags() -> Vec<String> {
    let mut flags = Vec::new();
    if let Some(cache_root) = absolute_env("WASM_POSIX_SOURCE_ONLY_CACHE_ROOT") {
        flags.extend(source_prefix_map_flags(
            &cache_root,
            &format!("{STABLE_BUILD_SOURCE_ROOT}-deps"),
        ));
    }
    if let Some(work_dir) = absolute_env("WASM_POSIX_DEP_WORK_DIR") {
        let destination = match std::env::var("WASM_POSIX_DEP_NAME") {
            Ok(name) if is_package_name(&name) => format!("{STABLE_BUILD_SOURCE_ROOT}/{name}"),
            _ => STABLE_BUILD_SOURCE_ROOT.to_string(),
        };
        flags.extend(source_prefix_map_flags(&work_dir, &destination));
    }
    flags
}

/// Decode a response file as LLVM does: UTF-16 with a byte-order mark,
/// otherwise UTF-8.
pub fn decode_llvm_response_file(bytes: &[u8]) -> Result<String> {
    let utf16 = |body: &[u8], little: bool, name: &str| -> Result<String> {
        if body.len() % 2 != 0 {
            return Err(format!("odd-length {name} response file"));
        }
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|pair| {
                if little {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        String::from_utf16(&units).map_err(|_| format!("invalid {name} response file"))
    };
    if bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe {
        return utf16(&bytes[2..], true, "UTF-16LE");
    }
    if bytes.len() >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff {
        return utf16(&bytes[2..], false, "UTF-16BE");
    }
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

fn read_llvm_response_file(path: &str, working_directory: &str) -> Option<ResponseFileContents> {
    let resolved = resolve(working_directory, path);
    let contents = decode_llvm_response_file(&std::fs::read(&resolved).ok()?).ok()?;
    let identity = std::fs::canonicalize(&resolved)
        .ok()?
        .to_string_lossy()
        .into_owned();
    Some(ResponseFileContents { contents, identity })
}

/// What an executable link needs prepared before its arguments are built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkerPreparation {
    /// The command links nothing after all (a response file held only
    /// compile flags).
    NoLink,
    ExecutableLink {
        main_thread_stack_size_bytes: u64,
    },
}

/// The internal-only third state: the provisional trace
/// `prepare_executable_linker` takes to discover what the caller asked for.
/// That trace must never inject a stack-size flag of its own — it would sit
/// after, and so override, any real request forwarded from the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Preparation {
    Prepared(LinkerPreparation),
    MeasureOnly,
}

fn is_pinned_linker(actual: Option<&str>, linker_path: &str) -> bool {
    let Some(actual) = actual else { return false };
    if actual == linker_path {
        return true;
    }
    match (
        std::fs::canonicalize(actual),
        std::fs::canonicalize(linker_path),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn executable_name(path: &str) -> &str {
    let name = basename(path);
    match name
        .len()
        .checked_sub(4)
        .and_then(|stem| Some((stem, name.get(stem..)?)))
    {
        Some((stem, suffix)) if suffix.eq_ignore_ascii_case(".exe") => &name[..stem],
        _ => name,
    }
}

fn is_wasm_opt_name(name: &str) -> bool {
    match name.strip_prefix("wasm-opt") {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('-')
            .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())),
        None => false,
    }
}

fn is_wasm_opt_job(args: &[String]) -> bool {
    is_wasm_opt_name(executable_name(args.first().map_or("", String::as_str)))
}

fn is_expected_non_linker_job(args: &[String]) -> bool {
    // Wrapped LLVM installations may schedule Binaryen after wasm-ld. It is a
    // post-link transform, not a second or replacement linker job.
    args.get(1).is_some_and(|a| a == "-cc1") || is_wasm_opt_job(args)
}

fn clang_trace_commands(
    trace: &str,
    accepts_first_line: &dyn Fn(&[String], &str) -> bool,
) -> Result<Vec<String>> {
    let chars: Vec<char> = trace.chars().collect();
    let len = chars.len();
    let mut commands = Vec::new();
    let mut offset = 0;

    while offset < len {
        let physical_line_end = chars[offset..]
            .iter()
            .position(|&c| c == '\n')
            .map(|p| p + offset);
        let first_line_end = physical_line_end.unwrap_or(len);
        let first_line: String = chars[offset..first_line_end].iter().collect();
        let first_line_args = tokenize_gnu_response_file(&first_line);
        if !accepts_first_line(&first_line_args, &first_line) {
            offset = physical_line_end.map_or(len, |end| end + 1);
            continue;
        }

        let mut quote: Option<char> = None;
        let mut end = offset;
        while end < len {
            let c = chars[end];
            if c == '\\' && end + 1 < len {
                end += 2;
                continue;
            }
            if let Some(q) = quote {
                if c == q {
                    quote = None;
                }
                end += 1;
                continue;
            }
            if c == '"' || c == '\'' {
                quote = Some(c);
                end += 1;
                continue;
            }
            if c == '\n' {
                break;
            }
            end += 1;
        }
        if quote.is_some() {
            return Err("clang -### emitted an unterminated quoted command".into());
        }

        commands.push(chars[offset..end.min(len)].iter().collect());
        offset = if end < len { end + 1 } else { end };
    }

    Ok(commands)
}

/// A job line of a `clang -###` trace: indented, quoted, absolute program.
fn is_job_line(args: &[String], first_line: &str) -> bool {
    let indent = first_line.len() - first_line.trim_start_matches([' ', '\t']).len();
    indent > 0
        && first_line[indent..].starts_with(['"', '\''])
        && args.first().is_some_and(|program| is_absolute(program))
}

/// The jobs of a `clang -###` trace, tokenized.
fn traced_jobs(trace: &str) -> Result<Vec<Vec<String>>> {
    Ok(clang_trace_commands(trace, &is_job_line)?
        .iter()
        .map(|line| tokenize_gnu_response_file(line))
        .collect())
}

pub fn linker_args_from_clang_trace(trace: &str, linker_path: &str) -> Result<Option<Vec<String>>> {
    let jobs = traced_jobs(trace)?;
    if jobs.is_empty() {
        return Err("clang -### emitted no recognizable jobs".into());
    }
    fn program(args: &[String]) -> Option<&str> {
        args.first().map(String::as_str)
    }
    let matches: Vec<&Vec<String>> = jobs
        .iter()
        .filter(|args| is_pinned_linker(program(args), linker_path))
        .collect();
    let unexpected = jobs
        .iter()
        .filter(|args| {
            !is_pinned_linker(program(args), linker_path) && !is_expected_non_linker_job(args)
        })
        .count();
    if matches.len() > 1 || unexpected > 0 {
        return Err(format!(
            "clang -### emitted {} commands for the pinned linker {linker_path}; expected exactly one",
            matches.len()
        ));
    }
    match matches.first() {
        Some(linker) => Ok(Some(linker[1..].to_vec())),
        None => {
            if !jobs
                .iter()
                .any(|args| args.get(1).is_some_and(|a| a == "-cc1"))
            {
                return Err("clang -### emitted no compiler or pinned linker jobs".into());
            }
            Ok(None)
        }
    }
}

pub fn working_directory_from_clang_trace(
    trace: &str,
    initial_working_directory: &str,
) -> Result<String> {
    let mut traced: HashSet<String> = HashSet::new();

    // The provisional argv always adds absolute glue C sources, so an
    // executable link, including an object-only user link, emits cc1 jobs.
    // Clang's driver (Clang::ConstructJob in clang/lib/Driver/ToolChains/
    // Clang.cpp) constructs this exact slot by pushing -resource-dir, its
    // value, and then Args.AddLastArg(OPT_working_directory), before
    // preprocessing and -Xclang arguments. This is the effective driver cwd
    // even when a config file or CCC_OVERRIDE_OPTIONS supplied it.
    let has_cc1 = |args: &[String], _: &str| args.iter().any(|a| a == "-cc1");
    for command in clang_trace_commands(trace, &has_cc1)? {
        let args = tokenize_gnu_response_file(&command);
        let Some(index) = args
            .iter()
            .position(|a| a == "-resource-dir")
            .filter(|i| args.get(i + 1).is_some())
        else {
            return Err("clang -### cc1 command omitted its driver resource-directory slot".into());
        };
        let following = index + 2;
        match args.get(following).map(String::as_str) {
            Some("-working-directory") => match args.get(following + 1) {
                Some(value) if !value.is_empty() => {
                    traced.insert(resolve(initial_working_directory, value));
                }
                _ => {
                    return Err(
                        "clang -### emitted a malformed driver working-directory slot".into(),
                    );
                }
            },
            Some(other) if other.starts_with("-working-directory") => {
                return Err("clang -### emitted an ambiguous driver working-directory slot".into());
            }
            _ => {
                traced.insert(resolve(initial_working_directory, ""));
            }
        }
    }
    if traced.len() != 1 {
        return Err("clang -### did not emit one consistent driver working directory".into());
    }
    Ok(traced.into_iter().next().expect("one directory"))
}

/// The link-time glue of an executable link, as sources or as the objects
/// compiled from them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Glue {
    /// Linked as objects ahead of crt1.o and the caller's inputs, in this
    /// order: the syscall channel and compiler-rt builtins, the dlopen loader
    /// when the link asks for it, and the C++ runtime entry
    /// (`cxxrt_entry.cpp`) when the link includes libc++abi.
    pub leading: Vec<String>,
    /// The minimal C++ runtime fallback (`cxxrt.c`), linked lazily after the
    /// caller's inputs and the C++ libraries: a member is used only when
    /// nothing earlier defines what it provides.
    pub fallback: Vec<String>,
}

/// The glue source that installs the C++ runtime's language entries.
pub const CXX_ENTRY_GLUE: &str = "cxxrt_entry.cpp";

/// Link-time libc glue sources, in link order.
pub fn glue_sources(toolchain: &Toolchain, link_dl: bool, cxx_runtime: bool) -> Glue {
    let mut leading = vec!["channel_syscall.c", "compiler_rt.c"];
    if link_dl {
        leading.push("dlopen.c");
    }
    if cxx_runtime {
        leading.push(CXX_ENTRY_GLUE);
    }
    let path = |name: &&str| join(&toolchain.glue_dir, name);
    Glue {
        leading: leading.iter().map(path).collect(),
        fallback: ["cxxrt.c"].iter().map(path).collect(),
    }
}

fn is_cxx_glue(source: &str) -> bool {
    source.ends_with(".cpp")
}

/// Compile command for the link-time C glue sources.
///
/// The glue (the syscall channel, compiler-rt builtins, the minimal C++
/// runtime, the dlopen loader) is platform code linked into every
/// executable. Compiling it separately with fixed flags makes every program
/// carry the same glue code regardless of how its build links: it does not
/// inherit the link command's optimization level or language.
pub fn build_glue_compile_args(
    sources: &[String],
    toolchain: &Toolchain,
    arch: WasmArch,
    thread_slot_define: Option<&str>,
) -> Vec<String> {
    let mut args = glue_compile_base(toolchain, arch);
    if let Some(define) = thread_slot_define {
        args.push(define.to_string());
    }
    args.extend(["-O2", "-x", "c", "-c"].map(String::from));
    args.extend(sources.iter().cloned());
    args
}

/// Compile command for the C++ glue: the same fixed flags as the C glue,
/// with the SDK's C++ exception handling, which its catch handlers need.
pub fn build_cxx_glue_compile_args(
    sources: &[String],
    toolchain: &Toolchain,
    arch: WasmArch,
) -> Vec<String> {
    let mut args = glue_compile_base(toolchain, arch);
    args.extend(cxx_compile_flags());
    args.extend(["-O2", "-x", "c++", "-c"].map(String::from));
    args.extend(sources.iter().cloned());
    args
}

fn glue_compile_base(toolchain: &Toolchain, arch: WasmArch) -> Vec<String> {
    let mut args = compile_flags(arch);
    // The glue is code of every executable, so its facts must be in the link
    // like any other object's.
    if let Some(plugin) = &toolchain.calltypes_plugin {
        args.extend(calltypes_plugin_flags(plugin));
    }
    args.push(format!("--sysroot={}", toolchain.sysroot));
    args.extend(sdk_source_prefix_map_flags(toolchain, arch));
    args.extend(recipe_work_prefix_map_flags());
    args
}

fn infer_thread_slots(parsed: &ParsedArgs, user_args: &[String]) -> i64 {
    infer_thread_slot_declaration(parsed, user_args, &read_text_file)
}

/// The thread-slot declaration an executable link applies to its glue.
fn executable_thread_slot_define(user_args: &[String], arch: WasmArch) -> Result<Option<String>> {
    let parsed = parse_args(&filter_args(user_args, arch).filtered)?;
    let slots = infer_thread_slots(&parsed, user_args);
    Ok((slots != THREAD_SLOT_USE_HOST_DEFAULT).then(|| thread_slot_declaration_define(slots)))
}

fn is_assembly_input(arg: &str) -> bool {
    !arg.starts_with('-')
        && [".s", ".S", ".sx", ".asm"]
            .iter()
            .any(|ext| arg.ends_with(ext))
}

/// Does this executable link get the C++ standard library?
///
/// POSIX specifies no C++ compiler; every Unix C++ driver (g++, clang++)
/// links the C++ library into C++ programs unless the caller opts out with
/// `-nostdlib`, `-nodefaultlibs` or `-nostdlib++`. Clang would add exactly
/// `-lc++ -lc++abi` for this target; the SDK's own `-nostdlib` (which owns
/// the libc and CRT order) suppresses that, so the SDK adds them itself.
fn links_cxx_stdlib(language: Language, filtered: &[String]) -> bool {
    language == Language::Cxx
        && !filtered
            .iter()
            .any(|arg| matches!(arg.as_str(), "-nostdlib" | "-nodefaultlibs" | "-nostdlib++"))
}

/// Does this executable link include the C++ runtime (libc++abi)?
///
/// Either the SDK adds it (`links_cxx_stdlib`) or the caller names it, as a
/// C program that links a C++ library does with `-lc++ -lc++abi`. Such a
/// link gets the C++ runtime entry glue (`cxxrt_entry.cpp`).
fn links_cxx_runtime(language: Language, filtered: &[String]) -> bool {
    links_cxx_stdlib(language, filtered)
        || filtered.iter().enumerate().any(|(i, arg)| {
            arg == "-lc++abi"
                || (arg == "-l" && filtered.get(i + 1).is_some_and(|next| next == "c++abi"))
                || basename(arg) == "libc++abi.a"
        })
}

#[allow(clippy::too_many_arguments)]
fn build_clang_args_internal(
    user_args: &[String],
    toolchain: &Toolchain,
    arch: WasmArch,
    language: Language,
    executable_linker: Option<Preparation>,
    report_warnings: bool,
    classify_link: bool,
    glue_objects: Option<&Glue>,
) -> Result<Vec<String>> {
    let filter = filter_args(user_args, arch);
    if report_warnings {
        for warning in &filter.warnings {
            eprintln!("{warning}");
        }
    }
    let filtered = filter.filtered;

    let parsed = parse_args(&filtered)?;
    let no_link = executable_linker == Some(Preparation::Prepared(LinkerPreparation::NoLink));
    let linking = needs_linking(&parsed) && !no_link;
    let has_source_files = !parsed.source_files.is_empty();

    let mut args: Vec<String> = Vec::new();
    let target = format!("--target={}", target_triple(arch));

    let may_run_compile = has_source_files
        || parsed.compile_only
        || parsed.preprocess_only
        || parsed.assembly_only
        || linking
        || no_link;
    // Inject compile flags for visible sources and compile-only modes, links
    // that compile glue, and response-hidden compile jobs found by the trace.
    if may_run_compile {
        // An executable link may have only prebuilt inputs. Mark the SDK's
        // compile flags as optional in that case, keeping caller diagnostics.
        if linking {
            args.push("--start-no-unused-arguments".into());
        }
        args.extend(compile_flags(arch));
        if compiles_cxx(language, &filtered) {
            args.extend(cxx_compile_flags());
        }
        if linking {
            args.push("--end-no-unused-arguments".into());
        }
    }
    // The call-type facts plugin, for invocations that can run a compile job.
    // A link of objects only has none, and clang would warn that the -Xclang
    // flags went unused.
    let assembly_only_inputs =
        !has_source_files && parsed.other_args.iter().any(|a| is_assembly_input(a));
    if let Some(plugin) = &toolchain.calltypes_plugin {
        if !requests_cfi(&filtered)
            && !parsed.preprocess_only
            && !assembly_only_inputs
            && (has_source_files || parsed.compile_only || parsed.assembly_only || no_link)
        {
            args.extend(calltypes_plugin_flags(plugin));
        }
    }
    // Target is always needed (even for link-only, clang needs to know the target).
    if !args.contains(&target) {
        args.push(target);
    }
    args.push(format!("--sysroot={}", toolchain.sysroot));

    if parsed.compile_only {
        args.push("-c".into());
    }
    if parsed.preprocess_only {
        args.push("-E".into());
    }
    if parsed.assembly_only {
        args.push("-S".into());
    }
    if let Some(output) = parsed.output_file.as_deref().filter(|o| !o.is_empty()) {
        args.push("-o".into());
        args.push(output.to_string());
    }
    let defer_executable_inputs = linking && !classify_link && !parsed.shared;
    // Static link semantics depend on the caller's exact ordering of objects,
    // archives, -l flags, and linker group controls. Parsed classifications
    // are for SDK decisions only; forwarding must never rebuild the command in
    // type-based buckets. Executable links defer this sequence until after the
    // platform glue and CRT so an explicit -lc cannot resolve musl's syscall
    // definitions before Kandelo's overrides.
    if !defer_executable_inputs {
        args.extend(parsed.forwarded_args.iter().cloned());
    }

    // Keep the glue files and sysroot headers independent of the checkout
    // used for the build. Append these after caller flags so a broader
    // caller-owned mapping cannot retain a less-specific host path in DWARF.
    let mut sdk_compile_args = if may_run_compile {
        let mut maps = sdk_source_prefix_map_flags(toolchain, arch);
        maps.extend(recipe_work_prefix_map_flags());
        maps
    } else {
        Vec::new()
    };
    // -fPIC is consumed by parse_args (so the linker can see `pic`), but it
    // must also reach clang at compile time so the resulting object uses PIC
    // relocations; `wasm-ld --shared` rejects non-PIC objects.
    if parsed.pic {
        sdk_compile_args.push("-fPIC".into());
    }
    if !defer_executable_inputs {
        args.extend(sdk_compile_args.iter().cloned());
    }

    if linking {
        // Keep clang and lld in the same resolved LLVM tree. Without an
        // explicit linker path, clang can pick an unrelated ambient wasm-ld.
        args.push(format!("-fuse-ld={}", join(&toolchain.llvm_dir, "wasm-ld")));
        if classify_link {
            return Ok(args);
        }
        if parsed.shared {
            // Shared library build: no CRT, no libc, no syscall glue.
            args.extend(shared_link_flags());
        } else {
            let Some(lld_major) = toolchain.lld_major else {
                return Err("wasm-ld version is unresolved; call prepare_executable_linker() before building \
                            executable link arguments"
                    .into());
            };
            let prepared_stack_size = match executable_linker {
                Some(Preparation::Prepared(LinkerPreparation::ExecutableLink {
                    main_thread_stack_size_bytes,
                })) => Some(main_thread_stack_size_bytes),
                Some(Preparation::MeasureOnly) => None,
                _ => {
                    return Err("executable linker arguments are unprepared; call prepare_executable_linker() \
                                and pass its result to build_clang_args()"
                        .into());
                }
            };
            if prepared_stack_size.is_some_and(|size| size > MAX_EXECUTABLE_MEMORY_SIZE) {
                return Err(format!(
                    "prepared main-thread stack size must be a non-negative integer no greater than \
                     {MAX_EXECUTABLE_MEMORY_SIZE} bytes"
                ));
            }
            // Executable build: place platform definitions before caller
            // inputs and leave the final libc archive available for
            // everything still unresolved.
            let thread_slots = infer_thread_slots(&parsed, user_args);
            if thread_slots != THREAD_SLOT_USE_HOST_DEFAULT {
                args.push(thread_slot_declaration_define(thread_slots));
            }
            let glue = match glue_objects {
                Some(objects) => objects.clone(),
                None => glue_sources(
                    toolchain,
                    parsed.link_dl,
                    links_cxx_runtime(language, &filtered),
                ),
            };
            args.extend(glue.leading);
            let lib = join(&toolchain.sysroot, "lib");
            args.push(join(&lib, "crt1.o"));
            args.extend(parsed.forwarded_args.iter().cloned());
            args.extend(sdk_compile_args);
            // Where clang puts the C++ library: after the caller's inputs,
            // before libc. Side modules (above) take it from the program
            // that loads them.
            if links_cxx_stdlib(language, &filtered) {
                args.extend(["-lc++", "-lc++abi"].map(String::from));
            }
            // The minimal C++ runtime is a fallback for C++ code linked
            // without libc++ and libc++abi. As a lazy member after them it
            // supplies only what they did not: libc++'s operator new, which
            // throws std::bad_alloc, is weak like the fallback's, so a
            // fallback object linked earlier would win and abort instead.
            if !glue.fallback.is_empty() {
                args.push("-Wl,--start-lib".into());
                args.extend(glue.fallback);
                args.push("-Wl,--end-lib".into());
            }
            args.push(join(&lib, "libc.a"));
            // LLD 22 made --stack-first the default; LLD 21 neither defaults to
            // it nor accepts --no-stack-first. Preserve Kandelo's established
            // stack-after-data layout explicitly only where the option exists.
            if lld_major >= 22 {
                args.push("-Wl,--no-stack-first".into());
            }
            args.extend(link_flags(
                arch,
                &host_imports_allowance(&toolchain.glue_dir),
                prepared_stack_size,
            ));
        }
    }

    Ok(args)
}

pub fn build_clang_args(
    user_args: &[String],
    toolchain: &Toolchain,
    arch: WasmArch,
    language: Language,
    executable_linker: Option<LinkerPreparation>,
    glue_objects: Option<&Glue>,
) -> Result<Vec<String>> {
    build_clang_args_internal(
        user_args,
        toolchain,
        arch,
        language,
        executable_linker.map(Preparation::Prepared),
        true,
        false,
        glue_objects,
    )
}

/// A private temporary directory, removed when dropped.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(prefix: &str) -> Result<TempDir> {
        let base = std::env::temp_dir();
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for attempt in 0u32..1000 {
            let name = format!("{prefix}{:x}-{:x}-{attempt}", std::process::id(), seed);
            let path = base.join(name);
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            match builder.create(&path) {
                Ok(()) => return Ok(TempDir(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "cannot create a temporary directory in {}: {error}",
                        base.display()
                    ));
                }
            }
        }
        Err(format!(
            "cannot create a temporary directory in {}",
            base.display()
        ))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Keep long normalized compiler invocations below host argv limits. LLVM's
/// GNU response syntax quotes each argument, preserving ordering and escapes.
fn compiler_command_args(args: &[String]) -> Result<(Vec<String>, Option<TempDir>)> {
    if args.iter().map(|arg| arg.len() + 1).sum::<usize>() < 16 * 1024 {
        return Ok((args.to_vec(), None));
    }
    let directory = TempDir::new("kandelo-compiler-args-")?;
    let path = directory.path().join("command.rsp");
    let contents = args
        .iter()
        .map(|arg| format!("\"{}\"", arg.replace('\\', "\\\\").replace('\"', "\\\"")))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&path, contents)
        .map_err(|error| format!("cannot write compiler response file: {error}"))?;
    Ok((vec![format!("@{}", path.display())], Some(directory)))
}

fn run_compiler(compiler: &str, args: &[String]) -> Result<RunResult> {
    let (args, _directory) = compiler_command_args(args)?;
    Ok(run(compiler, &args, None))
}

fn run_compiler_passthrough(compiler: &str, args: &[String]) -> Result<i32> {
    let (args, _directory) = compiler_command_args(args)?;
    Ok(run_passthrough(compiler, &args))
}

/// Compile the link-time glue for an executable link into a temporary
/// directory. Returns the objects (in link order) and the directory holding
/// them, or `None` when this invocation is not an executable link.
pub fn compile_executable_glue(
    user_args: &[String],
    toolchain: &Toolchain,
    arch: WasmArch,
    language: Language,
    executable_linker: Option<LinkerPreparation>,
) -> Result<Option<(Glue, TempDir)>> {
    if !matches!(
        executable_linker,
        Some(LinkerPreparation::ExecutableLink { .. })
    ) {
        return Ok(None);
    }
    let filtered = filter_args(user_args, arch).filtered;
    let parsed = parse_args(&filtered)?;
    if parsed.shared {
        return Ok(None);
    }
    let define = executable_thread_slot_define(user_args, arch)?;
    let dir = TempDir::new("kandelo-glue-")?;
    let sources = glue_sources(
        toolchain,
        parsed.link_dl,
        links_cxx_runtime(language, &filtered),
    );
    let (cxx_sources, c_sources): (Vec<String>, Vec<String>) = sources
        .leading
        .iter()
        .chain(&sources.fallback)
        .cloned()
        .partition(|source| is_cxx_glue(source));
    // One compiler process per glue language: `-c` with several inputs
    // writes <basename>.o files into the working directory. The C glue must
    // not get the C++ exception flags, so C++ glue has its own process.
    let mut compiles = vec![build_glue_compile_args(
        &c_sources,
        toolchain,
        arch,
        define.as_deref(),
    )];
    if !cxx_sources.is_empty() {
        compiles.push(build_cxx_glue_compile_args(&cxx_sources, toolchain, arch));
    }
    for args in &compiles {
        // The glue is the SDK's code, compiled with the SDK's flags: a
        // caller's CCC_OVERRIDE_OPTIONS edits the caller's own clang jobs,
        // not this one. (It could also move this compile's working
        // directory, and with it the objects, out of the directory the link
        // reads them from.)
        let result = run_without_env(
            &toolchain.cc,
            args,
            Some(dir.path()),
            &["CCC_OVERRIDE_OPTIONS"],
        );
        if result.exit_code != 0 {
            return Err(format!(
                "compiling SDK glue failed:\n{}",
                result.stderr.trim()
            ));
        }
    }
    let dir_text = dir.path().to_string_lossy().into_owned();
    let object = |source: &String| {
        let name = basename(source);
        let object = match name
            .strip_suffix(".cpp")
            .or_else(|| name.strip_suffix(".c"))
        {
            Some(stem) => format!("{stem}.o"),
            None => name.to_string(),
        };
        node_path::join(&[&dir_text, &object])
    };
    let objects = Glue {
        leading: sources.leading.iter().map(object).collect(),
        fallback: sources.fallback.iter().map(object).collect(),
    };
    Ok(Some((objects, dir)))
}

pub fn prepare_executable_linker(
    user_args: &[String],
    toolchain: &mut Toolchain,
    arch: WasmArch,
    language: Language,
    compiler: &str,
) -> Result<Option<LinkerPreparation>> {
    let parsed = parse_args(&filter_args(user_args, arch).filtered)?;
    if !needs_linking(&parsed) || parsed.shared {
        return Ok(None);
    }

    let classification_args = build_clang_args_internal(
        user_args, toolchain, arch, language, None, false, true, None,
    )?;
    let classification = run_compiler(compiler, &with_trace_flag(&classification_args))?;
    if classification.exit_code != 0 {
        return Err(format!(
            "clang -### failed while classifying the requested jobs:\n{}",
            classification.stderr.trim()
        ));
    }
    let linker_path = join(&toolchain.llvm_dir, "wasm-ld");
    if linker_args_from_clang_trace(&classification.stderr, &linker_path)?.is_none() {
        return Ok(Some(LinkerPreparation::NoLink));
    }

    toolchain.lld_major = Some(resolve_lld_major(&toolchain.llvm_dir)?);
    // `MeasureOnly`, not a real executable link: this trace exists only to
    // discover what the caller actually asked for (with the same crt1.o/glue
    // shape as the real build, so a cc1 job — and with it a working
    // directory for response-file resolution — is guaranteed even for an
    // object-only link). It carries no SDK-injected stack-size flag.
    let provisional = build_clang_args_internal(
        user_args,
        toolchain,
        arch,
        language,
        Some(Preparation::MeasureOnly),
        false,
        false,
        None,
    )?;
    let trace = run_compiler(compiler, &with_trace_flag(&provisional))?;
    if trace.exit_code != 0 {
        return Err(format!(
            "clang -### failed while preparing the executable link:\n{}",
            trace.stderr.trim()
        ));
    }

    let Some(linker_args) = linker_args_from_clang_trace(&trace.stderr, &linker_path)? else {
        return Err("clang -### omitted the pinned linker from a confirmed executable link".into());
    };
    let mut traced_working_directory: Option<String> = None;
    let mut reader = |path: &str| -> Result<Option<ResponseFileContents>> {
        let directory = if is_absolute(path) {
            traced_working_directory.clone().unwrap_or_else(cwd)
        } else {
            if traced_working_directory.is_none() {
                traced_working_directory =
                    Some(working_directory_from_clang_trace(&trace.stderr, &cwd())?);
            }
            traced_working_directory.clone().expect("set above")
        };
        Ok(read_llvm_response_file(path, &directory))
    };
    let size = main_thread_stack_size(&linker_args, Some(&mut reader))?;
    Ok(Some(LinkerPreparation::ExecutableLink {
        main_thread_stack_size_bytes: size,
    }))
}

fn with_trace_flag(args: &[String]) -> Vec<String> {
    let mut traced = Vec::with_capacity(args.len() + 1);
    traced.push("-###".to_string());
    traced.extend(args.iter().cloned());
    traced
}

/// The import whose presence makes a module fork-capable (wasm-fork-instrument's default entry).
pub const FORK_ENTRY_IMPORT: (&str, &str) = ("kernel", "kernel_fork");

const KEEP_TARGET_FEATURES: &str = "--keep-section=target_features";

/// [RUNTIME-WORKAROUND: BINARYEN-133-CONSTRAINT-ANALYSIS] Binaryen 133
/// runs its new `constraint-analysis` pass at -O3, -O4, -Os and -Oz, and the
/// pass aborts on code LLVM 23 emits (FFmpeg's `ff_spatial_dwt`). The fix,
/// WebAssembly/binaryen#9258, is in no release yet. The pass also had a run
/// of wrong-code fixes before 133, and it measured no worthwhile size or
/// speed win on Kandelo's programs, so Kandelo skips it. Re-enabling it is
/// a separate, re-measured decision: see
/// tests/runtime-workarounds/BINARYEN-133-CONSTRAINT-ANALYSIS/entry.md and
/// "Revisit Binaryen's constraint-analysis pass" in
/// docs/future-improvements.md. fork-instrument's post-instrumentation
/// wasm-opt carries the same flag (crates/fork-instrument/src/cli/optimize.rs).
///
/// wasm-opt accepts `--skip-pass` with a pass name it does not know, so the
/// flag is harmless with a Binaryen that lacks the pass and at levels that
/// do not schedule it.
pub const SKIP_CONSTRAINT_ANALYSIS: &str = "--skip-pass=constraint-analysis";

/// The post-link wasm-opt job the driver runs for a module that does not
/// fork: clang's scheduled job, plus `SKIP_CONSTRAINT_ANALYSIS`.
pub fn post_link_wasm_opt_job(job: &[String]) -> Vec<String> {
    let mut job = job.to_vec();
    job.push(SKIP_CONSTRAINT_ANALYSIS.into());
    job
}

fn without_one(args: &[String], value: &str) -> Vec<String> {
    let mut out = args.to_vec();
    if let Some(index) = out.iter().position(|a| a == value) {
        out.remove(index);
    }
    out
}

/// The traced wasm-ld argv with the compile jobs' temporary objects (random
/// names, different in every trace) replaced by their job order, so two
/// traces of one command compare equal.
fn comparable_linker(jobs: &[Vec<String>], linker: &[String]) -> Vec<String> {
    let mut temporaries: HashMap<String, String> = HashMap::new();
    for job in jobs {
        if job.get(1).map(String::as_str) != Some("-cc1") {
            continue;
        }
        if let Some(output) = job
            .iter()
            .position(|a| a == "-o")
            .and_then(|i| job.get(i + 1))
        {
            let label = format!("<compile-job-{}>", temporaries.len());
            temporaries.insert(output.clone(), label);
        }
    }
    without_one(linker, KEEP_TARGET_FEATURES)
        .into_iter()
        .map(|arg| temporaries.get(&arg).cloned().unwrap_or(arg))
        .collect()
}

/// Does the linked module import the fork entry? Such a link skips clang's
/// scheduled post-link wasm-opt and keeps its facts.
///
/// WHY: a fork-capable module is instrumented next, and the instrumenter
/// analyses it with the per-function facts in its `kandelo.calltypes`
/// section. Binaryen's inlining would move call sites between functions and
/// make those facts describe the wrong functions, so the module must reach
/// the instrumenter as wasm-ld wrote it. The instrumenter runs wasm-opt
/// itself after instrumenting. Any other module needs no facts: it loses the
/// section and gets the optimization clang scheduled, with one Binaryen pass
/// skipped (`SKIP_CONSTRAINT_ANALYSIS`).
pub fn is_fork_capable(module: &[u8]) -> Result<bool> {
    imports_function(module, FORK_ENTRY_IMPORT.0, FORK_ENTRY_IMPORT.1)
}

fn is_linker_job(job: &[String]) -> bool {
    executable_name(job.first().map_or("", String::as_str)) == "wasm-ld"
}

/// Run the compiler driver. Compile-only invocations pass straight through.
/// A link is run with clang's post-link wasm-opt (if clang schedules one)
/// held back, then finished per `is_fork_capable`. An executable link passes
/// its SDK's program ABI-contract digest as `abi_contract`, which the
/// finished program carries (`stamp_abi_contract`).
pub fn run_compiler_driver(
    compiler: &str,
    args: &[String],
    linking: bool,
    abi_contract: Option<&[u8; 32]>,
) -> Result<i32> {
    if !linking || args.iter().any(|a| a == "-###") {
        return run_compiler_passthrough(compiler, args);
    }
    let trace = run_compiler(compiler, &with_trace_flag(args))?;
    // A failing trace is a failing command: let the real run report it.
    if trace.exit_code != 0 {
        return run_compiler_passthrough(compiler, args);
    }
    let jobs = traced_jobs(&trace.stderr)?;
    let wasm_opt: Vec<&Vec<String>> = jobs.iter().filter(|job| is_wasm_opt_job(job)).collect();
    let linkers: Vec<&Vec<String>> = jobs.iter().filter(|job| is_linker_job(job)).collect();
    // Anything else would leave facts in a module that must not carry them,
    // or optimize one that must reach the instrumenter unoptimized.
    if linkers.len() != 1 || wasm_opt.len() > 1 {
        return Err(format!(
            "clang -### emitted {} wasm-ld and {} wasm-opt jobs for a link; expected one and at most one",
            linkers.len(),
            wasm_opt.len()
        ));
    }
    let linker = linkers[0];
    let Some(output_arg) = linker
        .iter()
        .position(|a| a == "-o")
        .and_then(|i| linker.get(i + 1))
    else {
        return Err("clang -### emitted a wasm-ld job without an output".into());
    };
    // A link with no compile jobs runs the driver in this directory.
    let working_directory =
        working_directory_from_clang_trace(&trace.stderr, &cwd()).unwrap_or_else(|_| cwd());
    let output = resolve(&working_directory, output_arg);

    // `--no-wasm-opt` also drops the target_features section clang keeps for
    // wasm-opt to read; keep it explicitly so the link itself is unchanged.
    // Prove that against clang's own trace rather than assume it.
    let mut link_args = args.to_vec();
    if wasm_opt.len() == 1 {
        link_args.push("--no-wasm-opt".into());
        link_args.push(format!("-Wl,{KEEP_TARGET_FEATURES}"));
        let held_back = run_compiler(compiler, &with_trace_flag(&link_args))?;
        let held_back_jobs = if held_back.exit_code == 0 {
            traced_jobs(&held_back.stderr)?
        } else {
            Vec::new()
        };
        let held_back_linkers: Vec<&Vec<String>> = held_back_jobs
            .iter()
            .filter(|job| is_linker_job(job))
            .collect();
        if held_back_jobs.iter().any(|job| is_wasm_opt_job(job))
            || held_back_linkers.len() != 1
            || comparable_linker(&held_back_jobs, held_back_linkers[0])
                != comparable_linker(&jobs, linker)
        {
            return Err(
                "clang changed the wasm-ld command when its post-link wasm-opt was held back"
                    .into(),
            );
        }
    }
    let exit_code = run_compiler_passthrough(compiler, &link_args)?;
    if exit_code != 0 {
        return Ok(exit_code);
    }

    // No readable output (e.g. -o /dev/null on some hosts): nothing to inspect.
    let module = std::fs::read(&output).ok();
    if let Some(module) = module.as_deref().filter(|m| is_wasm_module(m)) {
        let facts = wasm_artifact::read_artifact_facts(module).map_err(|error| error.0)?;
        let failures = wasm_artifact::program_extensions::describe_failures(
            &facts,
            wasm_artifact::program_extensions::IMPLEMENTED,
        );
        if !failures.is_empty() {
            return Err(failures.join("; "));
        }
        if is_fork_capable(module)? {
            if let Some(hashed) = with_code_hash_section(module)? {
                write_output(&output, &hashed)?;
            }
            stamp_abi_contract(&output, abi_contract)?;
            return Ok(0);
        }
        if let Some(stripped) = without_custom_section(module, CALLTYPES_SECTION)? {
            write_output(&output, &stripped)?;
        }
    }
    if let Some(job) = wasm_opt.first() {
        // [RUNTIME-WORKAROUND: BINARYEN-133-CONSTRAINT-ANALYSIS] skip the pass.
        let job = post_link_wasm_opt_job(job);
        let exit_code = run_passthrough(&job[0], &job[1..]);
        if exit_code != 0 {
            return Ok(exit_code);
        }
    }
    stamp_abi_contract(&output, abi_contract)?;
    Ok(0)
}

/// Append the SDK's `kandelo.abi.contract` digest to a linked program, after
/// every other post-link edit.
///
/// WHY at link time: the host compares this digest with the running kernel's
/// before it runs a program, and refuses a mismatch, but admits a program
/// without one unchecked, with a warning. Stamping only where packages are
/// admitted left every program linked elsewhere unchecked: test programs, ad
/// hoc builds, and the tools a build compiles and then runs inside Kandelo.
/// wasm-opt and the fork instrumenter keep the section, and package
/// admission accepts a stamp equal to its own.
///
/// A relocatable object is not a program: a later link would concatenate its
/// section into the program it ends up in.
fn stamp_abi_contract(output: &str, abi_contract: Option<&[u8; 32]>) -> Result<()> {
    let Some(digest) = abi_contract else {
        return Ok(());
    };
    // No readable output (e.g. -o /dev/null on some hosts): nothing to stamp.
    let Ok(module) = std::fs::read(output) else {
        return Ok(());
    };
    if !is_wasm_module(&module) || is_relocatable(&module)? {
        return Ok(());
    }
    if let Some(stamped) = with_abi_contract_section(&module, digest)? {
        write_output(output, &stamped)?;
    }
    Ok(())
}

fn write_output(path: &str, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes).map_err(|error| format!("cannot write {path}: {error}"))
}

/// Does this invocation compile anything (and so need the facts plugin)?
pub fn may_compile(user_args: &[String], arch: WasmArch) -> Result<bool> {
    let parsed = parse_args(&filter_args(user_args, arch).filtered)?;
    Ok(!parsed.source_files.is_empty()
        || parsed.compile_only
        || parsed.assembly_only
        || needs_linking(&parsed))
}

/// The shared entry of wasm{32,64}posix-cc and -c++: the exit status.
pub fn compiler_main(arch: WasmArch, language: Language, user_args: &[String]) -> Result<i32> {
    // Build systems use compiler response files once their link command grows.
    // Apply the same SDK target/flag/glue contract inside them as on argv.
    // Linker-only -Wl,@file remains governed by the traced linker preparation.
    let directory = cwd();
    let expanded = expand_response_files(user_args, &mut |path| {
        Ok(read_llvm_response_file(path, &directory))
    })?;
    let user_args = expanded.as_slice();
    let mut toolchain = crate::toolchain::resolve_toolchain(arch)?;
    if user_args == ["--print-kandelo-sdk"] {
        return print_sdk_identity(&toolchain);
    }
    let compiler = match language {
        Language::C => toolchain.cc.clone(),
        Language::Cxx => toolchain.cxx.clone(),
    };
    if may_compile(user_args, arch)? {
        toolchain.calltypes_plugin = Some(crate::plugin::ensure_calltypes_plugin(&toolchain.cc)?);
    }
    let executable_linker =
        prepare_executable_linker(user_args, &mut toolchain, arch, language, &compiler)?;
    let glue = compile_executable_glue(user_args, &toolchain, arch, language, executable_linker)?;
    // An executable link links the glue, and carries the glue's digest.
    let abi_contract = glue
        .as_ref()
        .map(|_| read_abi_contract_digest(&toolchain.glue_dir))
        .transpose()?;
    let args = build_clang_args(
        user_args,
        &toolchain,
        arch,
        language,
        executable_linker,
        glue.as_ref().map(|(objects, _)| objects),
    )?;
    let parsed = parse_args(&filter_args(user_args, arch).filtered)?;
    let linking = needs_linking(&parsed) && executable_linker != Some(LinkerPreparation::NoLink);
    let result = run_compiler_driver(&compiler, &args, linking, abi_contract.as_ref());
    drop(glue);
    result
}

#[cfg(test)]
mod compiler_response_tests {
    use super::*;

    #[test]
    fn long_compiler_commands_preserve_order_and_quoting_in_private_response_files() {
        let mut args = vec![
            "space path.o".to_string(),
            "-DQUOTE=\"hello\"".to_string(),
            "-DBACKSLASH=a\\b".to_string(),
            "-DMULTILINE=a\nb".to_string(),
        ];
        args.extend((0..1000).map(|i| format!("/long dependency path/{i}.a")));
        let (command, owner) = compiler_command_args(&args).unwrap();
        let owner = owner.expect("long command needs owned response storage");
        assert_eq!(
            command,
            [format!("@{}", owner.path().join("command.rsp").display())]
        );
        let encoded = std::fs::read_to_string(owner.path().join("command.rsp")).unwrap();
        assert_eq!(tokenize_gnu_response_file(&encoded), args);
        let path = owner.path().to_path_buf();
        drop(owner);
        assert!(!path.exists());
    }
}

/// Identify the SDK used by an external compiler that caches linked outputs.
fn print_sdk_identity(toolchain: &Toolchain) -> Result<i32> {
    use sha2::{Digest, Sha256};

    let sysroot = std::fs::canonicalize(&toolchain.sysroot)
        .map_err(|error| format!("cannot resolve sysroot {}: {error}", toolchain.sysroot))?;
    let sysroot = sysroot
        .to_str()
        .filter(|path| !path.contains(['\n', '\r']))
        .ok_or("SDK identity requires a UTF-8 sysroot path without line breaks")?;

    let mut hash = Sha256::new();
    hash.update(read_abi_contract_digest(&toolchain.glue_dir)?);
    hash.update(toolchain.llvm_dir.as_bytes());
    hash.update([0]);
    let mut inputs = vec![
        join(&toolchain.sysroot, "lib/crt1.o"),
        join(&toolchain.sysroot, "lib/libc.a"),
        host_imports_allowance(&toolchain.glue_dir),
    ];
    let glue = glue_sources(toolchain, true, true);
    inputs.extend(glue.leading);
    inputs.extend(glue.fallback);
    inputs.extend(
        std::fs::read_dir(&toolchain.glue_dir)
            .map_err(|error| format!("cannot read SDK glue directory: {error}"))?
            .filter_map(|entry| match entry {
                Ok(entry) if entry.path().extension().is_some_and(|ext| ext == "h") => {
                    Some(Ok(entry.path().to_string_lossy().into_owned()))
                }
                Ok(_) => None,
                Err(error) => Some(Err(format!("cannot read SDK glue directory: {error}"))),
            })
            .collect::<Result<Vec<_>>>()?,
    );
    inputs.sort_unstable();
    let driver =
        std::env::current_exe().map_err(|error| format!("cannot locate SDK driver: {error}"))?;
    for path in inputs
        .iter()
        .map(std::path::Path::new)
        .chain([driver.as_path()])
    {
        let bytes = std::fs::read(path)
            .map_err(|error| format!("cannot read SDK input {}: {error}", path.display()))?;
        hash.update(Sha256::digest(bytes));
    }
    println!("{sysroot}\n{:x}", hash.finalize());
    Ok(0)
}
