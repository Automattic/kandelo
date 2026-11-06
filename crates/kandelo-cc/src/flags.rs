//! The SDK's compile and link flags, and its reading of a caller's arguments.

use crate::Result;
use crate::arch::{WasmArch, target_triple, tool_prefix};
use std::collections::HashSet;

pub fn compile_flags(arch: WasmArch) -> Vec<String> {
    let mut flags = vec![format!("--target={}", target_triple(arch))];
    flags.extend(
        [
            // LLVM's generic wasm target has no operating-system identity, but
            // Kandelo is a Unix/POSIX userspace. Publish that source-environment
            // contract through the reserved macros that Unix compilers
            // conventionally predefine. This keeps upstream feature selection
            // (including SDL's Unix platform headers) truthful without claiming
            // Linux or another host OS.
            "-D__unix__=1",
            "-D__unix=1",
            "-matomics",
            "-mbulk-memory",
            "-mexception-handling",
            "-mllvm",
            "-wasm-enable-sjlj",
            // Modern wasm-EH lowering. LLVM 21's default for
            // `-wasm-use-legacy-eh` is `true`, so `try_table`/`catch_ref`
            // needs `=false` explicitly.
            "-mllvm",
            "-wasm-use-legacy-eh=false",
            "-fno-trapping-math",
        ]
        .map(String::from),
    );
    flags
}

/// How a compile loads the KandeloCallTypes compiler plugin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallTypesPlugin {
    /// A shared library the compiler loads (the build machine's clang).
    Library(String),
    /// Compiled into the compiler itself (Kandelo's own clang, which cannot
    /// load native shared libraries). The plugin's Clang half registers its
    /// LLVM passes when it is activated, so activating it is the whole load.
    BuiltIn,
}

/// Load the KandeloCallTypes plugin into a compile, so each object carries a
/// `kandelo.calltypes` section.
///
/// WHY these cc1 flags: the plugin reads indirect-call type ids from clang's
/// CFI type tests (cfi-icall, trap mode so no runtime is referenced) and
/// vtable type metadata (-flto-unit, -fwhole-program-vtables). They go
/// through -Xclang because the driver would demand -flto for them; the
/// plugin's first pass deletes every test it recorded, so the optimizer and
/// code generator see the ordinary build and the code does not change. The
/// same library is a Clang AST plugin (kandelo-fncasts) and an LLVM pass
/// plugin.
pub fn calltypes_plugin_flags(plugin: &CallTypesPlugin) -> Vec<String> {
    let mut flags: Vec<String> = [
        "-Xclang",
        "-fsanitize=cfi-icall",
        "-Xclang",
        "-fsanitize-trap=cfi-icall",
        "-Xclang",
        "-flto-unit",
        "-Xclang",
        "-fwhole-program-vtables",
    ]
    .map(String::from)
    .to_vec();
    match plugin {
        CallTypesPlugin::Library(path) => {
            flags.extend(["-Xclang", "-load", "-Xclang"].map(String::from));
            flags.push(path.clone());
            flags
                .extend(["-Xclang", "-add-plugin", "-Xclang", "kandelo-fncasts"].map(String::from));
            flags.push(format!("-fpass-plugin={path}"));
        }
        CallTypesPlugin::BuiltIn => {
            flags
                .extend(["-Xclang", "-add-plugin", "-Xclang", "kandelo-fncasts"].map(String::from));
        }
    }
    flags
}

/// Does this invocation's own sanitizer request include CFI? The plugin
/// deletes CFI type tests after recording them, which would silently remove
/// a check the caller asked for, so such compiles go without facts.
pub fn requests_cfi(args: &[String]) -> bool {
    args.iter().any(|arg| {
        arg.strip_prefix("-fsanitize=")
            .is_some_and(|kinds| kinds.split(',').any(|kind| kind.starts_with("cfi")))
    })
}

pub const DEFAULT_MAIN_THREAD_STACK_SIZE: u64 = 8 * 1024 * 1024;
pub const MAX_EXECUTABLE_MEMORY_SIZE: u64 = 1024 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
enum ParsedStackSize {
    Valid(u64),
    Invalid,
    Overflow,
}

fn all_chars(value: &str, allowed: impl Fn(char) -> bool) -> bool {
    !value.is_empty() && value.chars().all(allowed)
}

