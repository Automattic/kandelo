//! Regenerate `abi/snapshot.json` from authoritative sources.
//!
//! Sources (all compiled into this binary via the `wasm_posix_shared` crate):
//!
//!   * [`wasm_posix_shared::ABI_VERSION`] — the integer version number
//!   * [`wasm_posix_shared::Syscall`] — named syscall number table
//!   * [`wasm_posix_shared::abi::host_intercepted`] — syscall numbers
//!     handled in the host before reaching the kernel dispatcher
//!   * [`wasm_posix_shared::channel`] — channel header byte layout
//!   * Marshalled repr(C) structs — offsets via `core::mem::offset_of!`
//!   * [`wasm_posix_shared::abi`] — expected process globals, export
//!     deny-lists, custom-section name
//!   * [`wasm_posix_shared::abi::HOST_ADAPTER_MANIFEST`] — kernel/host
//!     adapter boot contract metadata
//!   * [`wasm_posix_shared::host_abi`] — host adapter syscall marshalling
//!     descriptors
//!
//! When `--kernel-wasm <path>` is provided, the snapshot also covers
//! every export in the built kernel `.wasm` (after filtering through
//! `shared::abi::export_is_tracked` to drop toolchain implementation
//! details). Function signatures are recorded, as are the types and
//! mutability of globals; for globals matching
//! `shared::abi::ABI_VALUE_CAPTURE_PREFIXES` the initial value is
//! captured too.
//!
//! CI is expected to build the kernel first and pass `--kernel-wasm`.
//! If the flag is omitted, `dump-abi` fails loudly rather than writing
//! a partial snapshot — a quietly-thinner snapshot would silently
//! defeat the check.

use std::collections::BTreeMap;
use std::mem::{offset_of, size_of};
use std::path::PathBuf;

use serde_json::{Value, json};
use wasm_posix_shared as shared;

use crate::{JsonMap, repo_root};

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut out_path: Option<PathBuf> = None;
    let mut kernel_wasm: Option<PathBuf> = None;
    let mut compat_old: Option<PathBuf> = None;
    let mut compat_new: Option<PathBuf> = None;
    let mut check = false;

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--out" => out_path = Some(it.next().ok_or("--out requires a path")?.into()),
            "--kernel-wasm" => {
                kernel_wasm = Some(it.next().ok_or("--kernel-wasm requires a path")?.into())
            }
            "--classify-compat" => {
                compat_old = Some(
                    it.next()
                        .ok_or("--classify-compat requires <old-snapshot> <new-snapshot>")?
                        .into(),
                );
                compat_new = Some(
                    it.next()
                        .ok_or("--classify-compat requires <old-snapshot> <new-snapshot>")?
                        .into(),
                );
            }
            "--check" => check = true,
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    if compat_old.is_some() || compat_new.is_some() {
        let old = compat_old.ok_or("--classify-compat requires <old-snapshot> <new-snapshot>")?;
        let new = compat_new.ok_or("--classify-compat requires <old-snapshot> <new-snapshot>")?;
        return classify_compat_files(&old, &new);
    }

    let kernel_wasm = kernel_wasm.ok_or_else(|| {
        "missing --kernel-wasm <path>. Build the kernel first \
         (e.g. via scripts/check-abi-version.sh) and pass the path to \
         target/wasm32-unknown-unknown/release/kandelo_kernel.wasm. \
         Refusing to write a partial snapshot."
            .to_string()
    })?;

    let snapshot = build_snapshot(&kernel_wasm)?;
    let rendered = render_deterministic(&snapshot);
    let header = render_c_header();
    let ts_module = render_ts_module();

    let out = out_path.unwrap_or_else(|| repo_root().join("abi/snapshot.json"));
    let header_out = repo_root().join("libc/glue/abi_constants.h");
    let ts_out = repo_root().join("host/src/generated/abi.ts");

    if check {
        check_file(&out, &rendered, "ABI snapshot")?;
        check_file(&header_out, &header, "libc/glue/abi_constants.h")?;
        check_file(&ts_out, &ts_module, "host/src/generated/abi.ts")?;
        println!("abi snapshot up-to-date: {}", out.display());
        println!("abi header up-to-date:  {}", header_out.display());
        println!("abi TS bindings up-to-date: {}", ts_out.display());
        return Ok(());
    }

    write_file(&out, &rendered)?;
    println!("wrote {}", out.display());
    write_file(&header_out, &header)?;
    println!("wrote {}", header_out.display());
    write_file(&ts_out, &ts_module)?;
    println!("wrote {}", ts_out.display());
    Ok(())
}

fn check_file(path: &std::path::Path, expected: &str, label: &str) -> Result<(), String> {
    let existing =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if existing != expected {
        eprintln!(
            "{label} at {} is out of date.\n\
             Run `bash scripts/check-abi-version.sh update` to regenerate,\n\
             and bump `ABI_VERSION` in crates/shared/src/lib.rs if the\n\
             contract actually changed.",
            path.display()
        );
        return Err(format!("{label} drift"));
    }
    Ok(())
}

fn write_file(path: &std::path::Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(path, contents).map_err(|e| format!("write {}: {e}", path.display()))
}

fn classify_compat_files(
    old_path: &std::path::Path,
    new_path: &std::path::Path,
) -> Result<(), String> {
    let old_text = std::fs::read_to_string(old_path)
        .map_err(|e| format!("read {}: {e}", old_path.display()))?;
    let new_text = std::fs::read_to_string(new_path)
        .map_err(|e| format!("read {}: {e}", new_path.display()))?;
    let old: Value = serde_json::from_str(&old_text)
        .map_err(|e| format!("parse {}: {e}", old_path.display()))?;
    let new: Value = serde_json::from_str(&new_text)
        .map_err(|e| format!("parse {}: {e}", new_path.display()))?;

    let report = classify_compat_change(&old, &new)?;
    for item in &report.additive {
        println!("abi: additive-compatible change: {item}");
    }
    if report.breaking.is_empty() && report.additive.is_empty() {
        println!("abi: snapshots are identical for backward-compatibility purposes.");
        Ok(())
    } else if report.breaking.is_empty() {
        println!("abi: snapshot changes are backward-compatible additions.");
        Ok(())
    } else {
        for item in &report.breaking {
            eprintln!("abi: breaking/incompatible snapshot change: {item}");
        }
        Err("snapshot changes require ABI_VERSION bump".to_string())
    }
}

/// C header consumed by `libc/glue/channel_syscall.c` and any other C code
/// that needs to agree with Rust on ABI-surface constants.
fn render_c_header() -> String {
    format!(
        "/* GENERATED by `cargo xtask dump-abi`. Do not edit by hand. */\n\
         /* Regenerated by scripts/check-abi-version.sh; drift is a CI failure. */\n\
         #ifndef WASM_POSIX_ABI_CONSTANTS_H\n\
         #define WASM_POSIX_ABI_CONSTANTS_H\n\
         \n\
         /* Mirrors wasm_posix_shared::ABI_VERSION. */\n\
         #define WASM_POSIX_ABI_VERSION {version}u\n\
         \n\
         /* Default process-wasm pthread slot declaration. */\n\
         #define WASM_POSIX_THREAD_SLOT_DECL_DEFAULT {thread_slots_default}\n\
         \n\
         /* Fixed kernel/musl resource-usage wire record size. */\n\
         #define WASM_POSIX_RUSAGE_WIRE_SIZE {rusage_wire_size}u\n\
         \n\
         #endif /* WASM_POSIX_ABI_CONSTANTS_H */\n",
        version = shared::ABI_VERSION,
        thread_slots_default = shared::process_memory::THREAD_SLOTS_USE_HOST_DEFAULT,
        rusage_wire_size = shared::WASM_RUSAGE_WIRE_SIZE,
    )
}

