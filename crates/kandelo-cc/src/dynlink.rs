//! SPIKE PROTOTYPE (brandonpayton/shared-lib-exec-spike): link an executable
//! against shared libraries (`.so` side modules) and load them at startup.
//!
//! Not production code. See
//! docs/plans/2026-11-15-shared-library-executables-spike.md on the report
//! branch for the design, measurements and known gaps.
//!
//! Model: the executable keeps Kandelo's fixed (non-relocatable) layout.
//! wasm-ld's `--experimental-pic -Bdynamic` accepts `.so` inputs for a
//! non-PIE executable: symbols the libraries define become imports
//! (`env.<fn>`, `GOT.mem.<data>`, `GOT.func.<fn>`) and the output gains a
//! `dylink.0` section listing the libraries as needed. The SDK
//!
//! 1. adds those flags when a link input is a shared library;
//! 2. forces every symbol the libraries import into the executable and
//!    exports it, because wasm-ld (unlike ELF lld) neither extracts archive
//!    members for, nor exports, symbols a shared library references;
//! 3. links a generated constructor that `dlopen`s each needed library
//!    (`RTLD_NOW | RTLD_GLOBAL`) before user constructors run, through the
//!    ordinary staged libc/host loader; and
//! 4. renames the executable's `dylink.0` to `kandelo.dylink.0`, because
//!    every existing consumer (fork instrumenter, package roles, host loader)
//!    takes `dylink.0` to mean "relocatable side module".

use crate::Result;
use crate::flags::ParsedArgs;
use crate::wasm::{dylink_needed, export_names, import_entries};
use std::path::{Path, PathBuf};

/// The executable's renamed `dylink.0` section (see module docs).
pub const MAIN_DYLINK_SECTION: &str = "kandelo.dylink.0";

/// Is `name` a shared-library file name (`libx.so`, `libx.so.1.2`)?
pub fn is_shared_library_name(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name);
    match base.find(".so") {
        Some(at) => {
            let rest = &base[at + 3..];
            rest.is_empty()
                || rest
                    .strip_prefix('.')
                    .is_some_and(|v| v.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
        }
        None => false,
    }
}

/// The shared libraries an executable link names, in command-line order:
/// explicit `.so` operands and `-l<name>` options that resolve, through the
/// `-L` directories, to `lib<name>.so` before any `lib<name>.a` (the ELF
/// search order). `-static` and `-Wl,-Bstatic` disable the search.
pub fn shared_library_inputs(parsed: &ParsedArgs) -> Vec<PathBuf> {
    if parsed.shared {
        return Vec::new();
    }
    let args = &parsed.forwarded_args;
    if args.iter().any(|a| a == "-static" || a == "-Wl,-Bstatic") {
        return Vec::new();
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "-L" {
            if let Some(d) = args.get(i + 1) {
                dirs.push(PathBuf::from(d));
            }
            i += 2;
            continue;
        }
        if let Some(d) = a.strip_prefix("-L") {
            dirs.push(PathBuf::from(d));
        }
        i += 1;
    }
    let mut out = Vec::new();
    for a in args {
        if !a.starts_with('-') && is_shared_library_name(a) && Path::new(a).is_file() {
            out.push(PathBuf::from(a));
            continue;
        }
        if let Some(name) = a.strip_prefix("-l").filter(|n| !n.is_empty() && !n.starts_with(':')) {
            for dir in &dirs {
                let so = dir.join(format!("lib{name}.so"));
                if so.is_file() {
                    out.push(so);
                    break;
                }
                if dir.join(format!("lib{name}.a")).is_file() {
                    break;
                }
            }
        }
    }
    out
}

/// `-Wl,-rpath,<dir>` / `-Wl,-rpath=<dir>` / `-Wl,-R,<dir>` values from the
/// caller's raw arguments (the SDK filters them from the forwarded set).
pub fn rpaths(user_args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for a in user_args {
        for prefix in ["-Wl,-rpath,", "-Wl,-rpath=", "-Wl,--rpath=", "-Wl,-R,"] {
            if let Some(v) = a.strip_prefix(prefix) {
                out.extend(v.split([',', ':']).filter(|s| !s.is_empty()).map(String::from));
            }
        }
    }
    out
}

const RESERVED_IMPORTS: &[&str] = &[
    "memory",
    "__indirect_function_table",
    "__memory_base",
    "__table_base",
    "__stack_pointer",
    "__c_longjmp",
    "__cpp_exception",
    "__tls_base",
];

/// Symbols the libraries import that must therefore be defined and exported
/// by the executable: every non-reserved `env` import and every `GOT.mem` /
/// `GOT.func` entry not defined by one of the libraries themselves.
pub fn symbols_required_by(libs: &[PathBuf]) -> Result<Vec<String>> {
    let mut defined = std::collections::BTreeSet::new();
    let mut wanted = std::collections::BTreeSet::new();
    for lib in libs {
        let bytes = std::fs::read(lib).map_err(|e| format!("cannot read {}: {e}", lib.display()))?;
        defined.extend(export_names(&bytes)?);
        for (module, name, _) in import_entries(&bytes)? {
            let interesting = module == "env" || module == "GOT.mem" || module == "GOT.func";
            if interesting
                && !RESERVED_IMPORTS.contains(&name.as_str())
                && !name.starts_with("__wpk_fork_")
            {
                wanted.insert(name);
            }
        }
    }
    Ok(wanted.into_iter().filter(|n| !defined.contains(n)).collect())
}