fn parse_lld_stack_size(value: &str) -> ParsedStackSize {
    // Match LLVM 21's radix-0 integer grammar exactly. Invalid spellings are
    // left for wasm-ld to reject so the compiler driver never rewrites input.
    let (digits, radix): (&str, u32) = if (value.starts_with("0x") || value.starts_with("0X"))
        && all_chars(&value[2..], |c| c.is_ascii_hexdigit())
    {
        (&value[2..], 16)
    } else if (value.starts_with("0b") || value.starts_with("0B"))
        && all_chars(&value[2..], |c| c == '0' || c == '1')
    {
        (&value[2..], 2)
    } else if value.starts_with("0o") && all_chars(&value[2..], |c| ('0'..='7').contains(&c)) {
        (&value[2..], 8)
    } else if value.starts_with('0') && value[1..].chars().all(|c| ('0'..='7').contains(&c)) {
        (if value.len() == 1 { "0" } else { &value[1..] }, 8)
    } else if value.starts_with(|c: char| ('1'..='9').contains(&c))
        && value.chars().all(|c| c.is_ascii_digit())
    {
        (value, 10)
    } else {
        return ParsedStackSize::Invalid;
    };

    let trimmed = digits.trim_start_matches('0');
    let significant = if trimmed.is_empty() { "0" } else { trimmed };
    let max_digits = match radix {
        2 => 31,
        8 => 11,
        10 => 10,
        _ => 8,
    };
    if significant.len() > max_digits {
        return ParsedStackSize::Overflow;
    }
    let parsed = u64::from_str_radix(significant, radix).expect("digits already checked");
    if parsed > MAX_EXECUTABLE_MEMORY_SIZE {
        return ParsedStackSize::Overflow;
    }
    ParsedStackSize::Valid(parsed)
}

pub const MAX_RESPONSE_FILE_EXPANSIONS: usize = 4096;
pub const MAX_RESPONSE_FILE_TOKENS: usize = 1024 * 1024;
pub const MAX_RESPONSE_FILE_CHARACTERS: usize = 64 * 1024 * 1024;

pub struct ResponseFileContents {
    pub contents: String,
    /// Canonical identity used only while this file is active in the expansion stack.
    pub identity: String,
}

/// Reads one response file; `Ok(None)` when it cannot be read.
pub type ResponseFileReader<'a> = dyn FnMut(&str) -> Result<Option<ResponseFileContents>> + 'a;

fn is_gnu_response_whitespace(c: char) -> bool {
    c == ' ' || c == '\t' || c == '\r' || c == '\n'
}

/// Match LLVM's POSIX TokenizeGNUCommandLine response-file grammar.
pub fn tokenize_gnu_response_file(source: &str) -> Vec<String> {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let chars: Vec<char> = source.chars().collect();
    let len = chars.len();
    let mut tokens = Vec::new();
    let mut token = String::new();

    let mut i = 0;
    while i < len {
        if token.is_empty() {
            while i < len && is_gnu_response_whitespace(chars[i]) {
                i += 1;
            }
            if i == len {
                break;
            }
        }

        let c = chars[i];
        if c == '\\' && i + 1 < len {
            i += 1;
            token.push(chars[i]);
            i += 1;
            continue;
        }

        if c == '\'' || c == '"' {
            let quote = c;
            i += 1;
            while i < len && chars[i] != quote {
                if chars[i] == '\\' && i + 1 < len {
                    i += 1;
                }
                token.push(chars[i]);
                i += 1;
            }
            if i == len {
                break;
            }
            i += 1;
            continue;
        }

        if is_gnu_response_whitespace(c) {
            if !token.is_empty() {
                tokens.push(std::mem::take(&mut token));
            }
            i += 1;
            continue;
        }

        token.push(c);
        i += 1;
    }

    if !token.is_empty() {
        tokens.push(token);
    }
    tokens
}