/// TypeScript bindings consumed by `host/src/*`.
///
/// Keep this generated from the same Rust/shared source of truth as
/// `abi/snapshot.json`; otherwise the host can silently drift on channel
/// offsets or syscall numbers even when the ABI check is green.
fn render_ts_module() -> String {
    use shared::channel;

    let mut out = String::new();
    out.push_str("/* GENERATED by `cargo xtask dump-abi`. Do not edit by hand. */\n");
    out.push_str("/* Regenerated by scripts/check-abi-version.sh; drift is a CI failure. */\n\n");

    out.push_str(&format!(
        "export const ABI_VERSION = {} as const;\n",
        shared::ABI_VERSION
    ));
    out.push_str(&format!(
        "export const ABI_CUSTOM_SECTION = {:?} as const;\n",
        shared::abi::ABI_CUSTOM_SECTION
    ));
    out.push_str(&format!(
        "export const ABI_KERNEL_EXPORT = {:?} as const;\n\n",
        shared::abi::ABI_KERNEL_EXPORT
    ));

    out.push_str(&format!(
        "export const HOST_ADAPTER_VERSION = {} as const;\n",
        shared::abi::HOST_ADAPTER_VERSION
    ));
    out.push_str(&format!(
        "export const HOST_ADAPTER_MANIFEST_MAGIC = {} as const;\n",
        shared::abi::HOST_ADAPTER_MANIFEST_MAGIC
    ));
    out.push_str(&format!(
        "export const HOST_ADAPTER_MANIFEST_VERSION = {} as const;\n",
        shared::abi::HOST_ADAPTER_MANIFEST_VERSION
    ));
    out.push_str(&format!(
        "export const HOST_ADAPTER_MANIFEST_SIZE = {} as const;\n",
        shared::abi::HOST_ADAPTER_MANIFEST_SIZE
    ));
    out.push_str(&format!(
        "export const HOST_ADAPTER_REQUIRED_WORKER_FEATURES = {} as const;\n",
        shared::abi::HOST_ADAPTER_REQUIRED_WORKER_FEATURES
    ));
    out.push_str(&format!(
        "export const HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES = {} as const;\n\n",
        shared::abi::HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES
    ));

    out.push_str("export const HOST_ADAPTER_WORKER_FEATURES = {\n");
    for feature in shared::abi::HOST_ADAPTER_WORKER_FEATURES {
        out.push_str(&format!("  {}: {},\n", feature.name, feature.bit));
    }
    out.push_str("} as const;\n\n");

    out.push_str("export const HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS = [\n");
    for export_name in shared::abi::HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS {
        out.push_str(&format!("  {:?},\n", export_name));
    }
    out.push_str("] as const;\n\n");

    out.push_str("export const HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS = [\n");
    for export_name in shared::abi::HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS {
        out.push_str(&format!("  {:?},\n", export_name));
    }
    out.push_str("] as const;\n\n");

    out.push_str("export const HOST_ADAPTER_MANIFEST_FIELDS = {\n");
    for field in host_adapter_manifest_fields() {
        out.push_str(&format!(
            "  {}: {{ offset: {}, size: {} }},\n",
            field.name, field.offset, field.size
        ));
    }
    out.push_str("} as const;\n\n");

    out.push_str(&format!(
        "export const CHANNEL_STATUS_IDLE = {} as const;\n",
        shared::ChannelStatus::Idle as u32
    ));
    out.push_str(&format!(
        "export const CHANNEL_STATUS_PENDING = {} as const;\n",
        shared::ChannelStatus::Pending as u32
    ));
    out.push_str(&format!(
        "export const CHANNEL_STATUS_COMPLETE = {} as const;\n",
        shared::ChannelStatus::Complete as u32
    ));
    out.push_str(&format!(
        "export const CHANNEL_STATUS_ERROR = {} as const;\n\n",
        shared::ChannelStatus::Error as u32
    ));

    out.push_str("export const CHANNEL_STATUS = {\n");
    out.push_str("  Idle: CHANNEL_STATUS_IDLE,\n");
    out.push_str("  Pending: CHANNEL_STATUS_PENDING,\n");
    out.push_str("  Complete: CHANNEL_STATUS_COMPLETE,\n");
    out.push_str("  Error: CHANNEL_STATUS_ERROR,\n");
    out.push_str("} as const;\n\n");

    out.push_str(&format!(
        "export const CH_STATUS = {} as const;\n",
        channel::STATUS_OFFSET
    ));
    out.push_str(&format!(
        "export const CH_SYSCALL = {} as const;\n",
        channel::SYSCALL_OFFSET
    ));
    out.push_str(&format!(
        "export const CH_ARGS = {} as const;\n",
        channel::ARGS_OFFSET
    ));
    out.push_str(&format!(
        "export const CH_ARGS_COUNT = {} as const;\n",
        channel::ARGS_COUNT
    ));
    out.push_str(&format!(
        "export const CH_ARG_SIZE = {} as const;\n",
        channel::ARG_SIZE
    ));
    out.push_str(&format!(
        "export const CH_RETURN = {} as const;\n",
        channel::RETURN_OFFSET
    ));
    out.push_str(&format!(
        "export const CH_ERRNO = {} as const;\n",
        channel::ERRNO_OFFSET
    ));
    out.push_str(&format!(
        "export const CH_DATA = {} as const;\n",
        channel::DATA_OFFSET
    ));
    out.push_str(&format!(
        "export const CH_DATA_SIZE = {} as const;\n",
        channel::DATA_SIZE
    ));
    out.push_str(&format!(
        "export const CH_HEADER_SIZE = {} as const;\n",
        channel::HEADER_SIZE
    ));
    out.push_str(&format!(
        "export const CH_TOTAL_SIZE = {} as const;\n\n",
        channel::MIN_CHANNEL_SIZE
    ));

    out.push_str(&format!(
        "export const PROCESS_MEMORY_WASM_PAGE_SIZE = {} as const;\n",
        shared::process_memory::WASM_PAGE_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_DEFAULT_MAX_PAGES = {} as const;\n",
        shared::process_memory::DEFAULT_MAX_PAGES
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_DEFAULT_INITIAL_PAGES = {} as const;\n",
        shared::process_memory::DEFAULT_INITIAL_PAGES
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_DEFAULT_THREAD_SLOTS = {} as const;\n",
        shared::process_memory::DEFAULT_THREAD_SLOTS
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_THREAD_SLOTS_USE_HOST_DEFAULT = {} as const;\n",
        shared::process_memory::THREAD_SLOTS_USE_HOST_DEFAULT
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_THREAD_SLOTS_NONE = {} as const;\n",
        shared::process_memory::THREAD_SLOTS_NONE
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_THREAD_SLOT_DECL_EXPORT = {:?} as const;\n",
        shared::process_memory::THREAD_SLOT_DECL_EXPORT
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_LEGACY_MMAP_BASE = {} as const;\n",
        shared::process_memory::LEGACY_MMAP_BASE
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_FALLBACK_BRK_BASE = {} as const;\n",
        shared::process_memory::FALLBACK_BRK_BASE
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_FORK_SAVE_BUFFER_SIZE = {} as const;\n",
        shared::process_memory::FORK_SAVE_BUFFER_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_MAIN_FORK_SAVE_PAGE = {} as const;\n",
        shared::process_memory::MAIN_FORK_SAVE_PAGE
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_MAIN_CHANNEL_PRIMARY_PAGE = {} as const;\n",
        shared::process_memory::MAIN_CHANNEL_PRIMARY_PAGE
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_MAIN_CHANNEL_SPILL_PAGE = {} as const;\n",
        shared::process_memory::MAIN_CHANNEL_SPILL_PAGE
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE = {} as const;\n",
        shared::process_memory::THREAD_SLOT_TLS_PAGE
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE = {} as const;\n",
        shared::process_memory::THREAD_SLOT_FORK_SAVE_PAGE
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE = {} as const;\n",
        shared::process_memory::THREAD_SLOT_CHANNEL_PRIMARY_PAGE
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_THREAD_SLOT_CHANNEL_SPILL_PAGE = {} as const;\n",
        shared::process_memory::THREAD_SLOT_CHANNEL_SPILL_PAGE
    ));
    out.push_str(&format!(
        "export const PROCESS_MEMORY_PAGES_PER_THREAD_SLOT = {} as const;\n\n",
        shared::process_memory::PAGES_PER_THREAD_SLOT
    ));

    out.push_str(&format!(
        "export const CH_SIG_BASE = {} as const;\n",
        channel::SIG_BASE
    ));
    out.push_str(&format!(
        "export const CH_SIG_SIGNUM = {} as const;\n",
        channel::SIG_SIGNUM
    ));
    out.push_str(&format!(
        "export const CH_SIG_HANDLER = {} as const;\n",
        channel::SIG_HANDLER
    ));
    out.push_str(&format!(
        "export const CH_SIG_FLAGS = {} as const;\n",
        channel::SIG_FLAGS
    ));
    out.push_str(&format!(
        "export const CH_SIG_OLD_MASK = {} as const;\n\n",
        channel::SIG_OLD_MASK
    ));

    out.push_str(&format!(
        "export const WAIT_EVENT_EXITED = {} as const;\n",
        shared::wait::EVENT_EXITED
    ));
    out.push_str(&format!(
        "export const WAIT_EVENT_STOPPED = {} as const;\n",
        shared::wait::EVENT_STOPPED
    ));
    out.push_str(&format!(
        "export const WAIT_EVENT_CONTINUED = {} as const;\n",
        shared::wait::EVENT_CONTINUED
    ));
    out.push_str(&format!(
        "export const WAIT_WNOHANG = {} as const;\n",
        shared::wait::WNOHANG
    ));
    out.push_str(&format!(
        "export const WAIT_WUNTRACED = {} as const;\n",
        shared::wait::WUNTRACED
    ));
    out.push_str(&format!(
        "export const WAIT_WSTOPPED = {} as const;\n",
        shared::wait::WSTOPPED
    ));
    out.push_str(&format!(
        "export const WAIT_WEXITED = {} as const;\n",
        shared::wait::WEXITED
    ));
    out.push_str(&format!(
        "export const WAIT_WCONTINUED = {} as const;\n",
        shared::wait::WCONTINUED
    ));
    out.push_str(&format!(
        "export const WAIT_WNOWAIT = {} as const;\n",
        shared::wait::WNOWAIT
    ));
    out.push_str(&format!(
        "export const WAIT_CLD_EXITED = {} as const;\n",
        shared::wait::CLD_EXITED
    ));
    out.push_str(&format!(
        "export const WAIT_CLD_KILLED = {} as const;\n",
        shared::wait::CLD_KILLED
    ));
    out.push_str(&format!(
        "export const WAIT_CLD_STOPPED = {} as const;\n",
        shared::wait::CLD_STOPPED
    ));
    out.push_str(&format!(
        "export const WAIT_CLD_CONTINUED = {} as const;\n",
        shared::wait::CLD_CONTINUED
    ));
    out.push_str(&format!(
        "export const PROCESS_STATE_RUNNING = {} as const;\n",
        shared::wait::PROCESS_STATE_RUNNING
    ));
    out.push_str(&format!(
        "export const PROCESS_STATE_STOPPED = {} as const;\n",
        shared::wait::PROCESS_STATE_STOPPED
    ));
    out.push_str(&format!(
        "export const PROCESS_STATE_EXITED = {} as const;\n",
        shared::wait::PROCESS_STATE_EXITED
    ));
    out.push_str(&format!(
        "export const WAKE_PROCESS_STOPPED = {} as const;\n",
        shared::wait::WAKE_PROCESS_STOPPED
    ));
    out.push_str(&format!(
        "export const WAKE_PROCESS_CONTINUED = {} as const;\n\n",
        shared::wait::WAKE_PROCESS_CONTINUED
    ));

    out.push_str(&format!(
        "export const STRUCT_SIZE_WASM_STAT = {} as const;\n",
        size_of::<shared::WasmStat>()
    ));
    out.push_str(&format!(
        "export const STRUCT_SIZE_WASM_DIRENT = {} as const;\n",
        size_of::<shared::WasmDirent>()
    ));
    out.push_str(&format!(
        "export const STRUCT_SIZE_WASM_TIMESPEC = {} as const;\n",
        size_of::<shared::WasmTimespec>()
    ));
    out.push_str(&format!(
        "export const STRUCT_SIZE_WASM_POLL_FD = {} as const;\n",
        size_of::<shared::WasmPollFd>()
    ));
    out.push_str(&format!(
        "export const STRUCT_SIZE_WASM_STATFS = {} as const;\n",
        size_of::<shared::WasmStatfs>()
    ));
    out.push_str(&format!(
        "export const STRUCT_SIZE_WASM_RUSAGE_WIRE = {} as const;\n",
        size_of::<shared::WasmRusageWire>()
    ));
    out.push_str(&format!(
        "export const STRUCT_SIZE_KERNEL_WAIT_RESULT = {} as const;\n",
        size_of::<shared::KernelWaitResult>()
    ));
    out.push_str(&format!(
        "export const KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET = {} as const;\n",
        offset_of!(shared::KernelWaitResult, wait_status)
    ));
    out.push_str(&format!(
        "export const KERNEL_WAIT_RESULT_SI_CODE_OFFSET = {} as const;\n",
        offset_of!(shared::KernelWaitResult, si_code)
    ));
    out.push_str(&format!(
        "export const KERNEL_WAIT_RESULT_SI_STATUS_OFFSET = {} as const;\n",
        offset_of!(shared::KernelWaitResult, si_status)
    ));
    out.push_str(&format!(
        "export const KERNEL_WAIT_RESULT_CHILD_UID_OFFSET = {} as const;\n",
        offset_of!(shared::KernelWaitResult, child_uid)
    ));
    out.push_str(&format!(
        "export const KERNEL_WAIT_RESULT_RUSAGE_OFFSET = {} as const;\n\n",
        offset_of!(shared::KernelWaitResult, rusage)
    ));

    out.push_str("export const HOST_INTERCEPTED_SYSCALLS = {\n");
    for syscall in host_intercepted_syscall_metadata() {
        out.push_str(&format!(
            "  {}: {},\n",
            syscall.constant_name, syscall.number
        ));
    }
    out.push_str("} as const;\n\n");

    out.push_str("export const ABI_SYSCALLS = {\n");
    for (number, name) in all_syscall_metadata() {
        out.push_str(&format!("  {name}: {number},\n"));
    }
    out.push_str("} as const;\n\n");

    out.push_str("export const PATHCONF_NAMES = {\n");
    for (name, number) in shared::pathconf::ABI_NAMES {
        out.push_str(&format!("  {name}: {number},\n"));
    }
    out.push_str("} as const;\n\n");

    out.push_str("export const ABI_SYSCALL_NAMES: Record<number, string> = {\n");
    for (number, name) in all_syscall_log_names() {
        out.push_str(&format!("  {number}: {name:?},\n"));
    }
    out.push_str("} as const;\n\n");

    out.push_str("export type SyscallArgDirection = \"in\" | \"out\" | \"inout\";\n\n");
    out.push_str("export type SyscallArgSizeSpec =\n");
    out.push_str("  | { type: \"cstring\" }\n");
    out.push_str("  | { type: \"arg\"; argIndex: number; multiplier?: number; add?: number }\n");
    out.push_str("  | { type: \"deref\"; argIndex: number }\n");
    out.push_str("  | { type: \"fixed\"; size: number };\n\n");
    out.push_str("export interface SyscallArgDesc {\n");
    out.push_str("  argIndex: number;\n");
    out.push_str("  direction: SyscallArgDirection;\n");
    out.push_str("  size: SyscallArgSizeSpec;\n");
    out.push_str("  nullable?: boolean;\n");
    out.push_str("  required?: boolean;\n");
    out.push_str("  copyRetvalAdd?: number;\n");
    out.push_str("}\n\n");

    out.push_str("export const SYSCALL_ARGS: Record<number, SyscallArgDesc[]> = {\n");
    for entry in shared::host_abi::SYSCALL_ARG_DESCRIPTORS {
        out.push_str(&format!("  {}: [\n", entry.syscall_number));
        for desc in entry.args {
            out.push_str(&format!("    {},\n", ts_syscall_arg_desc(desc)));
        }
        out.push_str("  ],\n");
    }
    out.push_str("};\n");

    out
}