/// Linker flags for an executable that links against `libs`.
pub fn dynamic_link_flags(libs: &[PathBuf]) -> Result<Vec<String>> {
    let mut flags = vec!["-Wl,--experimental-pic".to_string(), "-Wl,-Bdynamic".to_string()];
    for sym in symbols_required_by(libs)? {
        flags.push(format!("-Wl,-u,{sym}"));
        flags.push(format!("-Wl,--export-if-defined={sym}"));
    }
    Ok(flags)
}

/// Needed entries as wasm-ld records them: the input file's base name.
pub fn needed_names(libs: &[PathBuf]) -> Vec<String> {
    libs.iter()
        .map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
        .collect()
}

/// The needed list wasm-ld wrote into a linked executable.
pub fn linked_needed(module: &[u8]) -> Result<Vec<String>> {
    match crate::wasm::custom_section_payload(module, "dylink.0")? {
        Some(payload) => dylink_needed(&payload),
        None => Ok(Vec::new()),
    }
}

fn c_string(s: &str) -> String {
    let mut out = String::from("\"");
    for b in s.bytes() {
        match b {
            b'"' | b'\\' => {
                out.push('\\');
                out.push(b as char);
            }
            0x20..=0x7e => out.push(b as char),
            _ => out.push_str(&format!("\\{b:03o}")),
        }
    }
    out.push('"');
    out
}

/// The generated startup loader for an executable linked against shared
/// libraries. Search order per needed name (no slash): `LD_LIBRARY_PATH`,
/// then the link's run paths (RUNPATH semantics), then `/lib`, `/usr/lib`,
/// `/usr/local/lib`. A name containing a slash is opened as given.
pub fn needed_init_source(needed: &[String], rpaths: &[String]) -> String {
    let list = |items: &[String]| {
        let mut s: Vec<String> = items.iter().map(|i| c_string(i)).collect();
        s.push("0".into());
        s.join(", ")
    };
    format!(
        r#"/* Generated by kandelo-cc (shared-library executable spike). */
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char *const kandelo_needed[] = {{ {needed} }};
static const char *const kandelo_runpath[] = {{ {runpath} }};
static const char *const kandelo_default_path[] = {{ "/lib", "/usr/lib", "/usr/local/lib", 0 }};

static void kandelo_say(const char *s) {{ write(2, s, strlen(s)); }}

static void *kandelo_try(const char *dir, size_t len, const char *name) {{
    char path[4096];
    size_t n = strlen(name);
    if (len == 0 || len + 1 + n + 1 > sizeof path) return 0;
    memcpy(path, dir, len);
    path[len] = '/';
    memcpy(path + len + 1, name, n + 1);
    if (access(path, F_OK) != 0) return 0;
    void *h = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
    if (!h) {{
        const char *e = dlerror();
        kandelo_say("error while loading shared libraries: ");
        kandelo_say(path);
        kandelo_say(": ");
        kandelo_say(e ? e : "unknown error");
        kandelo_say("\n");
        _exit(127);
    }}
    return h;
}}

static void *kandelo_search_list(const char *list, const char *name) {{
    while (list && *list) {{
        const char *end = strchr(list, ':');
        size_t len = end ? (size_t)(end - list) : strlen(list);
        void *h = kandelo_try(list, len, name);
        if (h) return h;
        list = end ? end + 1 : 0;
    }}
    return 0;
}}

__attribute__((constructor(101))) static void kandelo_load_needed(void) {{
    for (int i = 0; kandelo_needed[i]; i++) {{
        const char *name = kandelo_needed[i];
        void *h = 0;
        if (strchr(name, '/')) {{
            h = dlopen(name, RTLD_NOW | RTLD_GLOBAL);
        }} else {{
            h = kandelo_search_list(getenv("LD_LIBRARY_PATH"), name);
            for (int j = 0; !h && kandelo_runpath[j]; j++)
                h = kandelo_try(kandelo_runpath[j], strlen(kandelo_runpath[j]), name);
            for (int j = 0; !h && kandelo_default_path[j]; j++)
                h = kandelo_try(kandelo_default_path[j], strlen(kandelo_default_path[j]), name);
        }}
        if (!h) {{
            kandelo_say("error while loading shared libraries: ");
            kandelo_say(name);
            kandelo_say(": cannot open shared object file: No such file or directory\n");
            _exit(127);
        }}
    }}
}}
"#,
        needed = list(needed),
        runpath = list(rpaths),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_versioned_shared_library_names() {
        assert!(is_shared_library_name("libfoo.so"));
        assert!(is_shared_library_name("dir/libfoo.so.1.2.3"));
        assert!(!is_shared_library_name("libfoo.so.x"));
        assert!(!is_shared_library_name("libfoo.a"));
        assert!(!is_shared_library_name("foo.sock"));
    }
}