/// `value` as a JSON string literal, for error messages that name a path.
pub fn json_quote(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn expand_response_files(
    args: &[String],
    read_response_file: &mut ResponseFileReader<'_>,
) -> Result<Vec<String>> {
    enum WorkItem {
        Argument(String),
        Leave(String),
    }
    let mut expanded = Vec::new();
    let mut active_files: HashSet<String> = HashSet::new();
    let mut work: Vec<WorkItem> = args.iter().rev().cloned().map(WorkItem::Argument).collect();

    let mut file_expansions = 0;
    let mut examined_tokens = args.len();
    let mut decoded_characters = 0;
    if examined_tokens > MAX_RESPONSE_FILE_TOKENS {
        return Err(format!(
            "response-file expansion exceeds the {MAX_RESPONSE_FILE_TOKENS}-token safety limit"
        ));
    }

    while let Some(item) = work.pop() {
        let arg = match item {
            WorkItem::Leave(identity) => {
                active_files.remove(&identity);
                continue;
            }
            WorkItem::Argument(arg) => arg,
        };
        if !arg.starts_with('@') || arg.len() == 1 {
            expanded.push(arg);
            continue;
        }
        let path = &arg[1..];
        let Some(response_file) = read_response_file(path)? else {
            return Err(format!(
                "cannot inspect response file {} before linking",
                json_quote(path)
            ));
        };
        if response_file.identity.is_empty() {
            return Err(format!(
                "response file {} has no canonical identity",
                json_quote(path)
            ));
        }
        if active_files.contains(&response_file.identity) {
            return Err(format!(
                "recursive response file {} cannot be inspected safely",
                json_quote(path)
            ));
        }

        file_expansions += 1;
        if file_expansions > MAX_RESPONSE_FILE_EXPANSIONS {
            return Err(format!(
                "response-file expansion exceeds the {MAX_RESPONSE_FILE_EXPANSIONS}-file safety limit"
            ));
        }
        // Characters are counted as UTF-16 code units, like the limit's
        // original JavaScript definition.
        decoded_characters += response_file.contents.encode_utf16().count();
        if decoded_characters > MAX_RESPONSE_FILE_CHARACTERS {
            return Err(format!(
                "response-file expansion exceeds the {MAX_RESPONSE_FILE_CHARACTERS}-character safety limit"
            ));
        }

        let nested = tokenize_gnu_response_file(&response_file.contents);
        examined_tokens += nested.len();
        if examined_tokens > MAX_RESPONSE_FILE_TOKENS {
            return Err(format!(
                "response-file expansion exceeds the {MAX_RESPONSE_FILE_TOKENS}-token safety limit"
            ));
        }

        active_files.insert(response_file.identity.clone());
        work.push(WorkItem::Leave(response_file.identity));
        work.extend(nested.into_iter().rev().map(WorkItem::Argument));
    }

    Ok(expanded)
}

/// Apply the SDK's stack-size floor when no explicit request is present, and
/// otherwise honour the caller's explicit request verbatim — even below the
/// floor — the same way repeated `-z stack-size=` operands resolve in
/// wasm-ld itself: last one wins. Callers pass the exact argv emitted for
/// wasm-ld by Clang's `-###` trace. That keeps Clang's option classification
/// and ordering in Clang itself instead of duplicating its driver option
/// table here.
pub fn main_thread_stack_size(
    linker_args: &[String],
    read_response_file: Option<&mut ResponseFileReader<'_>>,
) -> Result<u64> {
    let mut result = DEFAULT_MAIN_THREAD_STACK_SIZE;

    let mut consider = |value: &str| -> Result<()> {
        match parse_lld_stack_size(value) {
            ParsedStackSize::Overflow => Err(format!(
                "stack-size={value} exceeds the SDK's {MAX_EXECUTABLE_MEMORY_SIZE}-byte executable memory limit"
            )),
            ParsedStackSize::Invalid => Ok(()),
            ParsedStackSize::Valid(requested) => {
                if requested < DEFAULT_MAIN_THREAD_STACK_SIZE {
                    // HONOUR IT, LOUDLY. Absence of a request gets the floor (a
                    // default); an explicit smaller request is a choice. The
                    // warning is informational, not the safety mechanism:
                    // WebAssembly has no stack guard page, so an overflow
                    // corrupts .bss rather than trapping. The DEFAULT is the
                    // protection.
                    eprintln!(
                        "wasm32posix: stack-size={requested} is below the SDK floor of \
                         {DEFAULT_MAIN_THREAD_STACK_SIZE}. Honouring it. WebAssembly has no \
                         stack guard page: an overflow will corrupt .bss silently instead of \
                         trapping."
                    );
                }
                result = requested;
                Ok(())
            }
        }
    };

    let lld_args = match read_response_file {
        Some(reader) => expand_response_files(linker_args, reader)?,
        None => linker_args.to_vec(),
    };
    let mut i = 0;
    while i < lld_args.len() {
        let arg = &lld_args[i];
        if arg == "--" {
            break;
        }
        if arg == "-z" {
            i += 1;
            if let Some(value) = lld_args.get(i).and_then(|v| v.strip_prefix("stack-size=")) {
                consider(value)?;
            }
            i += 1;
            continue;
        }
        if let Some(value) = arg.strip_prefix("-zstack-size=") {
            consider(value)?;
        }
        i += 1;
    }

    Ok(result)
}

/// The generated link-time allowance (see `host_imports_allowance`).
pub const HOST_IMPORTS_ALLOWANCE_FILE: &str = "kandelo-host-imports.txt";

/// Path of the link-time allowance inside a glue directory.
pub fn host_imports_allowance(glue_dir: &str) -> String {
    join(glue_dir, HOST_IMPORTS_ALLOWANCE_FILE)
}

pub fn join(dir: &str, name: &str) -> String {
    crate::node_path::join(&[dir, name])
}

/// `None` omits the stack-size flag entirely instead of falling back to the
/// default. The driver's provisional link trace uses that to take an
/// uncontaminated measurement of a caller's own `-z stack-size=` request:
/// wasm-ld resolves repeated `-z stack-size=` operands last-one-wins, so
/// injecting even the default value would override a genuine caller request
/// in the same measurement trace.
pub fn link_flags(
    _arch: WasmArch,
    host_imports_file: &str,
    main_thread_stack_size_bytes: Option<u64>,
) -> Vec<String> {
    let mut flags: Vec<String> = [
        "-nostdlib",
        // Reactor link mode leaves constructor ownership with musl. The host
        // still enters through the explicitly exported `_start` below.
        "-Wl,--no-entry",
        "-Wl,--export=_start",
        "-Wl,--export=__heap_base",
        "-Wl,--import-memory",
        "-Wl,--shared-memory",
    ]
    .map(String::from)
    .to_vec();
    flags.push(format!("-Wl,--max-memory={MAX_EXECUTABLE_MEMORY_SIZE}"));
    // An executable may leave undefined only what the host supplies:
    // libc/glue/kandelo-host-imports.txt, generated by `xtask dump-abi` from
    // shared::abi::HOST_ENV_IMPORTS. Anything else is a link error, so
    // configure checks report missing functions as missing and no program
    // ships a call that traps at run time.
    flags.push(format!("-Wl,--allow-undefined-file={host_imports_file}"));
    // Reserve an 8 MiB main-thread shadow stack by default (see
    // main_thread_stack_size and docs/sdk-guide.md): wasm-ld's default is
    // ~64 KiB and WebAssembly has no stack guard page.
    if let Some(size) = main_thread_stack_size_bytes {
        flags.push(format!("-Wl,-z,stack-size={size}"));
    }
    flags.extend(
        [
            "-Wl,--global-base=1114112",
            "-Wl,--table-base=3",
            "-Wl,--export-table",
            "-Wl,--growable-table",
            "-Wl,--export=__wasm_init_tls",
            "-Wl,--export=__tls_base",
            "-Wl,--export=__tls_size",
            "-Wl,--export=__tls_align",
            "-Wl,--export=__stack_pointer",
            "-Wl,--export=__wasm_thread_init",
            // `__abi_version` is exported by libc/glue/channel_syscall.c itself
            // (`export_name`, `used`, `retain`), so no linker flag is needed.
        ]
        .map(String::from),
    );
    flags
}

/// Link flags for building shared Wasm libraries (.so side modules).
pub fn shared_link_flags() -> Vec<String> {
    [
        // Side modules keep --allow-undefined: their undefined symbols are
        // resolved against the main program by the dynamic loader at dlopen,
        // a real dynamic-linking boundary.
        "-nostdlib",
        "-Wl,--experimental-pic",
        "-Wl,--shared",
        "-Wl,--shared-memory",
        "-Wl,--export-all",
        "-Wl,--allow-undefined",
    ]
    .map(String::from)
    .to_vec()
}

const IGNORED_EXACT: &[&str] = &[
    "-lpthread",
    "-fPIE",
    "-pie",
    "-lrt",
    "-lresolv",
    "-lm",
    "-lcrypt",
    "-lutil",
    // -lgcc_s: WebAssembly has no shared libgcc; unwinder/intrinsic symbols
    // come from the compiler runtime. A bare -lc is NOT ignored: the SDK
    // preserves and orders explicit -lc after the syscall glue.
    "-lgcc_s",
    // wasm-ld rejects --start-group/--end-group, and resolves archive members
    // regardless of command-line order. Meson emits them.
    "-Wl,--start-group",
    "-Wl,--end-group",
    "-rdynamic",
    "-Wl,-Bsymbolic",
    "-Wl,-z,noexecstack",
    "-Wl,-z,text",
    "-Wl,-z,relro",
    "-Wl,-z,now",
    "-Wl,-z,nocopyreloc",
];

const IGNORED_PREFIXES: &[&str] = &[
    "-Wl,-rpath,",
    "-Wl,-rpath-link,",
    "-Wl,-soname,",
    "-Wl,--version-script",
];

const WARN_FLAGS: &[&str] = &["-dynamiclib"];

fn is_equivalent_wasm_target(value: &str, arch: WasmArch) -> bool {
    value == target_triple(arch)
        || value == format!("{}-unknown-linux-musl", arch.as_str())
        || value == format!("{}-linux-musl", arch.as_str())
}

pub struct FilterResult {
    pub filtered: Vec<String>,
    pub warnings: Vec<String>,
}

pub fn filter_args(args: &[String], arch: WasmArch) -> FilterResult {
    let mut filtered = Vec::new();
    let mut warnings = Vec::new();
    let prefix = tool_prefix(arch);

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if let Some(value) = arg.strip_prefix("--target=") {
            if is_equivalent_wasm_target(value, arch) {
                i += 1;
                continue;
            }
        }
        if (arg == "--target" || arg == "-target")
            && i + 1 < args.len()
            && is_equivalent_wasm_target(&args[i + 1], arch)
        {
            i += 2;
            continue;
        }
        if IGNORED_EXACT.contains(&arg.as_str())
            || IGNORED_PREFIXES.iter().any(|p| arg.starts_with(p))
        {
            i += 1;
            continue;
        }
        if WARN_FLAGS.contains(&arg.as_str()) {
            warnings.push(format!(
                "{prefix}-cc: warning: {arg} is not supported for Wasm targets (ignored)"
            ));
            i += 1;
            continue;
        }
        filtered.push(arg.clone());
        i += 1;
    }

    FilterResult { filtered, warnings }
}