fn ts_syscall_arg_desc(desc: &shared::host_abi::SyscallArgDesc) -> String {
    let mut s = format!(
        "{{ argIndex: {}, direction: {:?}, size: {}",
        desc.arg_index,
        syscall_arg_direction_name(desc.direction),
        ts_syscall_arg_size(desc.size)
    );
    if desc.nullable {
        s.push_str(", nullable: true");
    }
    if desc.required {
        s.push_str(", required: true");
    }
    if desc.copy_retval_add != 0 {
        s.push_str(&format!(", copyRetvalAdd: {}", desc.copy_retval_add));
    }
    s.push_str(" }");
    s
}

fn ts_syscall_arg_size(size: shared::host_abi::SyscallArgSize) -> String {
    use shared::host_abi::SyscallArgSize;

    match size {
        SyscallArgSize::CString => "{ type: \"cstring\" }".into(),
        SyscallArgSize::Arg {
            arg_index,
            multiplier,
            add,
        } => {
            let mut s = format!("{{ type: \"arg\", argIndex: {arg_index}");
            if multiplier != 1 {
                s.push_str(&format!(", multiplier: {multiplier}"));
            }
            if add != 0 {
                s.push_str(&format!(", add: {add}"));
            }
            s.push_str(" }");
            s
        }
        SyscallArgSize::Deref { arg_index } => {
            format!("{{ type: \"deref\", argIndex: {arg_index} }}")
        }
        SyscallArgSize::Fixed { size } => format!("{{ type: \"fixed\", size: {size} }}"),
    }
}

fn syscall_arg_direction_name(direction: shared::host_abi::SyscallArgDirection) -> &'static str {
    use shared::host_abi::SyscallArgDirection;

    match direction {
        SyscallArgDirection::In => "in",
        SyscallArgDirection::Out => "out",
        SyscallArgDirection::InOut => "inout",
    }
}

#[derive(Debug, Clone, Copy)]
struct HostAdapterManifestField {
    name: &'static str,
    offset: usize,
    size: usize,
}

fn host_adapter_manifest_fields() -> [HostAdapterManifestField; 11] {
    use shared::abi::HostAdapterManifest;

    [
        HostAdapterManifestField {
            name: "magic",
            offset: offset_of!(HostAdapterManifest, magic),
            size: size_of::<u32>(),
        },
        HostAdapterManifestField {
            name: "manifestVersion",
            offset: offset_of!(HostAdapterManifest, manifest_version),
            size: size_of::<u16>(),
        },
        HostAdapterManifestField {
            name: "manifestSize",
            offset: offset_of!(HostAdapterManifest, manifest_size),
            size: size_of::<u16>(),
        },
        HostAdapterManifestField {
            name: "abiVersion",
            offset: offset_of!(HostAdapterManifest, abi_version),
            size: size_of::<u32>(),
        },
        HostAdapterManifestField {
            name: "requiredHostAdapterVersion",
            offset: offset_of!(HostAdapterManifest, required_host_adapter_version),
            size: size_of::<u32>(),
        },
        HostAdapterManifestField {
            name: "requiredWorkerFeatures",
            offset: offset_of!(HostAdapterManifest, required_worker_features),
            size: size_of::<u32>(),
        },
        HostAdapterManifestField {
            name: "optionalKernelFeatures",
            offset: offset_of!(HostAdapterManifest, optional_kernel_features),
            size: size_of::<u32>(),
        },
        HostAdapterManifestField {
            name: "channelHeaderSize",
            offset: offset_of!(HostAdapterManifest, channel_header_size),
            size: size_of::<u32>(),
        },
        HostAdapterManifestField {
            name: "channelDataOffset",
            offset: offset_of!(HostAdapterManifest, channel_data_offset),
            size: size_of::<u32>(),
        },
        HostAdapterManifestField {
            name: "channelDataSize",
            offset: offset_of!(HostAdapterManifest, channel_data_size),
            size: size_of::<u32>(),
        },
        HostAdapterManifestField {
            name: "channelMinSize",
            offset: offset_of!(HostAdapterManifest, channel_min_size),
            size: size_of::<u32>(),
        },
    ]
}

/// Collect per-field (name, offset) from a repr(C) struct using
/// `offset_of!` and hand off to [`build_struct_layout`] for size
/// computation + JSON rendering.
macro_rules! struct_layout {
    ($ty:ty { $($field:ident),* $(,)? }) => {{
        let size = size_of::<$ty>();
        let fields: Vec<(&'static str, usize)> = vec![
            $((stringify!($field), offset_of!($ty, $field))),*
        ];
        build_struct_layout(size, fields)
    }};
}