#[derive(Debug, Default, Clone)]
pub struct ParsedArgs {
    pub compile_only: bool,
    pub preprocess_only: bool,
    pub assembly_only: bool,
    pub shared: bool,
    pub pic: bool,
    pub link_dl: bool,
    pub thread_slots: Option<i64>,
    pub output_file: Option<String>,
    pub source_files: Vec<String>,
    pub object_files: Vec<String>,
    pub archive_files: Vec<String>,
    pub other_args: Vec<String>,
    /// Arguments forwarded to clang, in the exact order supplied by the caller.
    pub forwarded_args: Vec<String>,
}

const SOURCE_EXTS: &[&str] = &[".c", ".cc", ".cpp", ".cxx", ".m", ".mm", ".i", ".ii"];
const OBJECT_EXTS: &[&str] = &[".o", ".obj"];
const ARCHIVE_EXTS: &[&str] = &[".a"];

// Flags that consume the next argument as a value (not a file path).
const FLAGS_WITH_VALUE: &[&str] = &[
    "-MT",
    "-MF",
    "-MQ",
    "-MJ",
    "-isystem",
    "-include",
    "-imacros",
    "-idirafter",
    "-iprefix",
    "-iwithprefix",
    "-iwithprefixbefore",
    "-isysroot",
    "-target",
    "-arch",
    "-x",
    "-D",
    "-U",
    "-I",
    "-L",
    "-F",
];

/// The text from the last `.` on, or the whole argument when it has none.
fn extension(arg: &str) -> &str {
    match arg.rfind('.') {
        Some(index) => &arg[index..],
        None => arg,
    }
}

pub fn parse_args(args: &[String]) -> Result<ParsedArgs> {
    let mut result = ParsedArgs::default();

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "-c" {
            result.compile_only = true;
        } else if arg == "-shared" {
            result.shared = true;
        } else if arg == "-fPIC" {
            result.pic = true;
        } else if arg == "-ldl" {
            result.link_dl = true;
        } else if arg == "--kandelo-thread-slots" || arg == "--wasm-posix-thread-slots" {
            i += 1;
            result.thread_slots = Some(parse_thread_slot_declaration(
                args.get(i).map(String::as_str),
                arg,
            )?);
        } else if let Some(value) = arg.strip_prefix("--kandelo-thread-slots=") {
            result.thread_slots = Some(parse_thread_slot_declaration(
                Some(value),
                "--kandelo-thread-slots",
            )?);
        } else if let Some(value) = arg.strip_prefix("--wasm-posix-thread-slots=") {
            result.thread_slots = Some(parse_thread_slot_declaration(
                Some(value),
                "--wasm-posix-thread-slots",
            )?);
        } else if arg == "-E" {
            result.preprocess_only = true;
        } else if arg == "-S" {
            result.assembly_only = true;
        } else if arg == "-o" {
            i += 1;
            result.output_file = args.get(i).cloned();
        } else if arg.starts_with("-o") && arg.len() > 2 {
            result.output_file = Some(arg[2..].to_string());
        } else if FLAGS_WITH_VALUE.contains(&arg) {
            // Flag that takes the next arg as its value — keep both as otherArgs.
            result.other_args.push(arg.to_string());
            result.forwarded_args.push(arg.to_string());
            i += 1;
            if let Some(value) = args.get(i) {
                result.other_args.push(value.clone());
                result.forwarded_args.push(value.clone());
            }
        } else if !arg.starts_with('-') {
            let ext = extension(arg);
            if SOURCE_EXTS.contains(&ext) {
                result.source_files.push(arg.to_string());
            } else if OBJECT_EXTS.contains(&ext) {
                result.object_files.push(arg.to_string());
            } else if ARCHIVE_EXTS.contains(&ext) {
                result.archive_files.push(arg.to_string());
            } else {
                result.other_args.push(arg.to_string());
            }
            result.forwarded_args.push(arg.to_string());
        } else {
            result.other_args.push(arg.to_string());
            result.forwarded_args.push(arg.to_string());
        }
        i += 1;
    }

    Ok(result)
}