fn build_struct_layout(total_size: usize, fields: Vec<(&'static str, usize)>) -> Value {
    // Emit (offset, span) per field where span = bytes until the next
    // field's offset (or end of struct). Span includes trailing alignment
    // padding, so any ABI-relevant shift in layout — reordering, type
    // size change, or padding change — shows up as a changed span.
    let mut sorted_offsets: Vec<usize> = fields.iter().map(|(_, o)| *o).collect();
    sorted_offsets.sort();
    sorted_offsets.dedup();

    let mut field_jsons = Vec::with_capacity(fields.len());
    for (name, off) in &fields {
        let idx = sorted_offsets.binary_search(off).expect("offset present");
        let next = sorted_offsets.get(idx + 1).copied().unwrap_or(total_size);
        let span = next - off;
        let mut m: JsonMap = BTreeMap::new();
        m.insert("name".into(), json!(name));
        m.insert("offset".into(), json!(off));
        m.insert("span".into(), json!(span));
        field_jsons.push(Value::Object(m.into_iter().collect()));
    }
    let mut m: JsonMap = BTreeMap::new();
    m.insert("size".into(), json!(total_size));
    m.insert("fields".into(), Value::Array(field_jsons));
    Value::Object(m.into_iter().collect())
}

fn build_snapshot(kernel_wasm: &std::path::Path) -> Result<JsonMap, String> {
    let mut root: JsonMap = BTreeMap::new();

    root.insert("abi_version".into(), json!(shared::ABI_VERSION));

    root.insert("channel_header".into(), channel_header());
    root.insert("channel_signal_area".into(), channel_signal_area());
    root.insert("channel_buffers".into(), channel_buffers());

    root.insert("marshalled_structs".into(), marshalled_structs());
    root.insert("syscalls".into(), syscalls());
    root.insert("pathconf_names".into(), pathconf_names());
    root.insert("wait_contract".into(), wait_contract());
    root.insert(
        "host_intercepted_syscalls".into(),
        host_intercepted_syscalls(),
    );
    root.insert("host_adapter".into(), host_adapter());
    root.insert("syscall_arg_descriptors".into(), syscall_arg_descriptors());
    root.insert("channel_status_codes".into(), channel_status_codes());
    root.insert("process_memory_layout".into(), process_memory_layout());
    root.insert("custom_sections".into(), custom_sections());
    root.insert(
        "process_expected_globals".into(),
        process_expected_globals(),
    );

    root.insert("export_deny".into(), export_deny());

    let wasm =
        std::fs::read(kernel_wasm).map_err(|e| format!("read {}: {e}", kernel_wasm.display()))?;
    root.insert("kernel_exports".into(), kernel_exports(&wasm)?);

    Ok(root)
}

fn channel_header() -> Value {
    use shared::channel::*;
    // The field list is hand-authored; offsets below are read from the
    // actual shared:: constants that kernel and glue reference, so the
    // hand-authored table cannot silently drift from them.
    let fields = [
        ("status", STATUS_OFFSET, 4usize, "i32"),
        ("syscall", SYSCALL_OFFSET, 4, "i32"),
        ("args", ARGS_OFFSET, ARGS_COUNT * ARG_SIZE, "[i64; 6]"),
        ("ret", RETURN_OFFSET, 8, "i64"),
        ("errno", ERRNO_OFFSET, 4, "i32"),
    ];

    let mut covered: usize = 0;
    let fields_json: Vec<Value> = fields
        .iter()
        .map(|(name, offset, size, ty)| {
            assert!(
                *offset >= covered,
                "channel header field {name:?} overlaps previous ({offset} < {covered})"
            );
            covered = offset + size;
            let mut m: JsonMap = BTreeMap::new();
            m.insert("name".into(), json!(name));
            m.insert("offset".into(), json!(offset));
            m.insert("size".into(), json!(size));
            m.insert("type".into(), json!(ty));
            Value::Object(m.into_iter().collect())
        })
        .collect();

    assert!(
        covered <= HEADER_SIZE,
        "channel header fields overrun HEADER_SIZE ({covered} > {HEADER_SIZE})"
    );

    let mut m: JsonMap = BTreeMap::new();
    m.insert("size".into(), json!(HEADER_SIZE));
    m.insert("fields".into(), Value::Array(fields_json));
    Value::Object(m.into_iter().collect())
}

fn channel_buffers() -> Value {
    use shared::channel::*;
    let mut m: JsonMap = BTreeMap::new();
    m.insert("data_offset".into(), json!(DATA_OFFSET));
    m.insert("data_size".into(), json!(DATA_SIZE));
    m.insert("min_channel_size".into(), json!(MIN_CHANNEL_SIZE));
    Value::Object(m.into_iter().collect())
}

fn process_memory_layout() -> Value {
    use shared::process_memory as pm;

    let channel_pages = (shared::channel::MIN_CHANNEL_SIZE + pm::WASM_PAGE_SIZE as usize - 1)
        / pm::WASM_PAGE_SIZE as usize;

    let page = |name: &str, page_offset: u32, purpose: &str| {
        let mut m: JsonMap = BTreeMap::new();
        m.insert("name".into(), json!(name));
        m.insert("page_offset".into(), json!(page_offset));
        m.insert("purpose".into(), json!(purpose));
        Value::Object(m.into_iter().collect())
    };

    let mut declarations: JsonMap = BTreeMap::new();
    declarations.insert(
        "thread_slot_export".into(),
        json!(pm::THREAD_SLOT_DECL_EXPORT),
    );
    declarations.insert(
        "use_host_default".into(),
        json!(pm::THREAD_SLOTS_USE_HOST_DEFAULT),
    );
    declarations.insert("none".into(), json!(pm::THREAD_SLOTS_NONE));

    let mut defaults: JsonMap = BTreeMap::new();
    defaults.insert("initial_pages".into(), json!(pm::DEFAULT_INITIAL_PAGES));
    defaults.insert("max_pages".into(), json!(pm::DEFAULT_MAX_PAGES));
    defaults.insert("thread_slots".into(), json!(pm::DEFAULT_THREAD_SLOTS));

    let mut legacy: JsonMap = BTreeMap::new();
    legacy.insert("mmap_base".into(), json!(pm::LEGACY_MMAP_BASE));
    legacy.insert("fallback_brk_base".into(), json!(pm::FALLBACK_BRK_BASE));

    let mut main_control: JsonMap = BTreeMap::new();
    main_control.insert(
        "pages".into(),
        Value::Array(vec![
            page(
                "fork_save_scratch",
                pm::MAIN_FORK_SAVE_PAGE,
                "main thread fork-save/scratch page",
            ),
            page(
                "syscall_channel_primary",
                pm::MAIN_CHANNEL_PRIMARY_PAGE,
                "main thread syscall channel primary page",
            ),
            page(
                "syscall_channel_spill",
                pm::MAIN_CHANNEL_SPILL_PAGE,
                "main thread syscall channel spill page",
            ),
        ]),
    );

    let mut thread_slot: JsonMap = BTreeMap::new();
    thread_slot.insert("pages_per_slot".into(), json!(pm::PAGES_PER_THREAD_SLOT));
    thread_slot.insert(
        "pages".into(),
        Value::Array(vec![
            page(
                "tls_control",
                pm::THREAD_SLOT_TLS_PAGE,
                "per-pthread TLS/control page",
            ),
            page(
                "fork_save_scratch",
                pm::THREAD_SLOT_FORK_SAVE_PAGE,
                "per-pthread fork-save/scratch page",
            ),
            page(
                "syscall_channel_primary",
                pm::THREAD_SLOT_CHANNEL_PRIMARY_PAGE,
                "per-pthread syscall channel primary page",
            ),
            page(
                "syscall_channel_spill",
                pm::THREAD_SLOT_CHANNEL_SPILL_PAGE,
                "per-pthread syscall channel spill page",
            ),
        ]),
    );

    let mut m: JsonMap = BTreeMap::new();
    m.insert("wasm_page_size".into(), json!(pm::WASM_PAGE_SIZE));
    m.insert("channel_pages".into(), json!(channel_pages));
    m.insert(
        "fork_save_buffer_size".into(),
        json!(pm::FORK_SAVE_BUFFER_SIZE),
    );
    m.insert(
        "main_control".into(),
        Value::Object(main_control.into_iter().collect()),
    );
    m.insert(
        "thread_slot".into(),
        Value::Object(thread_slot.into_iter().collect()),
    );
    m.insert(
        "process_wasm_declarations".into(),
        Value::Object(declarations.into_iter().collect()),
    );
    m.insert(
        "defaults".into(),
        Value::Object(defaults.into_iter().collect()),
    );
    m.insert("legacy".into(), Value::Object(legacy.into_iter().collect()));
    Value::Object(m.into_iter().collect())
}

fn channel_signal_area() -> Value {
    use shared::channel::*;
    let entries = [
        (
            "SIG_SIGNUM",
            SIG_SIGNUM,
            4u32,
            "u32, signal number (0=none)",
        ),
        ("SIG_HANDLER", SIG_HANDLER, 4, "u32, handler table index"),
        ("SIG_FLAGS", SIG_FLAGS, 4, "u32, sa_flags"),
        (
            "SIG_OLD_MASK",
            SIG_OLD_MASK,
            8,
            "u64 (LE), saved blocked mask",
        ),
    ];
    let mut list = Vec::new();
    for (name, offset, size, meaning) in entries {
        let mut m: JsonMap = BTreeMap::new();
        m.insert("name".into(), json!(name));
        m.insert("offset".into(), json!(offset));
        m.insert("size".into(), json!(size));
        m.insert("meaning".into(), json!(meaning));
        list.push(Value::Object(m.into_iter().collect()));
    }
    let mut m: JsonMap = BTreeMap::new();
    m.insert("base".into(), json!(SIG_BASE));
    m.insert("slots".into(), Value::Array(list));
    Value::Object(m.into_iter().collect())
}

fn marshalled_structs() -> Value {
    use shared::dri::{
        WpkDrmBindForeignTexture, WpkDrmEventVblank, WpkDrmGemClose, WpkDrmGetCap,
        WpkDrmGpuBoCreate, WpkDrmModeCardRes, WpkDrmModeCreateDumb,
        WpkDrmModeCrtcPageFlip, WpkDrmModeDestroyDumb, WpkDrmModeFbCmd2,
        WpkDrmModeGetConnector, WpkDrmModeGetCrtc, WpkDrmModeGetEncoder,
        WpkDrmModeMapDumb, WpkDrmModeModeinfo, WpkDrmPrimeHandle, WpkDrmVersion,
        WpkDrmWaitVblankReply, WpkDrmWaitVblankRequest,
    };
    use shared::fbdev::{FbBitfield, FbFixScreenInfo, FbVarScreenInfo};
    use shared::gl::{GlContextAttrs, GlQueryInfo, GlSubmitInfo, GlSurfaceAttrs};
    use shared::{
        KernelWaitResult, WasmDirent, WasmFlock, WasmPollFd, WasmRusageWire, WasmStat,
        WasmStatfs, WasmTimespec,
    };

    let mut structs: JsonMap = BTreeMap::new();
    structs.insert(
        "WasmStat".into(),
        struct_layout!(WasmStat {
            st_dev,
            st_ino,
            st_mode,
            st_nlink,
            st_uid,
            st_gid,
            st_size,
            st_atime_sec,
            st_atime_nsec,
            st_mtime_sec,
            st_mtime_nsec,
            st_ctime_sec,
            st_ctime_nsec,
            _pad,
        }),
    );
    structs.insert(
        "WasmDirent".into(),
        struct_layout!(WasmDirent {
            d_ino,
            d_type,
            d_namlen
        }),
    );
    structs.insert(
        "WasmFlock".into(),
        struct_layout!(WasmFlock {
            l_type,
            l_whence,
            _pad1,
            l_start,
            l_len,
            l_pid,
            _pad2
        }),
    );
    structs.insert(
        "WasmTimespec".into(),
        struct_layout!(WasmTimespec { tv_sec, tv_nsec }),
    );
    structs.insert(
        "WasmPollFd".into(),
        struct_layout!(WasmPollFd {
            fd,
            events,
            revents
        }),
    );
    structs.insert(
        "WasmStatfs".into(),
        struct_layout!(WasmStatfs {
            f_type,
            f_bsize,
            f_blocks,
            f_bfree,
            f_bavail,
            f_files,
            f_ffree,
            f_fsid,
            f_namelen,
            f_frsize,
            f_flags,
            _pad,
        }),
    );
    structs.insert(
        "WasmRusageWire".into(),
        struct_layout!(WasmRusageWire {
            ru_utime_sec,
            ru_utime_usec,
            ru_stime_sec,
            ru_stime_usec,
            ru_maxrss,
            ru_ixrss,
            ru_idrss,
            ru_isrss,
            ru_minflt,
            ru_majflt,
            ru_nswap,
            ru_inblock,
            ru_oublock,
            ru_msgsnd,
            ru_msgrcv,
            ru_nsignals,
            ru_nvcsw,
            ru_nivcsw,
        }),
    );
    structs.insert(
        "KernelWaitResult".into(),
        struct_layout!(KernelWaitResult {
            wait_status,
            si_code,
            si_status,
            child_uid,
            rusage,
        }),
    );
    structs.insert(
        "FbBitfield".into(),
        struct_layout!(FbBitfield {
            offset,
            length,
            msb_right
        }),
    );
    structs.insert(
        "FbVarScreenInfo".into(),
        struct_layout!(FbVarScreenInfo {
            xres,
            yres,
            xres_virtual,
            yres_virtual,
            xoffset,
            yoffset,
            bits_per_pixel,
            grayscale,
            red,
            green,
            blue,
            transp,
            nonstd,
            activate,
            height,
            width,
            accel_flags,
            pixclock,
            left_margin,
            right_margin,
            upper_margin,
            lower_margin,
            hsync_len,
            vsync_len,
            sync,
            vmode,
            rotate,
            colorspace,
            reserved,
        }),
    );
    structs.insert(
        "FbFixScreenInfo".into(),
        struct_layout!(FbFixScreenInfo {
            id,
            smem_start,
            smem_len,
            fb_type,
            type_aux,
            visual,
            xpanstep,
            ypanstep,
            ywrapstep,
            _pad,
            line_length,
            mmio_start,
            mmio_len,
            accel,
            capabilities,
            reserved,
            _pad_to_80,
        }),
    );
    structs.insert(
        "GlSubmitInfo".into(),
        struct_layout!(GlSubmitInfo { offset, length }),
    );
    structs.insert(
        "GlContextAttrs".into(),
        struct_layout!(GlContextAttrs {
            client_version,
            reserved
        }),
    );
    structs.insert(
        "GlSurfaceAttrs".into(),
        struct_layout!(GlSurfaceAttrs {
            kind,
            width,
            height,
            config_id,
            reserved
        }),
    );
    structs.insert(
        "GlQueryInfo".into(),
        struct_layout!(GlQueryInfo {
            op,
            in_buf_ptr,
            in_buf_len,
            out_buf_ptr,
            out_buf_len,
            reserved
        }),
    );
    structs.insert(
        "WpkDrmModeCreateDumb".into(),
        struct_layout!(WpkDrmModeCreateDumb {
            height,
            width,
            bpp,
            flags,
            handle,
            pitch,
            size
        }),
    );
    structs.insert(
        "WpkDrmModeMapDumb".into(),
        struct_layout!(WpkDrmModeMapDumb {
            handle,
            pad,
            offset
        }),
    );
    structs.insert(
        "WpkDrmModeDestroyDumb".into(),
        struct_layout!(WpkDrmModeDestroyDumb { handle }),
    );
    structs.insert(
        "WpkDrmGemClose".into(),
        struct_layout!(WpkDrmGemClose { handle, pad }),
    );
    structs.insert(
        "WpkDrmPrimeHandle".into(),
        struct_layout!(WpkDrmPrimeHandle {
            handle,
            flags,
            fd
        }),
    );
    structs.insert(
        "WpkDrmGetCap".into(),
        struct_layout!(WpkDrmGetCap { capability, value }),
    );
    structs.insert(
        "WpkDrmVersion".into(),
        struct_layout!(WpkDrmVersion {
            version_major,
            version_minor,
            version_patchlevel,
            name_len,
            name_ptr,
            date_len,
            date_ptr,
            desc_len,
            desc_ptr
        }),
    );
    structs.insert(
        "WpkDrmGpuBoCreate".into(),
        struct_layout!(WpkDrmGpuBoCreate {
            width,
            height,
            format,
            usage
        }),
    );
    structs.insert(
        "WpkDrmBindForeignTexture".into(),
        struct_layout!(WpkDrmBindForeignTexture {
            bo_handle,
            gl_target,
            ctx_id,
            gl_texture_id
        }),
    );
    structs.insert(
        "WpkDrmModeCardRes".into(),
        struct_layout!(WpkDrmModeCardRes {
            fb_id_ptr,
            crtc_id_ptr,
            connector_id_ptr,
            encoder_id_ptr,
            count_fbs,
            count_crtcs,
            count_connectors,
            count_encoders,
            min_width,
            max_width,
            min_height,
            max_height
        }),
    );
    structs.insert(
        "WpkDrmModeModeinfo".into(),
        struct_layout!(WpkDrmModeModeinfo {
            clock,
            hdisplay,
            hsync_start,
            hsync_end,
            htotal,
            hskew,
            vdisplay,
            vsync_start,
            vsync_end,
            vtotal,
            vscan,
            vrefresh,
            flags,
            mode_type,
            name
        }),
    );
    structs.insert(
        "WpkDrmModeGetCrtc".into(),
        struct_layout!(WpkDrmModeGetCrtc {
            set_connectors_ptr,
            count_connectors,
            crtc_id,
            fb_id,
            x,
            y,
            gamma_size,
            mode_valid,
            mode
        }),
    );
    structs.insert(
        "WpkDrmModeGetConnector".into(),
        struct_layout!(WpkDrmModeGetConnector {
            encoders_ptr,
            modes_ptr,
            props_ptr,
            prop_values_ptr,
            count_modes,
            count_props,
            count_encoders,
            encoder_id,
            connector_id,
            connector_type,
            connector_type_id,
            connection,
            mm_width,
            mm_height,
            subpixel,
            pad
        }),
    );
    structs.insert(
        "WpkDrmModeGetEncoder".into(),
        struct_layout!(WpkDrmModeGetEncoder {
            encoder_id,
            encoder_type,
            crtc_id,
            possible_crtcs,
            possible_clones
        }),
    );
    structs.insert(
        "WpkDrmModeFbCmd2".into(),
        struct_layout!(WpkDrmModeFbCmd2 {
            fb_id,
            width,
            height,
            pixel_format,
            flags,
            handles,
            pitches,
            offsets,
            modifier
        }),
    );
    structs.insert(
        "WpkDrmModeCrtcPageFlip".into(),
        struct_layout!(WpkDrmModeCrtcPageFlip {
            crtc_id,
            fb_id,
            flags,
            reserved,
            user_data
        }),
    );
    structs.insert(
        "WpkDrmEventVblank".into(),
        struct_layout!(WpkDrmEventVblank {
            ev_type,
            length,
            user_data,
            tv_sec,
            tv_usec,
            sequence,
            crtc_id
        }),
    );
    structs.insert(
        "WpkDrmWaitVblankRequest".into(),
        struct_layout!(WpkDrmWaitVblankRequest {
            req_type,
            sequence,
            signal
        }),
    );
    structs.insert(
        "WpkDrmWaitVblankReply".into(),
        struct_layout!(WpkDrmWaitVblankReply {
            rep_type,
            sequence,
            tv_sec,
            tv_usec
        }),
    );

    Value::Object(structs.into_iter().collect())
}

fn syscalls() -> Value {
    let mut list = Vec::new();
    for (number, name) in all_syscall_metadata() {
        let mut m: JsonMap = BTreeMap::new();
        m.insert("number".into(), json!(number));
        m.insert("name".into(), json!(name));
        list.push(Value::Object(m.into_iter().collect()));
    }
    Value::Array(list)
}

fn pathconf_names() -> Value {
    let mut names: JsonMap = BTreeMap::new();
    for (name, number) in shared::pathconf::ABI_NAMES {
        names.insert((*name).into(), json!(number));
    }
    Value::Object(names.into_iter().collect())
}

fn wait_contract() -> Value {
    let mut contract: JsonMap = BTreeMap::new();
    for (name, value) in [
        ("WAIT_EVENT_EXITED", json!(shared::wait::EVENT_EXITED)),
        ("WAIT_EVENT_STOPPED", json!(shared::wait::EVENT_STOPPED)),
        (
            "WAIT_EVENT_CONTINUED",
            json!(shared::wait::EVENT_CONTINUED),
        ),
        ("WAIT_WNOHANG", json!(shared::wait::WNOHANG)),
        ("WAIT_WUNTRACED", json!(shared::wait::WUNTRACED)),
        ("WAIT_WSTOPPED", json!(shared::wait::WSTOPPED)),
        ("WAIT_WEXITED", json!(shared::wait::WEXITED)),
        ("WAIT_WCONTINUED", json!(shared::wait::WCONTINUED)),
        ("WAIT_WNOWAIT", json!(shared::wait::WNOWAIT)),
        ("WAIT_CLD_EXITED", json!(shared::wait::CLD_EXITED)),
        ("WAIT_CLD_KILLED", json!(shared::wait::CLD_KILLED)),
        ("WAIT_CLD_STOPPED", json!(shared::wait::CLD_STOPPED)),
        (
            "WAIT_CLD_CONTINUED",
            json!(shared::wait::CLD_CONTINUED),
        ),
        (
            "PROCESS_STATE_RUNNING",
            json!(shared::wait::PROCESS_STATE_RUNNING),
        ),
        (
            "PROCESS_STATE_STOPPED",
            json!(shared::wait::PROCESS_STATE_STOPPED),
        ),
        (
            "PROCESS_STATE_EXITED",
            json!(shared::wait::PROCESS_STATE_EXITED),
        ),
        (
            "WAKE_PROCESS_STOPPED",
            json!(shared::wait::WAKE_PROCESS_STOPPED),
        ),
        (
            "WAKE_PROCESS_CONTINUED",
            json!(shared::wait::WAKE_PROCESS_CONTINUED),
        ),
    ] {
        contract.insert(name.into(), value);
    }
    Value::Object(contract.into_iter().collect())
}

#[derive(Debug, Clone, Copy)]
struct HostInterceptedSyscall {
    constant_name: &'static str,
    number: u32,
    log_name: &'static str,
}

fn host_intercepted_syscall_metadata() -> [HostInterceptedSyscall; 5] {
    use shared::abi::host_intercepted::*;

    [
        HostInterceptedSyscall {
            constant_name: "SYS_EXECVE",
            number: SYS_EXECVE,
            log_name: "execve",
        },
        HostInterceptedSyscall {
            constant_name: "SYS_FORK",
            number: SYS_FORK,
            log_name: "fork",
        },
        HostInterceptedSyscall {
            constant_name: "SYS_VFORK",
            number: SYS_VFORK,
            log_name: "vfork",
        },
        HostInterceptedSyscall {
            constant_name: "SYS_SPAWN",
            number: SYS_SPAWN,
            log_name: "spawn",
        },
        HostInterceptedSyscall {
            constant_name: "SYS_EXECVEAT",
            number: SYS_EXECVEAT,
            log_name: "execveat",
        },
    ]
}

fn all_syscall_metadata() -> BTreeMap<u32, String> {
    let mut syscalls = BTreeMap::new();
    for number in 0u32..1024 {
        if let Some(syscall) = shared::Syscall::from_u32(number) {
            insert_syscall_metadata(&mut syscalls, number, format!("{syscall:?}"));
        }
    }
    for syscall in shared::abi::extended_syscalls::SYSCALLS {
        insert_syscall_metadata(&mut syscalls, syscall.number, syscall.name.to_string());
    }
    syscalls
}

fn all_syscall_log_names() -> BTreeMap<u32, String> {
    let mut names = BTreeMap::new();
    for (number, name) in all_syscall_metadata() {
        insert_syscall_metadata(&mut names, number, syscall_log_name(&name));
    }
    for syscall in host_intercepted_syscall_metadata() {
        insert_syscall_metadata(&mut names, syscall.number, syscall.log_name.to_string());
    }
    names
}

fn syscall_log_name(name: &str) -> String {
    match name {
        "Seek" => "lseek".to_string(),
        "GetEnv" => "getenv".to_string(),
        "SetEnv" => "setenv".to_string(),
        "UnsetEnv" => "unsetenv".to_string(),
        "Statfs" => "statfs64".to_string(),
        "Fstatfs" => "fstatfs64".to_string(),
        "Llseek" => "_llseek".to_string(),
        _ => pascal_to_snake_case(name),
    }
}

fn pascal_to_snake_case(name: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = name.chars().collect();
    for (idx, ch) in chars.iter().copied().enumerate() {
        if ch.is_ascii_uppercase() {
            if idx > 0 {
                let prev = chars[idx - 1];
                let next = chars.get(idx + 1).copied();
                if prev.is_ascii_lowercase()
                    || prev.is_ascii_digit()
                    || next.is_some_and(|next| next.is_ascii_lowercase())
                {
                    out.push('_');
                }
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch.to_ascii_lowercase());
        }
    }
    out
}

fn insert_syscall_metadata(syscalls: &mut BTreeMap<u32, String>, number: u32, name: String) {
    if let Some(existing) = syscalls.insert(number, name.clone()) {
        panic!("duplicate ABI syscall number {number}: {existing} and {name}");
    }
}

fn host_intercepted_syscalls() -> Value {
    // These syscall numbers are caught by the host *before* reaching the
    // kernel's dispatcher (see `host/src/kernel-worker.ts`). They live
    // outside `shared::Syscall` because they don't go through the same
    // channel handler. The snapshot still tracks them so add/remove/renumber
    // is caught by the structural drift check.
    let mut list = Vec::new();
    for syscall in host_intercepted_syscall_metadata() {
        let mut m: JsonMap = BTreeMap::new();
        m.insert("number".into(), json!(syscall.number));
        m.insert("name".into(), json!(syscall.constant_name));
        list.push(Value::Object(m.into_iter().collect()));
    }
    Value::Array(list)
}

fn syscall_arg_descriptors() -> Value {
    let mut descriptors: JsonMap = BTreeMap::new();
    for entry in shared::host_abi::SYSCALL_ARG_DESCRIPTORS {
        let args = entry.args.iter().map(syscall_arg_desc_json).collect();
        descriptors.insert(entry.syscall_number.to_string(), Value::Array(args));
    }
    Value::Object(descriptors.into_iter().collect())
}

fn host_adapter() -> Value {
    let manifest = shared::abi::HOST_ADAPTER_MANIFEST;

    let mut manifest_json: JsonMap = BTreeMap::new();
    manifest_json.insert("magic".into(), json!(manifest.magic));
    manifest_json.insert("manifest_version".into(), json!(manifest.manifest_version));
    manifest_json.insert("manifest_size".into(), json!(manifest.manifest_size));
    manifest_json.insert("abi_version".into(), json!(manifest.abi_version));
    manifest_json.insert(
        "required_host_adapter_version".into(),
        json!(manifest.required_host_adapter_version),
    );
    manifest_json.insert(
        "required_worker_features".into(),
        json!(manifest.required_worker_features),
    );
    manifest_json.insert(
        "optional_kernel_features".into(),
        json!(manifest.optional_kernel_features),
    );
    manifest_json.insert(
        "channel_header_size".into(),
        json!(manifest.channel_header_size),
    );
    manifest_json.insert(
        "channel_data_offset".into(),
        json!(manifest.channel_data_offset),
    );
    manifest_json.insert(
        "channel_data_size".into(),
        json!(manifest.channel_data_size),
    );
    manifest_json.insert("channel_min_size".into(), json!(manifest.channel_min_size));

    let fields = host_adapter_manifest_fields()
        .into_iter()
        .map(|field| {
            let mut m: JsonMap = BTreeMap::new();
            m.insert("name".into(), json!(field.name));
            m.insert("offset".into(), json!(field.offset));
            m.insert("size".into(), json!(field.size));
            Value::Object(m.into_iter().collect())
        })
        .collect();

    let worker_features = shared::abi::HOST_ADAPTER_WORKER_FEATURES
        .iter()
        .map(|feature| {
            let mut m: JsonMap = BTreeMap::new();
            m.insert("name".into(), json!(feature.name));
            m.insert("bit".into(), json!(feature.bit));
            Value::Object(m.into_iter().collect())
        })
        .collect();

    let mut m: JsonMap = BTreeMap::new();
    m.insert("version".into(), json!(shared::abi::HOST_ADAPTER_VERSION));
    m.insert(
        "manifest".into(),
        Value::Object(manifest_json.into_iter().collect()),
    );
    m.insert("manifest_fields".into(), Value::Array(fields));
    m.insert(
        "required_worker_features".into(),
        json!(shared::abi::HOST_ADAPTER_REQUIRED_WORKER_FEATURES),
    );
    m.insert(
        "optional_kernel_features".into(),
        json!(shared::abi::HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES),
    );
    m.insert("worker_features".into(), Value::Array(worker_features));
    m.insert(
        "required_kernel_exports".into(),
        Value::Array(
            shared::abi::HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS
                .iter()
                .map(|name| Value::String((*name).to_string()))
                .collect(),
        ),
    );
    m.insert(
        "optional_kernel_exports".into(),
        Value::Array(
            shared::abi::HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS
                .iter()
                .map(|name| Value::String((*name).to_string()))
                .collect(),
        ),
    );
    Value::Object(m.into_iter().collect())
}

fn syscall_arg_desc_json(desc: &shared::host_abi::SyscallArgDesc) -> Value {
    let mut m: JsonMap = BTreeMap::new();
    m.insert("argIndex".into(), json!(desc.arg_index));
    m.insert(
        "direction".into(),
        json!(syscall_arg_direction_name(desc.direction)),
    );
    m.insert("size".into(), syscall_arg_size_json(desc.size));
    if desc.nullable {
        m.insert("nullable".into(), json!(true));
    }
    if desc.required {
        m.insert("required".into(), json!(true));
    }
    if desc.copy_retval_add != 0 {
        m.insert("copyRetvalAdd".into(), json!(desc.copy_retval_add));
    }
    Value::Object(m.into_iter().collect())
}

fn syscall_arg_size_json(size: shared::host_abi::SyscallArgSize) -> Value {
    use shared::host_abi::SyscallArgSize;

    let mut m: JsonMap = BTreeMap::new();
    match size {
        SyscallArgSize::CString => {
            m.insert("type".into(), json!("cstring"));
        }
        SyscallArgSize::Arg {
            arg_index,
            multiplier,
            add,
        } => {
            m.insert("type".into(), json!("arg"));
            m.insert("argIndex".into(), json!(arg_index));
            if multiplier != 1 {
                m.insert("multiplier".into(), json!(multiplier));
            }
            if add != 0 {
                m.insert("add".into(), json!(add));
            }
        }
        SyscallArgSize::Deref { arg_index } => {
            m.insert("type".into(), json!("deref"));
            m.insert("argIndex".into(), json!(arg_index));
        }
        SyscallArgSize::Fixed { size } => {
            m.insert("type".into(), json!("fixed"));
            m.insert("size".into(), json!(size));
        }
    }
    Value::Object(m.into_iter().collect())
}

fn channel_status_codes() -> Value {
    use shared::ChannelStatus::*;
    let mut list = Vec::new();
    for (n, name) in [
        (Idle, "Idle"),
        (Pending, "Pending"),
        (Complete, "Complete"),
        (Error, "Error"),
    ] {
        let mut m: JsonMap = BTreeMap::new();
        m.insert("number".into(), json!(n as u32));
        m.insert("name".into(), json!(name));
        list.push(Value::Object(m.into_iter().collect()));
    }
    Value::Array(list)
}

fn custom_sections() -> Value {
    json!([shared::abi::ABI_CUSTOM_SECTION])
}

fn process_expected_globals() -> Value {
    let mut list: Vec<&str> = shared::abi::PROCESS_EXPECTED_GLOBALS.to_vec();
    list.sort();
    Value::Array(list.into_iter().map(Value::from).collect())
}

fn export_deny() -> Value {
    let mut prefixes: Vec<&str> = shared::abi::EXPORT_DENY_PREFIXES.to_vec();
    let mut exact: Vec<&str> = shared::abi::EXPORT_DENY_EXACT.to_vec();
    let mut value_prefixes: Vec<&str> = shared::abi::ABI_VALUE_CAPTURE_PREFIXES.to_vec();
    prefixes.sort();
    exact.sort();
    value_prefixes.sort();
    let mut m: JsonMap = BTreeMap::new();
    m.insert(
        "deny_prefixes".into(),
        Value::Array(prefixes.into_iter().map(Value::from).collect()),
    );
    m.insert(
        "deny_exact".into(),
        Value::Array(exact.into_iter().map(Value::from).collect()),
    );
    m.insert(
        "value_capture_prefixes".into(),
        Value::Array(value_prefixes.into_iter().map(Value::from).collect()),
    );
    Value::Object(m.into_iter().collect())
}

fn kernel_exports(bytes: &[u8]) -> Result<Value, String> {
    use wasmparser::{
        CompositeInnerType, ExternalKind, FuncType, GlobalType, Imports, Operator, Parser, Payload,
        TypeRef,
    };

    // Accumulate what we need to resolve exports. Wasm section ordering
    // puts types, imports, functions, globals before exports, so a
    // single forward pass is sufficient.
    let mut func_type_for_local_idx: Vec<u32> = Vec::new();
    let mut func_types: Vec<FuncType> = Vec::new();
    let mut imported_funcs: u32 = 0;
    let mut imported_globals: u32 = 0;
    let mut global_types: Vec<GlobalType> = Vec::new();
    let mut global_init_i64: Vec<Option<i64>> = Vec::new();
    let mut exports: Vec<(String, ExternalKind, u32)> = Vec::new();

    for payload in Parser::new(0).parse_all(bytes) {
        let p = payload.map_err(|e| format!("parse wasm: {e}"))?;
        match p {
            Payload::TypeSection(r) => {
                for rec in r {
                    let rec = rec.map_err(|e| format!("type section: {e}"))?;
                    for st in rec.types() {
                        match &st.composite_type.inner {
                            CompositeInnerType::Func(f) => func_types.push(f.clone()),
                            // Non-func composite types (arrays/structs from
                            // the GC proposal) are not in scope here; push
                            // a zero-arity placeholder so index arithmetic
                            // stays correct.
                            _ => func_types.push(FuncType::new([], [])),
                        }
                    }
                }
            }
            Payload::ImportSection(r) => {
                for group in r {
                    let group = group.map_err(|e| format!("import section: {e}"))?;
                    // Three import-group encodings in wasmparser 0.247.
                    // Only `Single` appears in stock LLVM output; others
                    // come from the compact-imports proposal and are
                    // handled here for completeness.
                    let tick = |ty: TypeRef,
                                imported_funcs: &mut u32,
                                imported_globals: &mut u32| match ty
                    {
                        TypeRef::Func(_) | TypeRef::FuncExact(_) => *imported_funcs += 1,
                        TypeRef::Global(_) => *imported_globals += 1,
                        _ => {}
                    };
                    match group {
                        Imports::Single(_, imp) => {
                            tick(imp.ty, &mut imported_funcs, &mut imported_globals);
                        }
                        Imports::Compact1 { items, .. } => {
                            for item in items {
                                let item = item.map_err(|e| format!("import section: {e}"))?;
                                tick(item.ty, &mut imported_funcs, &mut imported_globals);
                            }
                        }
                        Imports::Compact2 { ty, names, .. } => {
                            for name in names {
                                let _ = name.map_err(|e| format!("import section: {e}"))?;
                                tick(ty, &mut imported_funcs, &mut imported_globals);
                            }
                        }
                    }
                }
            }
            Payload::FunctionSection(r) => {
                for ti in r {
                    func_type_for_local_idx.push(ti.map_err(|e| format!("function section: {e}"))?);
                }
            }
            Payload::GlobalSection(r) => {
                for g in r {
                    let g = g.map_err(|e| format!("global section: {e}"))?;
                    global_types.push(g.ty);
                    let mut ops = g.init_expr.get_operators_reader();
                    let val = match ops.read() {
                        Ok(Operator::I32Const { value }) => Some(value as i64),
                        Ok(Operator::I64Const { value }) => Some(value),
                        _ => None,
                    };
                    global_init_i64.push(val);
                }
            }
            Payload::ExportSection(r) => {
                for exp in r {
                    let exp = exp.map_err(|e| format!("export section: {e}"))?;
                    exports.push((exp.name.to_string(), exp.kind, exp.index));
                }
            }
            _ => {}
        }
    }

    // Sort exports by name for deterministic output. BTreeMap doesn't
    // help here because we construct a Vec<Value> at the top level.
    exports.sort_by(|a, b| a.0.cmp(&b.0));

    let mut list = Vec::new();
    for (name, kind, index) in exports {
        if !shared::abi::export_is_tracked(&name) {
            continue;
        }
        let mut m: JsonMap = BTreeMap::new();
        m.insert("name".into(), json!(name));

        match kind {
            ExternalKind::Func | ExternalKind::FuncExact => {
                m.insert("kind".into(), json!("func"));
                let sig = if index < imported_funcs {
                    "<imported>".to_string()
                } else {
                    let local = (index - imported_funcs) as usize;
                    func_type_for_local_idx
                        .get(local)
                        .and_then(|ti| func_types.get(*ti as usize))
                        .map(format_func_type)
                        .unwrap_or_else(|| "<unknown>".into())
                };
                m.insert("signature".into(), json!(sig));
            }
            ExternalKind::Global => {
                m.insert("kind".into(), json!("global"));
                if index < imported_globals {
                    m.insert("type".into(), json!("<imported>"));
                } else {
                    let local = (index - imported_globals) as usize;
                    if let Some(gt) = global_types.get(local) {
                        m.insert("type".into(), json!(val_type_name(&gt.content_type)));
                        m.insert("mutable".into(), json!(gt.mutable));
                        if shared::abi::export_value_is_tracked(&name) && !gt.mutable {
                            if let Some(Some(v)) = global_init_i64.get(local) {
                                m.insert("value".into(), json!(v));
                            }
                        }
                    } else {
                        m.insert("type".into(), json!("<unknown>"));
                    }
                }
            }
            ExternalKind::Memory => {
                m.insert("kind".into(), json!("memory"));
            }
            ExternalKind::Table => {
                m.insert("kind".into(), json!("table"));
            }
            ExternalKind::Tag => {
                m.insert("kind".into(), json!("tag"));
            }
        }
        list.push(Value::Object(m.into_iter().collect()));
    }
    Ok(Value::Array(list))
}

fn format_func_type(f: &wasmparser::FuncType) -> String {
    let params: Vec<String> = f.params().iter().map(val_type_name).collect();
    let results: Vec<String> = f.results().iter().map(val_type_name).collect();
    format!("({}) -> ({})", params.join(","), results.join(","))
}

fn val_type_name(vt: &wasmparser::ValType) -> String {
    match vt {
        wasmparser::ValType::I32 => "i32",
        wasmparser::ValType::I64 => "i64",
        wasmparser::ValType::F32 => "f32",
        wasmparser::ValType::F64 => "f64",
        wasmparser::ValType::V128 => "v128",
        wasmparser::ValType::Ref(_) => "ref",
    }
    .to_string()
}

fn render_deterministic(root: &JsonMap) -> String {
    // Value::Object built from a BTreeMap serializes with BTreeMap's
    // alphabetical iteration, giving deterministic output.
    let value = Value::Object(root.clone().into_iter().collect());
    let mut s = serde_json::to_string_pretty(&value).expect("serialize");
    s.push('\n');
    s
}

#[derive(Default, Debug, PartialEq, Eq)]
struct CompatReport {
    additive: Vec<String>,
    breaking: Vec<String>,
}

fn classify_compat_change(old: &Value, new: &Value) -> Result<CompatReport, String> {
    let old_obj = old
        .as_object()
        .ok_or("old ABI snapshot root must be a JSON object")?;
    let new_obj = new
        .as_object()
        .ok_or("new ABI snapshot root must be a JSON object")?;

    let mut report = CompatReport::default();

    for key in old_obj.keys() {
        if !new_obj.contains_key(key) {
            report
                .breaking
                .push(format!("removed top-level section {key:?}"));
        }
    }
    for key in new_obj.keys() {
        if !old_obj.contains_key(key) {
            if additive_top_level_section(key) {
                report
                    .additive
                    .push(format!("added top-level section {key:?}"));
            } else {
                report
                    .breaking
                    .push(format!("added top-level section {key:?}"));
            }
        }
    }

    let mut keys: Vec<&String> = old_obj
        .keys()
        .filter(|key| new_obj.contains_key(*key))
        .collect();
    keys.sort();

    for key in keys {
        let old_value = &old_obj[key];
        let new_value = &new_obj[key];
        match key.as_str() {
            "syscalls" | "host_intercepted_syscalls" => {
                classify_additive_array_by_number_name(key, old_value, new_value, &mut report)?
            }
            "kernel_exports" => {
                classify_additive_array_by_name(key, old_value, new_value, &mut report)?
            }
            "host_adapter" => classify_host_adapter(old_value, new_value, &mut report)?,
            "marshalled_structs" => {
                classify_additive_object_by_key(key, old_value, new_value, &mut report)?
            }
            "syscall_arg_descriptors" => {
                classify_additive_object_by_key(key, old_value, new_value, &mut report)?
            }
            _ if old_value != new_value => {
                report
                    .breaking
                    .push(format!("changed top-level section {key:?}"));
            }
            _ => {}
        }
    }

    Ok(report)
}

fn additive_top_level_section(section: &str) -> bool {
    matches!(section, "host_adapter" | "syscall_arg_descriptors")
}

fn classify_host_adapter(
    old: &Value,
    new: &Value,
    report: &mut CompatReport,
) -> Result<(), String> {
    let old_obj = old
        .as_object()
        .ok_or("old host_adapter section must be a JSON object")?;
    let new_obj = new
        .as_object()
        .ok_or("new host_adapter section must be a JSON object")?;

    for key in old_obj.keys() {
        let Some(new_value) = new_obj.get(key) else {
            report
                .breaking
                .push(format!("removed host_adapter field {key:?}"));
            continue;
        };
        if key == "optional_kernel_exports" {
            classify_additive_array(
                "host_adapter.optional_kernel_exports",
                &old_obj[key],
                new_value,
                report,
                |entry| {
                    entry.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                        format!(
                            "host_adapter.optional_kernel_exports entry must be a string: {entry}",
                        )
                    })
                },
            )?;
        } else if &old_obj[key] != new_value {
            report
                .breaking
                .push(format!("changed host_adapter field {key:?}"));
        }
    }

    for key in new_obj.keys() {
        if !old_obj.contains_key(key) {
            report
                .breaking
                .push(format!("added host_adapter field {key:?}"));
        }
    }

    Ok(())
}

fn classify_additive_object_by_key(
    section: &str,
    old: &Value,
    new: &Value,
    report: &mut CompatReport,
) -> Result<(), String> {
    let old_obj = old
        .as_object()
        .ok_or_else(|| format!("old {section} section must be a JSON object"))?;
    let new_obj = new
        .as_object()
        .ok_or_else(|| format!("new {section} section must be a JSON object"))?;

    for key in old_obj.keys() {
        match new_obj.get(key) {
            Some(new_value) if new_value == &old_obj[key] => {}
            Some(_) => report
                .breaking
                .push(format!("changed {section} entry {key:?}")),
            None => report
                .breaking
                .push(format!("removed {section} entry {key:?}")),
        }
    }
    for key in new_obj.keys() {
        if !old_obj.contains_key(key) {
            report
                .additive
                .push(format!("added {section} entry {key:?}"));
        }
    }

    Ok(())
}

fn classify_additive_array_by_name(
    section: &str,
    old: &Value,
    new: &Value,
    report: &mut CompatReport,
) -> Result<(), String> {
    classify_additive_array(section, old, new, report, |entry| {
        entry
            .get("name")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| format!("{section} entry missing string name: {entry}"))
    })
}

fn classify_additive_array_by_number_name(
    section: &str,
    old: &Value,
    new: &Value,
    report: &mut CompatReport,
) -> Result<(), String> {
    classify_additive_array(section, old, new, report, |entry| {
        let number = entry
            .get("number")
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("{section} entry missing numeric number: {entry}"))?;
        if entry.get("name").and_then(Value::as_str).is_none() {
            return Err(format!("{section} entry missing string name: {entry}"));
        }
        Ok(number.to_string())
    })
}