pub fn needs_linking(parsed: &ParsedArgs) -> bool {
    if parsed.compile_only || parsed.preprocess_only || parsed.assembly_only {
        return false;
    }
    if parsed
        .other_args
        .iter()
        .any(|arg| arg.starts_with("-Wl,@") || arg.starts_with('@'))
    {
        return true;
    }
    !parsed.source_files.is_empty() || !parsed.object_files.is_empty()
}

pub const THREAD_SLOT_USE_HOST_DEFAULT: i64 = -1;
pub const THREAD_SLOT_NONE: i64 = 0;

pub fn thread_slot_declaration_define(value: i64) -> String {
    format!("-DWASM_POSIX_THREAD_SLOT_DECL={value}")
}

const MAX_SAFE_INTEGER: i128 = (1 << 53) - 1;

pub fn parse_thread_slot_declaration(value: Option<&str>, flag: &str) -> Result<i64> {
    let value = match value {
        Some(value) if !value.is_empty() => value,
        _ => return Err(format!("{flag} requires -1, 0, or a positive integer")),
    };
    let invalid = || format!("{flag} must be -1, 0, or a positive integer");
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return Err(invalid());
    }
    let parsed: i128 = value.parse().map_err(|_| invalid())?;
    if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&parsed)
        || parsed < THREAD_SLOT_USE_HOST_DEFAULT as i128
    {
        return Err(invalid());
    }
    Ok(parsed as i64)
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// JavaScript's `\s` class.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// Every position at which `needle` occurs in `text`.
fn occurrences<'a>(text: &'a [char], needle: &'a [char]) -> impl Iterator<Item = usize> + 'a {
    (0..text.len().saturating_sub(needle.len() - 1))
        .filter(move |&i| text.len() >= i + needle.len() && &text[i..i + needle.len()] == needle)
}