fn classify_additive_array<F>(
    section: &str,
    old: &Value,
    new: &Value,
    report: &mut CompatReport,
    key_for: F,
) -> Result<(), String>
where
    F: Fn(&Value) -> Result<String, String>,
{
    let old_entries = keyed_array(section, old, &key_for)?;
    let new_entries = keyed_array(section, new, &key_for)?;

    for (key, old_value) in &old_entries {
        match new_entries.get(key) {
            Some(new_value) if new_value == old_value => {}
            Some(_) => report
                .breaking
                .push(format!("changed {section} entry {key:?}")),
            None => report
                .breaking
                .push(format!("removed {section} entry {key:?}")),
        }
    }
    for key in new_entries.keys() {
        if !old_entries.contains_key(key) {
            report
                .additive
                .push(format!("added {section} entry {key:?}"));
        }
    }

    Ok(())
}

fn keyed_array<F>(
    section: &str,
    value: &Value,
    key_for: F,
) -> Result<BTreeMap<String, Value>, String>
where
    F: Fn(&Value) -> Result<String, String>,
{
    let array = value
        .as_array()
        .ok_or_else(|| format!("{section} section must be a JSON array"))?;
    let mut out = BTreeMap::new();
    for entry in array {
        let key = key_for(entry)?;
        if out.insert(key.clone(), entry.clone()).is_some() {
            return Err(format!("{section} contains duplicate entry key {key:?}"));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn syscall_log_names_match_existing_trace_spelling() {
        let names = all_syscall_log_names();
        assert_eq!(names.get(&(shared::Syscall::Seek as u32)).unwrap(), "lseek");
        assert_eq!(
            names
                .get(&shared::abi::extended_syscalls::SYS_LLSEEK)
                .unwrap(),
            "_llseek"
        );
        assert_eq!(
            names
                .get(&shared::abi::extended_syscalls::SYS_GETRANDOM)
                .unwrap(),
            "getrandom"
        );
        assert_eq!(
            names
                .get(&shared::abi::extended_syscalls::SYS_TIMER_GETOVERRUN)
                .unwrap(),
            "timer_getoverrun"
        );
        assert_eq!(
            names
                .get(&shared::abi::host_intercepted::SYS_EXECVE)
                .unwrap(),
            "execve"
        );
        assert_eq!(
            names
                .get(&shared::abi::host_intercepted::SYS_SPAWN)
                .unwrap(),
            "spawn"
        );
    }

    #[test]
    fn generated_typescript_contains_pathconf_names_and_required_outputs() {
        let rendered = render_ts_module();
        assert!(rendered.contains("export const PATHCONF_NAMES = {"));
        assert!(rendered.contains("  PATH_MAX: 4,"));
        assert!(rendered.contains("  TIMESTAMP_RESOLUTION: 23,"));
        assert!(rendered.contains(
            "{ argIndex: 2, direction: \"out\", size: { type: \"fixed\", size: 8 }, required: true }"
        ));

        let names = pathconf_names();
        assert_eq!(names["LINK_MAX"], json!(0));
        assert_eq!(names["TIMESTAMP_RESOLUTION"], json!(23));
        assert_eq!(names.as_object().unwrap().len(), 24);
    }

    #[test]
    fn generated_wait_abi_metadata_matches_shared_layouts() {
        let rendered = render_ts_module();
        for expected in [
            "export const STRUCT_SIZE_WASM_RUSAGE_WIRE = 144 as const;",
            "export const STRUCT_SIZE_KERNEL_WAIT_RESULT = 160 as const;",
            "export const KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET = 0 as const;",
            "export const KERNEL_WAIT_RESULT_SI_CODE_OFFSET = 4 as const;",
            "export const KERNEL_WAIT_RESULT_SI_STATUS_OFFSET = 8 as const;",
            "export const KERNEL_WAIT_RESULT_CHILD_UID_OFFSET = 12 as const;",
            "export const KERNEL_WAIT_RESULT_RUSAGE_OFFSET = 16 as const;",
            "export const WAIT_EVENT_EXITED = 1 as const;",
            "export const WAIT_EVENT_STOPPED = 2 as const;",
            "export const WAIT_EVENT_CONTINUED = 4 as const;",
            "export const PROCESS_STATE_RUNNING = 0 as const;",
            "export const PROCESS_STATE_STOPPED = 1 as const;",
            "export const PROCESS_STATE_EXITED = 2 as const;",
            "export const WAKE_PROCESS_STOPPED = 16 as const;",
            "export const WAKE_PROCESS_CONTINUED = 32 as const;",
            "\"kernel_get_process_state\"",
            "\"kernel_has_sa_nocldstop\"",
            "\"kernel_wait_child_poll\"",
        ] {
            assert!(
                rendered.contains(expected),
                "missing generated TS: {expected}"
            );
        }

        let header = render_c_header();
        assert!(header.contains("#define WASM_POSIX_RUSAGE_WIRE_SIZE 144u"));

        let structs = marshalled_structs();
        assert_eq!(structs["WasmRusageWire"]["size"], json!(144));
        assert_eq!(structs["KernelWaitResult"]["size"], json!(160));
        assert_eq!(
            structs["KernelWaitResult"]["fields"][4],
            json!({"name": "rusage", "offset": 16, "span": 144})
        );

        let contract = wait_contract();
        assert_eq!(contract["WAIT_WNOWAIT"], json!(0x0100_0000));
        assert_eq!(contract["WAIT_CLD_CONTINUED"], json!(6));
        assert_eq!(contract["PROCESS_STATE_STOPPED"], json!(1));
        assert_eq!(contract["WAKE_PROCESS_CONTINUED"], json!(32));
        assert_eq!(contract.as_object().unwrap().len(), 18);
    }

    fn base_snapshot() -> Value {
        json!({
            "abi_version": 10,
            "channel_header": {"size": 64},
            "host_intercepted_syscalls": [
                {"number": 201, "name": "SYS_EXECVE"}
            ],
            "host_adapter": {
                "version": 1,
                "manifest": {
                    "abi_version": 10,
                    "channel_data_offset": 72,
                    "channel_data_size": 65536,
                    "channel_header_size": 72,
                    "channel_min_size": 65608,
                    "magic": 1296781399,
                    "manifest_size": 40,
                    "manifest_version": 1,
                    "optional_kernel_features": 0,
                    "required_host_adapter_version": 1,
                    "required_worker_features": 7
                },
                "manifest_fields": [
                    {"name": "magic", "offset": 0, "size": 4}
                ],
                "optional_kernel_features": 0,
                "optional_kernel_exports": [],
                "required_kernel_exports": ["__abi_version"],
                "required_worker_features": 7,
                "worker_features": [
                    {"name": "atomics_wait", "bit": 2}
                ]
            },
            "kernel_exports": [
                {"name": "__abi_version", "kind": "func", "signature": "() -> (i32)"},
                {"name": "kernel_set_current_pid", "kind": "func", "signature": "(i32) -> ()"}
            ],
            "marshalled_structs": {
                "WasmStat": {"size": 96, "fields": []}
            },
            "syscalls": [
                {"number": 1, "name": "Open"},
                {"number": 2, "name": "Close"}
            ],
            "syscall_arg_descriptors": {
                "1": [
                    {
                        "argIndex": 0,
                        "direction": "in",
                        "size": {"type": "cstring"}
                    }
                ]
            }
        })
    }

    #[test]
    fn additive_syscall_export_and_struct_are_compatible() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["syscalls"].as_array_mut().unwrap().push(json!({
            "number": 3,
            "name": "Read"
        }));
        new["host_intercepted_syscalls"]
            .as_array_mut()
            .unwrap()
            .push(json!({"number": 202, "name": "SYS_FORK"}));
        new["kernel_exports"].as_array_mut().unwrap().push(json!({
            "name": "kernel_new_helper",
            "kind": "func",
            "signature": "(i32) -> (i32)"
        }));
        new["marshalled_structs"]["WasmTimespec"] = json!({
            "size": 16,
            "fields": []
        });
        new["syscall_arg_descriptors"]["3"] = json!([
            {
                "argIndex": 1,
                "direction": "out",
                "size": {"type": "arg", "argIndex": 2}
            }
        ]);

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(report.additive.len(), 5);
    }

    #[test]
    fn adding_syscall_arg_descriptor_section_is_compatible() {
        let mut old = base_snapshot();
        old.as_object_mut()
            .unwrap()
            .remove("syscall_arg_descriptors");
        let new = base_snapshot();

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            vec!["added top-level section \"syscall_arg_descriptors\""]
        );
    }

    #[test]
    fn adding_host_adapter_section_is_compatible() {
        let mut old = base_snapshot();
        old.as_object_mut().unwrap().remove("host_adapter");
        let new = base_snapshot();

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            vec!["added top-level section \"host_adapter\""]
        );
    }

    #[test]
    fn adding_wait_contract_section_is_breaking() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["wait_contract"] = wait_contract();

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            vec!["added top-level section \"wait_contract\""]
        );
    }

    #[test]
    fn adding_optional_host_adapter_export_is_compatible() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["host_adapter"]["optional_kernel_exports"] =
            json!(["kernel_get_process_exit_signal",]);

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            vec![
                "added host_adapter.optional_kernel_exports entry \"kernel_get_process_exit_signal\"",
            ],
        );
    }

    #[test]
    fn changing_required_host_adapter_export_is_breaking() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["host_adapter"]["required_kernel_exports"] =
            json!(["__abi_version", "kernel_new_requirement",]);

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            vec!["changed host_adapter field \"required_kernel_exports\""],
        );
    }

    #[test]
    fn changed_existing_export_is_breaking() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["kernel_exports"][1]["signature"] = json!("(i64) -> ()");

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            vec!["changed kernel_exports entry \"kernel_set_current_pid\""]
        );
    }

    #[test]
    fn renamed_syscall_number_is_breaking() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["syscalls"][1]["name"] = json!("Dup");

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(report.breaking, vec!["changed syscalls entry \"2\""]);
    }

    #[test]
    fn changed_syscall_arg_descriptor_is_breaking() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["syscall_arg_descriptors"]["1"][0]["direction"] = json!("out");

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            vec!["changed syscall_arg_descriptors entry \"1\""]
        );
    }

    #[test]
    fn making_existing_syscall_pointer_required_is_breaking() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["syscall_arg_descriptors"]["1"][0]["required"] = json!(true);

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            vec!["changed syscall_arg_descriptors entry \"1\""]
        );
    }

    #[test]
    fn changed_channel_layout_is_breaking() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["channel_header"]["size"] = json!(72);

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            vec!["changed top-level section \"channel_header\""]
        );
    }
}