fn word_starts_at(text: &[char], at: usize) -> bool {
    at == 0 || !is_word_char(text[at - 1])
}

fn skip_spaces(text: &[char], mut at: usize) -> usize {
    while at < text.len() && is_js_space(text[at]) {
        at += 1;
    }
    at
}

/// The source patterns that make a program's thread use uncertain:
/// `pthread_create`, `thrd_create`, `\bclone\s*\(`, `std::thread`,
/// `#include\s*<thread>`, `\bdlopen\b`, `__wasm_dlopen`.
fn suggests_threads_or_dynamic_linking(text: &str) -> bool {
    if [
        "pthread_create",
        "thrd_create",
        "std::thread",
        "__wasm_dlopen",
    ]
    .iter()
    .any(|literal| text.contains(literal))
    {
        return true;
    }
    let chars: Vec<char> = text.chars().collect();
    let clone: Vec<char> = "clone".chars().collect();
    if occurrences(&chars, &clone).any(|at| {
        word_starts_at(&chars, at) && chars.get(skip_spaces(&chars, at + clone.len())) == Some(&'(')
    }) {
        return true;
    }
    let include: Vec<char> = "#include".chars().collect();
    let thread: Vec<char> = "<thread>".chars().collect();
    if occurrences(&chars, &include).any(|at| {
        let rest = skip_spaces(&chars, at + include.len());
        chars.len() >= rest + thread.len() && chars[rest..rest + thread.len()] == thread[..]
    }) {
        return true;
    }
    let dlopen: Vec<char> = "dlopen".chars().collect();
    occurrences(&chars, &dlopen).any(|at| {
        let end = at + dlopen.len();
        word_starts_at(&chars, at) && (end == chars.len() || !is_word_char(chars[end]))
    })
}

fn raw_args_suggest_threads_or_dynamic_linking(args: &[String]) -> bool {
    args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "-pthread" | "-lpthread" | "-ldl" | "-shared" | "-dynamiclib" | "-rdynamic"
        ) || arg.starts_with("-Wl,-rpath")
            || arg.starts_with("-Wl,-soname")
            || arg.starts_with("-Wl,--export-dynamic")
    })
}

fn has_uncertain_link_input(parsed: &ParsedArgs) -> bool {
    if !parsed.object_files.is_empty() || !parsed.archive_files.is_empty() {
        return true;
    }
    parsed.other_args.iter().any(|arg| {
        arg == "-fuse-ld=lld"
            || arg.starts_with("-l")
            || arg.starts_with("-Wl,")
            || arg.starts_with('@')
    })
}

pub fn infer_thread_slot_declaration(
    parsed: &ParsedArgs,
    raw_args: &[String],
    read_file: &dyn Fn(&str) -> Option<String>,
) -> i64 {
    if let Some(slots) = parsed.thread_slots {
        return slots;
    }
    if parsed.shared || parsed.link_dl {
        return THREAD_SLOT_USE_HOST_DEFAULT;
    }
    if raw_args_suggest_threads_or_dynamic_linking(raw_args) || has_uncertain_link_input(parsed) {
        return THREAD_SLOT_USE_HOST_DEFAULT;
    }
    if parsed.source_files.is_empty() {
        return THREAD_SLOT_USE_HOST_DEFAULT;
    }
    for source in &parsed.source_files {
        match read_file(source) {
            None => return THREAD_SLOT_USE_HOST_DEFAULT,
            Some(text) if suggests_threads_or_dynamic_linking(&text) => {
                return THREAD_SLOT_USE_HOST_DEFAULT;
            }
            Some(_) => {}
        }
    }
    THREAD_SLOT_NONE
}

/// Read a source file as UTF-8 text (invalid sequences replaced), or `None`.
pub fn read_text_file(path: &str) -> Option<String> {
    std::fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn stack_size_grammar_matches_llvm_radix_zero() {
        assert_eq!(parse_lld_stack_size("0"), ParsedStackSize::Valid(0));
        assert_eq!(parse_lld_stack_size("017"), ParsedStackSize::Valid(15));
        assert_eq!(parse_lld_stack_size("0o17"), ParsedStackSize::Valid(15));
        assert_eq!(parse_lld_stack_size("0O17"), ParsedStackSize::Invalid);
        assert_eq!(parse_lld_stack_size("0x10"), ParsedStackSize::Valid(16));
        assert_eq!(parse_lld_stack_size("0b101"), ParsedStackSize::Valid(5));
        assert_eq!(
            parse_lld_stack_size("1048576"),
            ParsedStackSize::Valid(1048576)
        );
        assert_eq!(parse_lld_stack_size("08"), ParsedStackSize::Invalid);
        assert_eq!(parse_lld_stack_size("1k"), ParsedStackSize::Invalid);
        assert_eq!(parse_lld_stack_size(""), ParsedStackSize::Invalid);
        assert_eq!(parse_lld_stack_size("0x"), ParsedStackSize::Invalid);
        assert_eq!(
            parse_lld_stack_size("0x40000001"),
            ParsedStackSize::Overflow
        );
        assert_eq!(
            parse_lld_stack_size("99999999999"),
            ParsedStackSize::Overflow
        );
        assert_eq!(
            parse_lld_stack_size("0x0000000040000000"),
            ParsedStackSize::Valid(1 << 30)
        );
    }

    #[test]
    fn tokenizer_matches_gnu_grammar() {
        assert_eq!(
            tokenize_gnu_response_file("\u{feff} a 'b c' \"d\\\"e\" f\\ g\n"),
            strings(&["a", "b c", "d\"e", "f g"])
        );
        assert_eq!(
            tokenize_gnu_response_file("'unterminated"),
            strings(&["unterminated"])
        );
        assert_eq!(tokenize_gnu_response_file("x\\"), strings(&["x\\"]));
    }

    #[test]
    fn last_stack_request_wins() {
        let args = strings(&["-z", "stack-size=16777216", "-zstack-size=9437184"]);
        assert_eq!(main_thread_stack_size(&args, None).unwrap(), 9437184);
        assert_eq!(
            main_thread_stack_size(&[], None).unwrap(),
            DEFAULT_MAIN_THREAD_STACK_SIZE
        );
        let after_terminator = strings(&["--", "-zstack-size=9437184"]);
        assert_eq!(
            main_thread_stack_size(&after_terminator, None).unwrap(),
            DEFAULT_MAIN_THREAD_STACK_SIZE
        );
    }

    #[test]
    fn thread_patterns() {
        assert!(suggests_threads_or_dynamic_linking("x = clone (f);"));
        assert!(!suggests_threads_or_dynamic_linking("x = myclone(f);"));
        assert!(suggests_threads_or_dynamic_linking("#include  <thread>"));
        assert!(suggests_threads_or_dynamic_linking(
            "void *h = dlopen(p, 0);"
        ));
        assert!(!suggests_threads_or_dynamic_linking("my_dlopen_x(p);"));
        assert!(!suggests_threads_or_dynamic_linking(
            "int main(void) { return 0; }"
        ));
        assert!(suggests_threads_or_dynamic_linking("dlopen"));
    }

    #[test]
    fn thread_slot_values() {
        assert_eq!(parse_thread_slot_declaration(Some("-1"), "f").unwrap(), -1);
        assert_eq!(parse_thread_slot_declaration(Some("007"), "f").unwrap(), 7);
        assert!(parse_thread_slot_declaration(Some("-2"), "f").is_err());
        assert!(parse_thread_slot_declaration(Some("1.5"), "f").is_err());
        assert!(parse_thread_slot_declaration(Some("9007199254740992"), "f").is_err());
        assert!(parse_thread_slot_declaration(None, "f").is_err());
    }

    #[test]
    fn extension_without_dot_is_whole_argument() {
        let parsed = parse_args(&strings(&["main.c", "lib.a", "x.o", "c", "dir.d/file"])).unwrap();
        assert_eq!(parsed.source_files, strings(&["main.c"]));
        assert_eq!(parsed.archive_files, strings(&["lib.a"]));
        assert_eq!(parsed.object_files, strings(&["x.o"]));
        assert_eq!(parsed.other_args, strings(&["c", "dir.d/file"]));
    }
}
