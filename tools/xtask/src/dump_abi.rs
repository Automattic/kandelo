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
//!     deny-lists, custom-section names, and program-artifact fork contract
//!   * [`wasm_posix_shared::abi::HOST_ADAPTER_MANIFEST`] — kernel/host
//!     adapter boot contract metadata
//!   * [`wasm_posix_shared::host_abi`] — host adapter syscall marshalling
//!     descriptors
//!   * [`wasm_posix_shared::wakeup_event_wire`] — kernel wakeup-event layout
//!     and retry/lifecycle reason bits consumed by shared hosts
//!   * [`wasm_posix_shared::fork_contract`] — process-fork import mode values
//!   * [`wasm_posix_shared::poll`], [`wasm_posix_shared::epoll`], and
//!     [`wasm_posix_shared::select`] — I/O multiplexing event metadata
//!   * [`wasm_posix_shared::flags`], [`wasm_posix_shared::access`],
//!     [`wasm_posix_shared::mode`], [`wasm_posix_shared::dirent`], and
//!     [`wasm_posix_shared::seek`] — VFS-visible constants consumed by host
//!     adapters
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
use std::mem::{align_of, offset_of, size_of};
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
    let platform_limits_header = render_platform_limits_header();
    let process_layouts_header = render_process_layouts_header();
    let channel_scalars_header = render_channel_scalars_header();
    let marshal_header = render_marshal_header();
    let thread_syscalls_header = render_thread_syscalls_header();
    let spawn_header = render_spawn_contract_header();
    let soundcard_header = render_soundcard_header();
    let clipboard_header = render_clipboard_header();
    let ts_module = render_ts_module();
    let host_imports = render_host_imports_file();

    let out = out_path.unwrap_or_else(|| repo_root().join("abi/snapshot.json"));
    let header_out = repo_root().join("libc/glue/abi_constants.h");
    let platform_limits_header_out =
        repo_root().join("libc/musl-overlay/include/bits/kandelo_limits.h");
    let process_layouts_header_out =
        repo_root().join("libc/musl-overlay/include/bits/kandelo_process_layouts.h");
    let channel_scalars_header_out =
        repo_root().join("libc/musl-overlay/include/bits/kandelo_channel_scalars.h");
    let marshal_header_out =
        repo_root().join("libc/musl-overlay/include/bits/kandelo_syscall_marshal.h");
    let thread_syscalls_header_out =
        repo_root().join("libc/musl-overlay/include/bits/kandelo_thread_syscalls.h");
    let spawn_header_out =
        repo_root().join("libc/musl-overlay/src/process/wasm32posix/spawn_contract.h");
    let soundcard_header_out = repo_root().join("libc/musl-overlay/include/sys/soundcard.h");
    let clipboard_header_out =
        repo_root().join("libc/musl-overlay/include/kandelo/clipboard.h");
    let ts_out = repo_root().join("host/src/generated/abi.ts");
    let host_imports_out = repo_root().join("libc/glue/kandelo-host-imports.txt");

    if check {
        check_file(&out, &rendered, "ABI snapshot")?;
        check_file(&header_out, &header, "libc/glue/abi_constants.h")?;
        check_file(
            &platform_limits_header_out,
            &platform_limits_header,
            "musl Kandelo limits header",
        )?;
        check_file(
            &process_layouts_header_out,
            &process_layouts_header,
            "musl Kandelo process layouts header",
        )?;
        check_file(
            &channel_scalars_header_out,
            &channel_scalars_header,
            "musl Kandelo channel scalars header",
        )?;
        check_file(
            &marshal_header_out,
            &marshal_header,
            "musl Kandelo syscall marshal header",
        )?;
        check_file(
            &thread_syscalls_header_out,
            &thread_syscalls_header,
            "musl Kandelo thread syscall header",
        )?;
        check_file(&spawn_header_out, &spawn_header, "musl spawn_contract.h")?;
        check_file(
            &soundcard_header_out,
            &soundcard_header,
            "libc/musl-overlay/include/sys/soundcard.h",
        )?;
        check_file(
            &clipboard_header_out,
            &clipboard_header,
            "libc/musl-overlay/include/kandelo/clipboard.h",
        )?;
        check_file(&ts_out, &ts_module, "host/src/generated/abi.ts")?;
        check_file(&host_imports_out, &host_imports, "libc/glue/kandelo-host-imports.txt")?;
        println!("abi snapshot up-to-date: {}", out.display());
        println!("abi header up-to-date:  {}", header_out.display());
        println!(
            "platform limits header up-to-date: {}",
            platform_limits_header_out.display(),
        );
        println!(
            "process layouts header up-to-date: {}",
            process_layouts_header_out.display(),
        );
        println!(
            "channel scalars header up-to-date: {}",
            channel_scalars_header_out.display(),
        );
        println!(
            "syscall marshal header up-to-date: {}",
            marshal_header_out.display(),
        );
        println!(
            "thread syscall header up-to-date: {}",
            thread_syscalls_header_out.display(),
        );
        println!(
            "spawn contract header up-to-date: {}",
            spawn_header_out.display(),
        );
        println!(
            "OSS header up-to-date:  {}",
            soundcard_header_out.display()
        );
        println!(
            "clipboard header up-to-date: {}",
            clipboard_header_out.display()
        );
        println!("abi TS bindings up-to-date: {}", ts_out.display());
        return Ok(());
    }

    write_file(&out, &rendered)?;
    println!("wrote {}", out.display());
    write_file(&header_out, &header)?;
    println!("wrote {}", header_out.display());
    write_file(&platform_limits_header_out, &platform_limits_header)?;
    println!("wrote {}", platform_limits_header_out.display());
    write_file(&process_layouts_header_out, &process_layouts_header)?;
    println!("wrote {}", process_layouts_header_out.display());
    write_file(&channel_scalars_header_out, &channel_scalars_header)?;
    println!("wrote {}", channel_scalars_header_out.display());
    write_file(&marshal_header_out, &marshal_header)?;
    println!("wrote {}", marshal_header_out.display());
    write_file(&thread_syscalls_header_out, &thread_syscalls_header)?;
    println!("wrote {}", thread_syscalls_header_out.display());
    write_file(&spawn_header_out, &spawn_header)?;
    println!("wrote {}", spawn_header_out.display());
    write_file(&soundcard_header_out, &soundcard_header)?;
    println!("wrote {}", soundcard_header_out.display());
    write_file(&clipboard_header_out, &clipboard_header)?;
    println!("wrote {}", clipboard_header_out.display());
    write_file(&ts_out, &ts_module)?;
    println!("wrote {}", ts_out.display());
    write_file(&host_imports_out, &host_imports)?;
    println!("wrote {}", host_imports_out.display());
    Ok(())
}

fn render_thread_syscalls_header() -> String {
    use shared::abi::extended_syscalls as syscall_numbers;

    format!(
        "/* GENERATED by `cargo xtask dump-abi`. Do not edit by hand. */\n\
         /* Regenerated by scripts/check-abi-version.sh; drift is a CI failure. */\n\
         #ifndef KANDELO_THREAD_SYSCALLS_H\n\
         #define KANDELO_THREAD_SYSCALLS_H\n\
         \n\
         #define KANDELO_SYS_THREAD_CANCEL {thread_cancel}u\n\
         \n\
         #endif /* KANDELO_THREAD_SYSCALLS_H */\n",
        thread_cancel = syscall_numbers::SYS_THREAD_CANCEL,
    )
}

fn render_platform_limits_header() -> String {
    use shared::platform_limits;

    format!(
        "/* GENERATED by `cargo xtask dump-abi`. Do not edit by hand. */\n\
         /* Regenerated by scripts/check-abi-version.sh; drift is a CI failure. */\n\
         #ifndef KANDELO_PLATFORM_LIMITS_H\n\
         #define KANDELO_PLATFORM_LIMITS_H\n\
         \n\
         #define KANDELO_POSIX_ARG_MAX_BYTES {arg_max}u\n\
         #define KANDELO_POSIX_PATH_MAX_BYTES {path_max}u\n\
         #define KANDELO_POSIX_IOV_MAX {iov_max}u\n\
         #define KANDELO_PROCESS_METADATA_ENTRY_MAX_BYTES {metadata_entry_max}u\n\
         #define KANDELO_PROCESS_STARTUP_MAX_ARGV_COUNT {startup_argv_max}u\n\
         #define KANDELO_PROCESS_STARTUP_MAX_ENVP_COUNT {startup_envp_max}u\n\
         #define KANDELO_MAX_REPORTABLE_TRANSFER_BYTES {reportable_max}u\n\
         \n\
         #endif /* KANDELO_PLATFORM_LIMITS_H */\n",
        arg_max = platform_limits::ARG_MAX_BYTES,
        path_max = platform_limits::PATH_MAX_BYTES,
        iov_max = platform_limits::IOV_MAX,
        metadata_entry_max = platform_limits::PROCESS_METADATA_ENTRY_MAX_BYTES,
        startup_argv_max = platform_limits::PROCESS_STARTUP_MAX_ARGV_COUNT,
        startup_envp_max = platform_limits::PROCESS_STARTUP_MAX_ENVP_COUNT,
        reportable_max = platform_limits::MAX_REPORTABLE_TRANSFER_BYTES,
    )
}

fn render_channel_scalars_header() -> String {
    let mut out = String::from(
        "/* GENERATED by `cargo xtask dump-abi`. Do not edit by hand. */\n\
         #ifndef KANDELO_CHANNEL_SCALARS_H\n\
         #define KANDELO_CHANNEL_SCALARS_H\n\n\
         #include <bits/syscall.h>\n\n\
         /* WHY: the shared scalar table is authoritative, but musl still owns\n\
          * the public target syscall-number headers. Compile both together so\n\
          * a renumbering cannot silently reinterpret an i64 channel slot. */\n",
    );
    for contract in shared::channel_scalar::SYSCALLS {
        out.push_str(&format!(
            "#ifndef __NR_{}\n\
             #error \"musl is missing __NR_{} required by the Kandelo channel scalar contract\"\n\
             #endif\n\
             _Static_assert(__NR_{} == {}u,\n\
                            \"musl __NR_{} drifted from the Kandelo channel scalar contract\");\n",
            contract.musl_name,
            contract.musl_name,
            contract.musl_name,
            contract.syscall_number,
            contract.musl_name,
        ));
    }
    out.push_str("\n#endif\n");
    out
}

/// Render the guest syscall-marshalling descriptor header.
///
/// `SYSCALL_ARG_DESCRIPTORS` (`crates/shared/src/host_abi.rs`) is the single
/// authority for which syscall arguments are pointers and how the host sizes
/// them. Phase 2 moves that marshalling into the guest glue, so the guest needs
/// the same per-syscall knowledge at runtime. This header projects the same
/// table into a compact C form the encoder in `libc/glue/channel_syscall.c`
/// consumes (`__marshal_channel_record`). It is ADDITIVE — it does not feed the
/// ABI snapshot and does not change any ABI-locked value; it only re-expresses
/// data already present in the snapshot's `host_abi` section.
///
/// Two families collapse into the same table:
///   * every entry in `SYSCALL_ARG_DESCRIPTORS` (flat pointer args), whose
///     direction/size projects to a record `SPAN_KIND_*` plus a size rule; and
///   * the nested iovec/msghdr syscalls (`writev`/`readv`/`preadv`/`pwritev`/
///     `preadv2`/`pwritev2`, `sendmsg`/`recvmsg`), which are NOT in the flat
///     descriptor table and are marked with a nested shape the encoder folds
///     into a single `IOVEC_ARRAY`/`MSGHDR` span.
///
/// The `SPAN_KIND_*` / `SIZE_*` numeric values mirror
/// `wasm_posix_shared::channel_record` and `wasm_posix_shared::host_abi` and are
/// asserted against those sources by the marshal encoder's tests.
fn render_marshal_header() -> String {
    use shared::channel_record as record;
    use shared::host_abi::{SyscallArgDirection, SyscallArgSize, SYSCALL_ARG_DESCRIPTORS};

    // Record span kinds sourced from the authoritative record module so the
    // guest encoder cannot drift from the decoder.
    const SPAN_IN: u8 = record::SPAN_KIND_IN_PTR;
    const SPAN_OUT: u8 = record::SPAN_KIND_OUT_PTR;
    const SPAN_INOUT: u8 = record::SPAN_KIND_IN_OUT_PTR;
    const SPAN_PATH: u8 = record::SPAN_KIND_PATH_STR;
    const SPAN_IOVEC: u8 = record::SPAN_KIND_IOVEC_ARRAY;
    const SPAN_MSGHDR: u8 = record::SPAN_KIND_MSGHDR;
    // Size-rule kinds (mirror wasm_posix_shared::host_abi::SyscallArgSize order).
    const SIZE_CSTRING: u8 = 0;
    const SIZE_ARG: u8 = 1;
    const SIZE_DEREF: u8 = 2;
    const SIZE_FIXED: u8 = 3;
    const SIZE_LAYOUT: u8 = 4;
    // Whole-syscall nested shapes.
    const NESTED_NONE: u8 = 0;
    const NESTED_IOVEC: u8 = 1;
    const NESTED_MSGHDR: u8 = 2;

    fn dir_span(d: SyscallArgDirection) -> u8 {
        match d {
            SyscallArgDirection::In => 1,
            SyscallArgDirection::Out => 2,
            SyscallArgDirection::InOut => 3,
        }
    }

    struct Entry {
        number: u32,
        nested: u8,
        // Each arg: (arg_index, span_kind, size_kind, nullable, a, b, c).
        args: Vec<(u8, u8, u8, u8, u32, u32, u32)>,
    }

    let mut entries: Vec<Entry> = Vec::new();

    for descriptor in SYSCALL_ARG_DESCRIPTORS {
        let mut args = Vec::new();
        for arg in descriptor.args {
            let (span_kind, size_kind, a, b, c) = match arg.size {
                SyscallArgSize::CString { max_bytes, .. } => {
                    // Every CString descriptor is an input path/string; the
                    // record models it as a PATH_STR span (guest scans NUL,
                    // len includes the terminator, bounded by max_bytes).
                    (SPAN_PATH, SIZE_CSTRING, max_bytes, 0, 0)
                }
                SyscallArgSize::Arg {
                    arg_index,
                    multiplier,
                    add,
                } => (dir_span(arg.direction), SIZE_ARG, arg_index as u32, multiplier, add),
                SyscallArgSize::Deref { arg_index } => {
                    (dir_span(arg.direction), SIZE_DEREF, arg_index as u32, 0, 0)
                }
                SyscallArgSize::Fixed { size } => (dir_span(arg.direction), SIZE_FIXED, size, 0, 0),
                SyscallArgSize::ProcessLayout {
                    wasm32_size,
                    wasm64_size,
                } => (dir_span(arg.direction), SIZE_LAYOUT, wasm32_size, wasm64_size, 0),
                // The kernel dereferences this argument itself, so the guest
                // record carries no span for it: the raw guest address in the
                // scalar slot is the whole contract. Emitting a span would
                // ask the guest to copy bytes the kernel is about to read
                // directly, and no span kind can describe an extent the
                // kernel has not yet computed.
                SyscallArgSize::KernelDereferenced => continue,
            };
            args.push((
                arg.arg_index,
                span_kind,
                size_kind,
                arg.nullable as u8,
                a,
                b,
                c,
            ));
        }
        entries.push(Entry {
            number: descriptor.syscall_number,
            nested: NESTED_NONE,
            args,
        });
    }

    // writev/readv/preadv/pwritev/preadv2/pwritev2 deliberately have NO nested
    // entry, for the same reason as sendmsg/recvmsg below: their `struct iovec`
    // table is declared `KernelDereferenced` in `SYSCALL_ARG_DESCRIPTORS`, so
    // the record carries only the caller's raw address in its scalar slot and
    // the kernel walks the caller's own table.

    // sendmsg/recvmsg deliberately have NO nested entry. Their `msghdr` is
    // declared `KernelDereferenced` in `SYSCALL_ARG_DESCRIPTORS` above, so the
    // record carries only the caller's raw address in its scalar slot and the
    // kernel walks the header, the iovec table and the CMSG chain itself. A
    // MSGHDR span here would replace that address with a scratch offset and
    // make the kernel read caller memory the caller never named.

    entries.sort_by_key(|entry| entry.number);

    let mut out = String::new();
    out.push_str(
        "/* GENERATED by `cargo xtask dump-abi`. Do not edit by hand. */\n\
         /* Regenerated by scripts/check-abi-version.sh; drift is a CI failure. */\n\
         /*\n\
          * Guest self-marshalling descriptor table (Phase 2 opaque transport).\n\
          *\n\
          * Projects `wasm_posix_shared::host_abi::SYSCALL_ARG_DESCRIPTORS` plus\n\
          * the nested iovec/msghdr syscalls into a compact runtime table the\n\
          * musl glue encoder (`__marshal_channel_record`) consumes to build an\n\
          * opaque `channel_record` at DATA_OFFSET. Additive: not on the live\n\
          * syscall path yet, and does NOT participate in the ABI snapshot.\n\
          */\n\
         #ifndef KANDELO_SYSCALL_MARSHAL_H\n\
         #define KANDELO_SYSCALL_MARSHAL_H\n\
         \n\
         #include <stdint.h>\n\
         \n",
    );
    out.push_str(&format!(
        "/* Record wire layout, sourced from wasm_posix_shared::channel_record\n\
          * and ::channel so the encoder never hardcodes offsets. */\n\
         #define KANDELO_RECORD_MAGIC 0x{magic:08X}u\n\
         #define KANDELO_RECORD_ABI {record_abi}u\n\
         #define KANDELO_RECORD_HEADER_BYTES {header_bytes}u\n\
         #define KANDELO_RECORD_SPAN_DESCRIPTOR_BYTES {span_desc_bytes}u\n\
         #define KANDELO_RECORD_MAX_SPANS {max_spans}u\n\
         #define KANDELO_RECORD_MAX_IOVEC {max_iovec}u\n\
         #define KANDELO_RECORD_INLINE_BUDGET {inline_budget}u\n\
         /* RecordHeader field byte offsets. */\n\
         #define KANDELO_RECORD_H_MAGIC {h_magic}u\n\
         #define KANDELO_RECORD_H_RECORD_ABI {h_abi}u\n\
         #define KANDELO_RECORD_H_SYSCALL {h_syscall}u\n\
         #define KANDELO_RECORD_H_SPAN_COUNT {h_span_count}u\n\
         #define KANDELO_RECORD_H_FLAGS {h_flags}u\n\
         #define KANDELO_RECORD_H_RECORD_LEN {h_record_len}u\n\
         #define KANDELO_RECORD_H_SCALARS {h_scalars}u\n\
         /* SpanDescriptor field byte offsets. */\n\
         #define KANDELO_RECORD_D_KIND {d_kind}u\n\
         #define KANDELO_RECORD_D_ARG_INDEX {d_arg_index}u\n\
         #define KANDELO_RECORD_D_OFFSET {d_offset}u\n\
         #define KANDELO_RECORD_D_LEN {d_len}u\n\
         /* Nested iovec-array region field offsets. */\n\
         #define KANDELO_RECORD_IOVEC_COUNT_OFFSET {iov_count_off}u\n\
         #define KANDELO_RECORD_IOVEC_ENTRIES_OFFSET {iov_entries_off}u\n\
         #define KANDELO_RECORD_IOVEC_ENTRY_BYTES {iov_entry_bytes}u\n\
         /* Nested msghdr region field offsets (fixed prefix). */\n\
         #define KANDELO_RECORD_MSGHDR_NAME_OFF_OFFSET {msg_name_off}u\n\
         #define KANDELO_RECORD_MSGHDR_NAME_LEN_OFFSET {msg_name_len}u\n\
         #define KANDELO_RECORD_MSGHDR_IOVEC_BLOCK_OFFSET {msg_block_off}u\n\
         \n\
         /* Flat-span record kinds (mirror channel_record::SPAN_KIND_*). */\n\
         #define KANDELO_MARSHAL_SPAN_IN_PTR {span_in}u\n\
         #define KANDELO_MARSHAL_SPAN_OUT_PTR {span_out}u\n\
         #define KANDELO_MARSHAL_SPAN_IN_OUT_PTR {span_inout}u\n\
         #define KANDELO_MARSHAL_SPAN_PATH_STR {span_path}u\n\
         #define KANDELO_MARSHAL_SPAN_IOVEC_ARRAY {span_iovec}u\n\
         #define KANDELO_MARSHAL_SPAN_MSGHDR {span_msghdr}u\n\
         \n",
        magic = record::RECORD_MAGIC,
        record_abi = record::RECORD_ABI,
        header_bytes = record::RECORD_HEADER_BYTES,
        span_desc_bytes = record::SPAN_DESCRIPTOR_BYTES,
        max_spans = record::MAX_SPANS,
        max_iovec = record::MAX_IOVEC,
        inline_budget = record::RECORD_INLINE_BUDGET,
        h_magic = offset_of!(record::RecordHeader, magic),
        h_abi = offset_of!(record::RecordHeader, record_abi),
        h_syscall = offset_of!(record::RecordHeader, syscall),
        h_span_count = offset_of!(record::RecordHeader, span_count),
        h_flags = offset_of!(record::RecordHeader, flags),
        h_record_len = record::RECORD_LEN_OFFSET,
        h_scalars = offset_of!(record::RecordHeader, scalar_args),
        d_kind = offset_of!(record::SpanDescriptor, kind),
        d_arg_index = offset_of!(record::SpanDescriptor, arg_index),
        d_offset = offset_of!(record::SpanDescriptor, offset),
        d_len = offset_of!(record::SpanDescriptor, len),
        iov_count_off = record::IOVEC_ARRAY_COUNT_OFFSET,
        iov_entries_off = record::IOVEC_ARRAY_ENTRIES_OFFSET,
        iov_entry_bytes = record::IOVEC_ARRAY_ENTRY_BYTES,
        msg_name_off = record::MSGHDR_NAME_OFF_OFFSET,
        msg_name_len = record::MSGHDR_NAME_LEN_OFFSET,
        msg_block_off = record::MSGHDR_IOVEC_BLOCK_OFFSET,
        span_in = SPAN_IN,
        span_out = SPAN_OUT,
        span_inout = SPAN_INOUT,
        span_path = SPAN_PATH,
        span_iovec = SPAN_IOVEC,
        span_msghdr = SPAN_MSGHDR,
    ));
    out.push_str(
        "/* Size rules (mirror host_abi::SyscallArgSize variant order). */\n\
         #define KANDELO_MARSHAL_SIZE_CSTRING 0u\n\
         #define KANDELO_MARSHAL_SIZE_ARG 1u\n\
         #define KANDELO_MARSHAL_SIZE_DEREF 2u\n\
         #define KANDELO_MARSHAL_SIZE_FIXED 3u\n\
         #define KANDELO_MARSHAL_SIZE_LAYOUT 4u\n\
         \n\
         /* Whole-syscall nested marshalling shapes. */\n\
         #define KANDELO_MARSHAL_NESTED_NONE 0u\n\
         #define KANDELO_MARSHAL_NESTED_IOVEC 1u\n\
         #define KANDELO_MARSHAL_NESTED_MSGHDR 2u\n\
         \n\
         /* One pointer argument to marshal.\n\
          *   arg_index : which of the six syscall words holds the pointer.\n\
          *   span_kind : KANDELO_MARSHAL_SPAN_* emitted for this arg.\n\
          *   size_kind : KANDELO_MARSHAL_SIZE_* selecting how `len` is computed.\n\
          *   nullable  : 1 => a null pointer omits the span entirely.\n\
          *   a,b,c     : size-rule operands, by size_kind:\n\
          *     CSTRING -> a = max_bytes (scan ceiling incl. NUL)\n\
          *     ARG     -> a = length arg index, b = multiplier, c = add\n\
          *     DEREF   -> a = arg index holding a u32* length\n\
          *     FIXED   -> a = byte length\n\
          *     LAYOUT  -> a = wasm32 size, b = wasm64 size\n\
          *   For a nested syscall the single entry carries, for IOVEC,\n\
          *   a = the iovcnt arg index; MSGHDR uses arg_index only.\n\
          */\n\
         struct kandelo_marshal_arg {\n\
         \x20   uint8_t arg_index;\n\
         \x20   uint8_t span_kind;\n\
         \x20   uint8_t size_kind;\n\
         \x20   uint8_t nullable;\n\
         \x20   uint32_t a;\n\
         \x20   uint32_t b;\n\
         \x20   uint32_t c;\n\
         };\n\
         \n\
         struct kandelo_marshal_syscall {\n\
         \x20   uint32_t syscall_number;\n\
         \x20   uint8_t nested; /* KANDELO_MARSHAL_NESTED_* */\n\
         \x20   uint8_t arg_count;\n\
         \x20   const struct kandelo_marshal_arg *args;\n\
         };\n\
         \n",
    );

    // Ioctl request -> (arg representation, direction, buffer size) contract,
    // projected from wasm_posix_shared::ioctl_contract. Ioctl is NOT in the flat
    // descriptor table because its arg-2 buffer size is selected by the request
    // number, and legacy request encodings (e.g. TIOCGWINSZ = 0x5413) do not
    // embed their size, so `_IOC_SIZE` is insufficient. The guest sizes the
    // buffer from this table. Additive: like the rest of this header it is not
    // on the live syscall path and does NOT participate in the ABI snapshot.
    // A wasm32/wasm64 size of KANDELO_IOCTL_SIZE_UNSUPPORTED means the request
    // is known but unsupported for that caller data model (`Option::None`),
    // intentionally distinct from a zero-length buffer.
    {
        use shared::ioctl_contract::{IoctlArgKind, IoctlDirection, IOCTL_REQUEST_CONTRACTS};
        const IOCTL_SIZE_UNSUPPORTED: u32 = 0xFFFF_FFFF;
        fn ioctl_arg_kind(kind: IoctlArgKind) -> u8 {
            match kind {
                IoctlArgKind::None => 0,
                IoctlArgKind::ScalarI32 => 1,
                IoctlArgKind::Pointer => 2,
            }
        }
        fn ioctl_direction(dir: IoctlDirection) -> u8 {
            match dir {
                IoctlDirection::None => 0,
                IoctlDirection::In => 1,
                IoctlDirection::Out => 2,
                IoctlDirection::InOut => 3,
            }
        }
        out.push_str(
            "/* Ioctl arg representation and copy direction (mirror\n\
             * wasm_posix_shared::ioctl_contract::{IoctlArgKind, IoctlDirection}). */\n\
             #define KANDELO_IOCTL_ARG_NONE 0u\n\
             #define KANDELO_IOCTL_ARG_SCALAR_I32 1u\n\
             #define KANDELO_IOCTL_ARG_POINTER 2u\n\
             #define KANDELO_IOCTL_DIR_NONE 0u\n\
             #define KANDELO_IOCTL_DIR_IN 1u\n\
             #define KANDELO_IOCTL_DIR_OUT 2u\n\
             #define KANDELO_IOCTL_DIR_INOUT 3u\n\
             /* Known request unsupported for this caller data model (None). */\n\
             #define KANDELO_IOCTL_SIZE_UNSUPPORTED 0xFFFFFFFFu\n\
             \n\
             struct kandelo_ioctl_contract {\n\
             \x20   uint32_t request;\n\
             \x20   uint8_t arg_kind;   /* KANDELO_IOCTL_ARG_* */\n\
             \x20   uint8_t direction;  /* KANDELO_IOCTL_DIR_* */\n\
             \x20   uint32_t wasm32_size;\n\
             \x20   uint32_t wasm64_size;\n\
             };\n\
             \n\
             static const struct kandelo_ioctl_contract kandelo_ioctl_contracts[] = {\n",
        );
        for contract in IOCTL_REQUEST_CONTRACTS {
            out.push_str(&format!(
                "    {{ 0x{request:08X}u, {arg}u, {dir}u, {w32}u, {w64}u }},\n",
                request = contract.request,
                arg = ioctl_arg_kind(contract.arg_kind),
                dir = ioctl_direction(contract.direction),
                w32 = contract.wasm32_size.unwrap_or(IOCTL_SIZE_UNSUPPORTED),
                w64 = contract.wasm64_size.unwrap_or(IOCTL_SIZE_UNSUPPORTED),
            ));
        }
        out.push_str("};\n\n");
        out.push_str(&format!(
            "#define KANDELO_IOCTL_CONTRACT_COUNT {}u\n\n",
            IOCTL_REQUEST_CONTRACTS.len()
        ));
    }

    for entry in &entries {
        out.push_str(&format!(
            "static const struct kandelo_marshal_arg kandelo_marshal_args_{}[] = {{\n",
            entry.number
        ));
        for (arg_index, span_kind, size_kind, nullable, a, b, c) in &entry.args {
            out.push_str(&format!(
                "    {{ {arg_index}u, {span_kind}u, {size_kind}u, {nullable}u, {a}u, {b}u, {c}u }},\n",
            ));
        }
        out.push_str("};\n\n");
    }

    out.push_str("static const struct kandelo_marshal_syscall kandelo_marshal_table[] = {\n");
    for entry in &entries {
        out.push_str(&format!(
            "    {{ {number}u, {nested}u, {count}u, kandelo_marshal_args_{number} }},\n",
            number = entry.number,
            nested = entry.nested,
            count = entry.args.len(),
        ));
    }
    out.push_str("};\n\n");
    out.push_str(&format!(
        "#define KANDELO_MARSHAL_SYSCALL_COUNT {}u\n\n",
        entries.len()
    ));

    // Phase 2 (Option A) RAW syscall set, projected from
    // wasm_posix_shared::host_raw_syscalls. A RAW syscall keeps its raw i64 args
    // in the channel and is NEVER marshalled into a record: the guest glue skips
    // the encoder for it, and the host asserts a RAW syscall never carries a
    // record magic. Sorted ascending so the guest can binary/linear scan.
    {
        use shared::host_raw_syscalls::host_raw_syscalls_sorted;
        let (sorted, len) = host_raw_syscalls_sorted();
        out.push_str(
            "/* Phase 2 RAW syscalls: keep raw args, never build a record.\n\
             * Source of truth: wasm_posix_shared::host_raw_syscalls. Sorted\n\
             * ascending. Additive to this header; the host guard (abi.ts\n\
             * HOST_RAW_SYSCALLS) is the cross-checked mirror. */\n\
             static const uint32_t kandelo_raw_syscalls[] = {\n",
        );
        for &n in &sorted[..len] {
            out.push_str(&format!("    {n}u,\n"));
        }
        out.push_str("};\n\n");
        out.push_str(&format!(
            "#define KANDELO_RAW_SYSCALL_COUNT {len}u\n\n",
        ));
    }

    out.push_str("#endif /* KANDELO_SYSCALL_MARSHAL_H */\n");
    out
}

fn render_process_layouts_header() -> String {
    use shared::process_layout::{
        cmsghdr, iovec, msghdr, multicast_group_request, rt_sigqueueinfo, sigevent,
    };

    format!(
        "/* GENERATED by `cargo xtask dump-abi`. Do not edit by hand. */\n\
         /* Regenerated by scripts/check-abi-version.sh; drift is a CI failure. */\n\
         #ifndef KANDELO_PROCESS_LAYOUTS_H\n\
         #define KANDELO_PROCESS_LAYOUTS_H\n\
         \n\
         #define KANDELO_PROCESS_IOVEC_WASM32_SIZE {iov32_size}u\n\
         #define KANDELO_PROCESS_IOVEC_WASM32_BASE_OFFSET {iov32_base}u\n\
         #define KANDELO_PROCESS_IOVEC_WASM32_LEN_OFFSET {iov32_len}u\n\
         #define KANDELO_PROCESS_IOVEC_WASM64_SIZE {iov64_size}u\n\
         #define KANDELO_PROCESS_IOVEC_WASM64_BASE_OFFSET {iov64_base}u\n\
         #define KANDELO_PROCESS_IOVEC_WASM64_LEN_OFFSET {iov64_len}u\n\
         \n\
         #define KANDELO_PROCESS_MSGHDR_WASM32_SIZE {msg32_size}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM32_NAME_OFFSET {msg32_name}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM32_NAMELEN_OFFSET {msg32_namelen}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM32_IOV_OFFSET {msg32_iov}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM32_IOVLEN_OFFSET {msg32_iovlen}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM32_CONTROL_OFFSET {msg32_control}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM32_CONTROLLEN_OFFSET {msg32_controllen}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM32_FLAGS_OFFSET {msg32_flags}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM64_SIZE {msg64_size}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM64_NAME_OFFSET {msg64_name}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM64_NAMELEN_OFFSET {msg64_namelen}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM64_IOV_OFFSET {msg64_iov}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM64_IOVLEN_OFFSET {msg64_iovlen}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM64_CONTROL_OFFSET {msg64_control}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET {msg64_controllen}u\n\
         #define KANDELO_PROCESS_MSGHDR_WASM64_FLAGS_OFFSET {msg64_flags}u\n\
         \n\
         #define KANDELO_PROCESS_CMSGHDR_WASM32_SIZE {cmsg32_size}u\n\
         #define KANDELO_PROCESS_CMSGHDR_WASM32_ALIGN {cmsg32_align}u\n\
         #define KANDELO_PROCESS_CMSGHDR_WASM32_LEN_OFFSET {cmsg32_len}u\n\
         #define KANDELO_PROCESS_CMSGHDR_WASM32_LEVEL_OFFSET {cmsg32_level}u\n\
         #define KANDELO_PROCESS_CMSGHDR_WASM32_TYPE_OFFSET {cmsg32_type}u\n\
         #define KANDELO_PROCESS_CMSGHDR_WASM32_DATA_OFFSET {cmsg32_data}u\n\
         #define KANDELO_PROCESS_CMSGHDR_WASM64_SIZE {cmsg64_size}u\n\
         #define KANDELO_PROCESS_CMSGHDR_WASM64_ALIGN {cmsg64_align}u\n\
         #define KANDELO_PROCESS_CMSGHDR_WASM64_LEN_OFFSET {cmsg64_len}u\n\
         #define KANDELO_PROCESS_CMSGHDR_WASM64_LEVEL_OFFSET {cmsg64_level}u\n\
         #define KANDELO_PROCESS_CMSGHDR_WASM64_TYPE_OFFSET {cmsg64_type}u\n\
         #define KANDELO_PROCESS_CMSGHDR_WASM64_DATA_OFFSET {cmsg64_data}u\n\
         \n\
         #define KANDELO_PROCESS_GROUP_REQ_WASM32_SIZE {group_req32_size}u\n\
         #define KANDELO_PROCESS_GROUP_REQ_WASM32_GROUP_OFFSET {group32_offset}u\n\
         #define KANDELO_PROCESS_GROUP_SOURCE_REQ_WASM32_SIZE {group_source_req32_size}u\n\
         #define KANDELO_PROCESS_GROUP_SOURCE_REQ_WASM32_SOURCE_OFFSET {source32_offset}u\n\
         #define KANDELO_PROCESS_GROUP_REQ_WASM64_SIZE {group_req64_size}u\n\
         #define KANDELO_PROCESS_GROUP_REQ_WASM64_GROUP_OFFSET {group64_offset}u\n\
         #define KANDELO_PROCESS_GROUP_SOURCE_REQ_WASM64_SIZE {group_source_req64_size}u\n\
         #define KANDELO_PROCESS_GROUP_SOURCE_REQ_WASM64_SOURCE_OFFSET {source64_offset}u\n\
         \n\
         #define KANDELO_PROCESS_SIGINFO_SIGNO_OFFSET {siginfo_signo}u\n\
         #define KANDELO_PROCESS_SIGINFO_ERRNO_OFFSET {siginfo_errno}u\n\
         #define KANDELO_PROCESS_SIGINFO_CODE_OFFSET {siginfo_code}u\n\
         #define KANDELO_PROCESS_SIGINFO_WASM32_SIZE {siginfo32_size}u\n\
         #define KANDELO_PROCESS_SIGINFO_WASM32_PID_OFFSET {siginfo32_pid}u\n\
         #define KANDELO_PROCESS_SIGINFO_WASM32_UID_OFFSET {siginfo32_uid}u\n\
         #define KANDELO_PROCESS_SIGINFO_WASM32_VALUE_OFFSET {siginfo32_value}u\n\
         #define KANDELO_PROCESS_SIGINFO_WASM32_VALUE_SIZE {siginfo32_value_size}u\n\
         #define KANDELO_PROCESS_SIGINFO_WASM64_SIZE {siginfo64_size}u\n\
         #define KANDELO_PROCESS_SIGINFO_WASM64_PID_OFFSET {siginfo64_pid}u\n\
         #define KANDELO_PROCESS_SIGINFO_WASM64_UID_OFFSET {siginfo64_uid}u\n\
         #define KANDELO_PROCESS_SIGINFO_WASM64_VALUE_OFFSET {siginfo64_value}u\n\
         #define KANDELO_PROCESS_SIGINFO_WASM64_VALUE_SIZE {siginfo64_value_size}u\n\
         \n\
         #define KANDELO_PROCESS_SIGEVENT_WASM32_SIZE {sigevent32_size}u\n\
         #define KANDELO_PROCESS_SIGEVENT_WASM32_VALUE_OFFSET {sigevent32_value}u\n\
         #define KANDELO_PROCESS_SIGEVENT_WASM32_VALUE_SIZE {sigevent32_value_size}u\n\
         #define KANDELO_PROCESS_SIGEVENT_WASM32_SIGNO_OFFSET {sigevent32_signo}u\n\
         #define KANDELO_PROCESS_SIGEVENT_WASM32_NOTIFY_OFFSET {sigevent32_notify}u\n\
         #define KANDELO_PROCESS_SIGEVENT_WASM32_PAYLOAD_OFFSET {sigevent32_payload}u\n\
         #define KANDELO_PROCESS_SIGEVENT_WASM64_SIZE {sigevent64_size}u\n\
         #define KANDELO_PROCESS_SIGEVENT_WASM64_VALUE_OFFSET {sigevent64_value}u\n\
         #define KANDELO_PROCESS_SIGEVENT_WASM64_VALUE_SIZE {sigevent64_value_size}u\n\
         #define KANDELO_PROCESS_SIGEVENT_WASM64_SIGNO_OFFSET {sigevent64_signo}u\n\
         #define KANDELO_PROCESS_SIGEVENT_WASM64_NOTIFY_OFFSET {sigevent64_notify}u\n\
         #define KANDELO_PROCESS_SIGEVENT_WASM64_PAYLOAD_OFFSET {sigevent64_payload}u\n\
         \n\
         #define KANDELO_SOCKET_SOL_SOCKET {sol_socket}u\n\
         #define KANDELO_SOCKET_SCM_RIGHTS {scm_rights}u\n\
         #define KANDELO_SOCKET_MSG_TRUNC {msg_trunc}u\n\
         #define KANDELO_SCM_RIGHTS_FD_BYTES {scm_rights_fd_bytes}u\n\
         #define KANDELO_SOCKADDR_STORAGE_BYTES {sockaddr_storage_bytes}u\n\
         #define KANDELO_SOCKADDR_UNIX_BYTES {sockaddr_unix_bytes}u\n\
         #define KANDELO_SOCKADDR_UNIX_PATH_OFFSET_BYTES {sockaddr_unix_path_offset_bytes}u\n\
         #define KANDELO_SOCKADDR_UNIX_PATH_BYTES {sockaddr_unix_path_bytes}u\n\
         \n\
         #define KANDELO_KERNEL_POLLFD_SIZE {pollfd_size}u\n\
         #define KANDELO_KERNEL_POLLFD_FD_OFFSET {pollfd_fd}u\n\
         #define KANDELO_KERNEL_POLLFD_EVENTS_OFFSET {pollfd_events}u\n\
         #define KANDELO_KERNEL_POLLFD_REVENTS_OFFSET {pollfd_revents}u\n\
         \n\
         #define KANDELO_SELECT_FD_SETSIZE {fd_setsize}u\n\
         #define KANDELO_SELECT_FD_SET_BYTES {fd_set_bytes}u\n\
         \n\
         #endif /* KANDELO_PROCESS_LAYOUTS_H */\n",
        iov32_size = iovec::WASM32_SIZE,
        iov32_base = iovec::WASM32_BASE_OFFSET,
        iov32_len = iovec::WASM32_LEN_OFFSET,
        iov64_size = iovec::WASM64_SIZE,
        iov64_base = iovec::WASM64_BASE_OFFSET,
        iov64_len = iovec::WASM64_LEN_OFFSET,
        msg32_size = msghdr::WASM32_SIZE,
        msg32_name = msghdr::WASM32_NAME_OFFSET,
        msg32_namelen = msghdr::WASM32_NAMELEN_OFFSET,
        msg32_iov = msghdr::WASM32_IOV_OFFSET,
        msg32_iovlen = msghdr::WASM32_IOVLEN_OFFSET,
        msg32_control = msghdr::WASM32_CONTROL_OFFSET,
        msg32_controllen = msghdr::WASM32_CONTROLLEN_OFFSET,
        msg32_flags = msghdr::WASM32_FLAGS_OFFSET,
        msg64_size = msghdr::WASM64_SIZE,
        msg64_name = msghdr::WASM64_NAME_OFFSET,
        msg64_namelen = msghdr::WASM64_NAMELEN_OFFSET,
        msg64_iov = msghdr::WASM64_IOV_OFFSET,
        msg64_iovlen = msghdr::WASM64_IOVLEN_OFFSET,
        msg64_control = msghdr::WASM64_CONTROL_OFFSET,
        msg64_controllen = msghdr::WASM64_CONTROLLEN_OFFSET,
        msg64_flags = msghdr::WASM64_FLAGS_OFFSET,
        cmsg32_size = cmsghdr::WASM32_SIZE,
        cmsg32_align = cmsghdr::WASM32_ALIGN,
        cmsg32_len = cmsghdr::WASM32_LEN_OFFSET,
        cmsg32_level = cmsghdr::WASM32_LEVEL_OFFSET,
        cmsg32_type = cmsghdr::WASM32_TYPE_OFFSET,
        cmsg32_data = cmsghdr::WASM32_DATA_OFFSET,
        cmsg64_size = cmsghdr::WASM64_SIZE,
        cmsg64_align = cmsghdr::WASM64_ALIGN,
        cmsg64_len = cmsghdr::WASM64_LEN_OFFSET,
        cmsg64_level = cmsghdr::WASM64_LEVEL_OFFSET,
        cmsg64_type = cmsghdr::WASM64_TYPE_OFFSET,
        cmsg64_data = cmsghdr::WASM64_DATA_OFFSET,
        group_req32_size = multicast_group_request::WASM32_GROUP_REQ_SIZE,
        group32_offset = multicast_group_request::WASM32_GROUP_OFFSET,
        group_source_req32_size =
            multicast_group_request::WASM32_GROUP_SOURCE_REQ_SIZE,
        source32_offset = multicast_group_request::WASM32_SOURCE_OFFSET,
        group_req64_size = multicast_group_request::WASM64_GROUP_REQ_SIZE,
        group64_offset = multicast_group_request::WASM64_GROUP_OFFSET,
        group_source_req64_size =
            multicast_group_request::WASM64_GROUP_SOURCE_REQ_SIZE,
        source64_offset = multicast_group_request::WASM64_SOURCE_OFFSET,
        siginfo_signo = rt_sigqueueinfo::SIGNO_OFFSET,
        siginfo_errno = rt_sigqueueinfo::ERRNO_OFFSET,
        siginfo_code = rt_sigqueueinfo::CODE_OFFSET,
        siginfo32_size = rt_sigqueueinfo::WASM32_SIZE,
        siginfo32_pid = rt_sigqueueinfo::WASM32_PID_OFFSET,
        siginfo32_uid = rt_sigqueueinfo::WASM32_UID_OFFSET,
        siginfo32_value = rt_sigqueueinfo::WASM32_VALUE_OFFSET,
        siginfo32_value_size = rt_sigqueueinfo::WASM32_VALUE_SIZE,
        siginfo64_size = rt_sigqueueinfo::WASM64_SIZE,
        siginfo64_pid = rt_sigqueueinfo::WASM64_PID_OFFSET,
        siginfo64_uid = rt_sigqueueinfo::WASM64_UID_OFFSET,
        siginfo64_value = rt_sigqueueinfo::WASM64_VALUE_OFFSET,
        siginfo64_value_size = rt_sigqueueinfo::WASM64_VALUE_SIZE,
        sigevent32_size = sigevent::WASM32_SIZE,
        sigevent32_value = sigevent::WASM32_VALUE_OFFSET,
        sigevent32_value_size = sigevent::WASM32_VALUE_SIZE,
        sigevent32_signo = sigevent::WASM32_SIGNO_OFFSET,
        sigevent32_notify = sigevent::WASM32_NOTIFY_OFFSET,
        sigevent32_payload = sigevent::WASM32_PAYLOAD_OFFSET,
        sigevent64_size = sigevent::WASM64_SIZE,
        sigevent64_value = sigevent::WASM64_VALUE_OFFSET,
        sigevent64_value_size = sigevent::WASM64_VALUE_SIZE,
        sigevent64_signo = sigevent::WASM64_SIGNO_OFFSET,
        sigevent64_notify = sigevent::WASM64_NOTIFY_OFFSET,
        sigevent64_payload = sigevent::WASM64_PAYLOAD_OFFSET,
        sol_socket = shared::socket::SOL_SOCKET,
        scm_rights = shared::socket::SCM_RIGHTS,
        msg_trunc = shared::socket::MSG_TRUNC,
        scm_rights_fd_bytes = shared::socket::SCM_RIGHTS_FD_BYTES,
        sockaddr_storage_bytes = shared::kernel_scratch_wire::SOCKADDR_STORAGE_BYTES,
        sockaddr_unix_bytes = shared::kernel_scratch_wire::SOCKADDR_UNIX_BYTES,
        sockaddr_unix_path_offset_bytes =
            shared::kernel_scratch_wire::SOCKADDR_UNIX_PATH_OFFSET_BYTES,
        sockaddr_unix_path_bytes = shared::kernel_scratch_wire::SOCKADDR_UNIX_PATH_BYTES,
        pollfd_size = size_of::<shared::WasmPollFd>(),
        pollfd_fd = offset_of!(shared::WasmPollFd, fd),
        pollfd_events = offset_of!(shared::WasmPollFd, events),
        pollfd_revents = offset_of!(shared::WasmPollFd, revents),
        fd_setsize = shared::select::FD_SETSIZE,
        fd_set_bytes = shared::select::FD_SET_BYTES,
    )
}

fn render_spawn_contract_header() -> String {
    use shared::spawn_contract;

    format!(
        "/* GENERATED by `cargo xtask dump-abi`. Do not edit by hand. */\n\
         /* Regenerated by scripts/check-abi-version.sh; drift is a CI failure. */\n\
         #ifndef WASM_POSIX_SPAWN_CONTRACT_H\n\
         #define WASM_POSIX_SPAWN_CONTRACT_H\n\
         \n\
         #include <bits/kandelo_limits.h>\n\
         \n\
         #define WASM_POSIX_ARG_MAX_BYTES KANDELO_POSIX_ARG_MAX_BYTES\n\
         #define WASM_POSIX_PATH_MAX_BYTES KANDELO_POSIX_PATH_MAX_BYTES\n\
         #define WASM_POSIX_SYS_SPAWN {sys_spawn}u\n\
         #define WASM_POSIX_SPAWN_HEADER_BYTES {header_bytes}u\n\
         #define WASM_POSIX_SPAWN_STRING_OFFSET_BYTES {string_offset_bytes}u\n\
         #define WASM_POSIX_SPAWN_HEADER_ARGC_OFFSET {header_argc_offset}u\n\
         #define WASM_POSIX_SPAWN_HEADER_ENVC_OFFSET {header_envc_offset}u\n\
         #define WASM_POSIX_SPAWN_HEADER_ACTION_COUNT_OFFSET {header_action_count_offset}u\n\
         #define WASM_POSIX_SPAWN_HEADER_ATTR_FLAGS_OFFSET {header_attr_flags_offset}u\n\
         #define WASM_POSIX_SPAWN_HEADER_PGRP_OFFSET {header_pgrp_offset}u\n\
         #define WASM_POSIX_SPAWN_HEADER_PAD_OFFSET {header_pad_offset}u\n\
         #define WASM_POSIX_SPAWN_HEADER_SIGDEF_OFFSET {header_sigdef_offset}u\n\
         #define WASM_POSIX_SPAWN_HEADER_SIGMASK_OFFSET {header_sigmask_offset}u\n\
         #define WASM_POSIX_SPAWN_ACTION_RECORD_BYTES {action_bytes}u\n\
         #define WASM_POSIX_SPAWN_ACTION_OP_OFFSET {action_op_offset}u\n\
         #define WASM_POSIX_SPAWN_ACTION_FD_OFFSET {action_fd_offset}u\n\
         #define WASM_POSIX_SPAWN_ACTION_NEWFD_OFFSET {action_newfd_offset}u\n\
         #define WASM_POSIX_SPAWN_ACTION_PATH_OFF_OFFSET {action_path_off_offset}u\n\
         #define WASM_POSIX_SPAWN_ACTION_PATH_LEN_OFFSET {action_path_len_offset}u\n\
         #define WASM_POSIX_SPAWN_ACTION_OFLAG_OFFSET {action_oflag_offset}u\n\
         #define WASM_POSIX_SPAWN_ACTION_MODE_OFFSET {action_mode_offset}u\n\
         #define WASM_POSIX_SPAWN_OP_OPEN {op_open}u\n\
         #define WASM_POSIX_SPAWN_OP_CLOSE {op_close}u\n\
         #define WASM_POSIX_SPAWN_OP_DUP2 {op_dup2}u\n\
         #define WASM_POSIX_SPAWN_OP_CHDIR {op_chdir}u\n\
         #define WASM_POSIX_SPAWN_OP_FCHDIR {op_fchdir}u\n\
         #define WASM_POSIX_SPAWN_ATTR_RESETIDS {attr_resetids}u\n\
         #define WASM_POSIX_SPAWN_ATTR_SETPGROUP {attr_setpgroup}u\n\
         #define WASM_POSIX_SPAWN_ATTR_SETSIGDEF {attr_setsigdef}u\n\
         #define WASM_POSIX_SPAWN_ATTR_SETSIGMASK {attr_setsigmask}u\n\
         #define WASM_POSIX_SPAWN_ATTR_SETSCHEDPARAM {attr_setschedparam}u\n\
         #define WASM_POSIX_SPAWN_ATTR_SETSCHEDULER {attr_setscheduler}u\n\
         #define WASM_POSIX_SPAWN_ATTR_USEVFORK {attr_usevfork}u\n\
         #define WASM_POSIX_SPAWN_ATTR_SETSID {attr_setsid}u\n\
         #define WASM_POSIX_SPAWN_MAX_ARGV_COUNT {max_argv}u\n\
         #define WASM_POSIX_SPAWN_MAX_ENVP_COUNT {max_envp}u\n\
         #define WASM_POSIX_SPAWN_MAX_ACTION_COUNT {max_actions}u\n\
         #define WASM_POSIX_SPAWN_WIRE_MAX_BYTES {wire_max}u\n\
         \n\
         #endif /* WASM_POSIX_SPAWN_CONTRACT_H */\n",
        sys_spawn = shared::abi::host_intercepted::SYS_SPAWN,
        header_bytes = spawn_contract::WIRE_HEADER_BYTES,
        string_offset_bytes = spawn_contract::WIRE_STRING_OFFSET_BYTES,
        header_argc_offset = spawn_contract::WIRE_HEADER_ARGC_OFFSET,
        header_envc_offset = spawn_contract::WIRE_HEADER_ENVC_OFFSET,
        header_action_count_offset = spawn_contract::WIRE_HEADER_ACTION_COUNT_OFFSET,
        header_attr_flags_offset = spawn_contract::WIRE_HEADER_ATTR_FLAGS_OFFSET,
        header_pgrp_offset = spawn_contract::WIRE_HEADER_PGRP_OFFSET,
        header_pad_offset = spawn_contract::WIRE_HEADER_PAD_OFFSET,
        header_sigdef_offset = spawn_contract::WIRE_HEADER_SIGDEF_OFFSET,
        header_sigmask_offset = spawn_contract::WIRE_HEADER_SIGMASK_OFFSET,
        action_bytes = spawn_contract::WIRE_ACTION_RECORD_BYTES,
        action_op_offset = spawn_contract::WIRE_ACTION_OP_OFFSET,
        action_fd_offset = spawn_contract::WIRE_ACTION_FD_OFFSET,
        action_newfd_offset = spawn_contract::WIRE_ACTION_NEWFD_OFFSET,
        action_path_off_offset = spawn_contract::WIRE_ACTION_PATH_OFF_OFFSET,
        action_path_len_offset = spawn_contract::WIRE_ACTION_PATH_LEN_OFFSET,
        action_oflag_offset = spawn_contract::WIRE_ACTION_OFLAG_OFFSET,
        action_mode_offset = spawn_contract::WIRE_ACTION_MODE_OFFSET,
        op_open = spawn_contract::WIRE_OP_OPEN,
        op_close = spawn_contract::WIRE_OP_CLOSE,
        op_dup2 = spawn_contract::WIRE_OP_DUP2,
        op_chdir = spawn_contract::WIRE_OP_CHDIR,
        op_fchdir = spawn_contract::WIRE_OP_FCHDIR,
        attr_resetids = spawn_contract::ATTR_RESETIDS,
        attr_setpgroup = spawn_contract::ATTR_SETPGROUP,
        attr_setsigdef = spawn_contract::ATTR_SETSIGDEF,
        attr_setsigmask = spawn_contract::ATTR_SETSIGMASK,
        attr_setschedparam = spawn_contract::ATTR_SETSCHEDPARAM,
        attr_setscheduler = spawn_contract::ATTR_SETSCHEDULER,
        attr_usevfork = spawn_contract::ATTR_USEVFORK,
        attr_setsid = spawn_contract::ATTR_SETSID,
        max_argv = spawn_contract::MAX_ARGV_COUNT,
        max_envp = spawn_contract::MAX_ENVP_COUNT,
        max_actions = spawn_contract::MAX_ACTION_COUNT,
        wire_max = spawn_contract::WIRE_MAX_BYTES,
    )
}

fn check_file(path: &std::path::Path, expected: &str, label: &str) -> Result<(), String> {
    let existing =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if existing != expected {
        eprintln!(
            "{label} at {} is out of date.\n\
             Run `bash scripts/check-abi-version.sh update` to regenerate,\n\
             and bump `ABI_VERSION` in crates/program-abi/src/lib.rs if the\n\
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
        compat_verdict(&old, &new, &report)?;
        println!("abi: breaking changes are covered by the version bump.");
        Ok(())
    }
}

/// C header consumed by `libc/glue/channel_syscall.c` and any other C code
/// that needs to agree with Rust on ABI-surface constants.
fn render_c_header() -> String {
    let mut out = format!(
        "/* GENERATED by `cargo xtask dump-abi`. Do not edit by hand. */\n\
         /* Regenerated by scripts/check-abi-version.sh; drift is a CI failure. */\n\
         #ifndef WASM_POSIX_ABI_CONSTANTS_H\n\
         #define WASM_POSIX_ABI_CONSTANTS_H\n\
         \n\
         #include <stdint.h>\n\
         \n\
         /* Mirrors wasm_posix_shared::ABI_VERSION. */\n\
         #define WASM_POSIX_ABI_VERSION {version}u\n\
         \n\
         /* Non-forking spawn syscall number. */\n\
         #define WASM_POSIX_SYS_SPAWN {sys_spawn}u\n\
         \n\
         /* Process-fork import mode selectors. */\n\
         #define WASM_POSIX_FORK_MODE_FORK {fork_mode_fork}u\n\
         #define WASM_POSIX_FORK_MODE_VFORK {fork_mode_vfork}u\n\
         \n\
         /* Default process-wasm pthread slot declaration. */\n\
         #define WASM_POSIX_THREAD_SLOT_DECL_DEFAULT {thread_slots_default}\n\
         \n\
         /* Fixed kernel/musl resource-usage wire record size. */\n\
         #define WASM_POSIX_RUSAGE_WIRE_SIZE {rusage_wire_size}u\n\
         \n\
         /* Exact musl termios wire record size. */\n\
         #define WASM_POSIX_TERMIOS_SIZE {termios_size}u\n\
         \n",
        version = shared::ABI_VERSION,
        sys_spawn = shared::abi::host_intercepted::SYS_SPAWN,
        fork_mode_fork = shared::fork_contract::MODE_FORK,
        fork_mode_vfork = shared::fork_contract::MODE_VFORK,
        thread_slots_default = shared::process_memory::THREAD_SLOTS_USE_HOST_DEFAULT,
        rusage_wire_size = shared::WASM_RUSAGE_WIRE_SIZE,
        termios_size = shared::ioctl_contract::TERMIOS_SIZE,
    );
    out.push_str(&render_c_channel_contract());
    out.push_str(
        "/* A known request without a lossless layout for this caller. */\n\
         #define WASM_POSIX_IOCTL_UNSUPPORTED_SIZE UINT32_MAX\n\
         \n\
         static inline uint32_t\n\
         wasm_posix_ioctl_arg_size(uint32_t request, uint32_t pointer_width)\n\
         {\n\
             switch (request) {\n",
    );
    for contract in shared::ioctl_contract::IOCTL_REQUEST_CONTRACTS {
        let wasm32 = contract
            .wasm32_size
            .map(|size| format!("{size}u"))
            .unwrap_or_else(|| "WASM_POSIX_IOCTL_UNSUPPORTED_SIZE".into());
        let wasm64 = contract
            .wasm64_size
            .map(|size| format!("{size}u"))
            .unwrap_or_else(|| "WASM_POSIX_IOCTL_UNSUPPORTED_SIZE".into());
        out.push_str(&format!(
            "             case 0x{:08x}u:\n\
                         return pointer_width == 4u ? {wasm32} :\n\
                                pointer_width == 8u ? {wasm64} :\n\
                                WASM_POSIX_IOCTL_UNSUPPORTED_SIZE;\n",
            contract.request
        ));
    }
    out.push_str(
        "             default:\n\
                     return 0u;\n\
             }\n\
         }\n\
         \n\
         #endif /* WASM_POSIX_ABI_CONSTANTS_H */\n",
    );
    out
}

fn render_c_channel_contract() -> String {
    use shared::channel;

    format!(
        "/* Shared syscall-channel status values. */\n\
         #define WASM_POSIX_CHANNEL_STATUS_IDLE {status_idle}u\n\
         #define WASM_POSIX_CHANNEL_STATUS_PENDING {status_pending}u\n\
         #define WASM_POSIX_CHANNEL_STATUS_COMPLETE {status_complete}u\n\
         #define WASM_POSIX_CHANNEL_STATUS_ERROR {status_error}u\n\
         #define WASM_POSIX_CHANNEL_STATUS_TEARDOWN {status_teardown}u\n\
         \n\
         /* Shared syscall-channel layout. */\n\
         #define WASM_POSIX_CHANNEL_STATUS_OFFSET {status_offset}u\n\
         #define WASM_POSIX_CHANNEL_STATUS_SIZE {status_size}u\n\
         #define WASM_POSIX_CHANNEL_SYSCALL_OFFSET {syscall_offset}u\n\
         #define WASM_POSIX_CHANNEL_SYSCALL_SIZE {syscall_size}u\n\
         #define WASM_POSIX_CHANNEL_ARGS_OFFSET {args_offset}u\n\
         #define WASM_POSIX_CHANNEL_ARGS_COUNT {args_count}u\n\
         #define WASM_POSIX_CHANNEL_ARG_SIZE {arg_size}u\n\
         #define WASM_POSIX_CHANNEL_RETURN_OFFSET {return_offset}u\n\
         #define WASM_POSIX_CHANNEL_RETURN_SIZE {return_size}u\n\
         #define WASM_POSIX_CHANNEL_ERRNO_OFFSET {errno_offset}u\n\
         #define WASM_POSIX_CHANNEL_ERRNO_SIZE {errno_size}u\n\
         #define WASM_POSIX_CHANNEL_REQUEST_FLAGS_OFFSET {request_flags_offset}u\n\
         #define WASM_POSIX_CHANNEL_REQUEST_FLAGS_SIZE {request_flags_size}u\n\
         #define WASM_POSIX_CHANNEL_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY {defer_signal_delivery}u\n\
         #define WASM_POSIX_CHANNEL_REQUEST_FLAG_CANCELLATION_POINT {request_flag_cancellation_point}u\n\
         #define WASM_POSIX_CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED {request_flag_cancellation_wake_allowed}u\n\
         #define WASM_POSIX_CHANNEL_REQUEST_FLAG_OPAQUE_RECORD {request_flag_opaque_record}u\n\
         #define WASM_POSIX_CHANNEL_REQUEST_FLAGS_KNOWN_MASK {request_flags_known_mask}u\n\
         #define WASM_POSIX_CHANNEL_DATA_OFFSET {data_offset}u\n\
         #define WASM_POSIX_CHANNEL_DATA_SIZE {data_size}u\n\
         #define WASM_POSIX_CHANNEL_HEADER_SIZE {header_size}u\n\
         #define WASM_POSIX_CHANNEL_MIN_SIZE {min_size}u\n\
         \n\
         /* Signal-delivery wire at the end of the channel data buffer. */\n\
         #define WASM_POSIX_CHANNEL_SIG_AREA_SIZE {sig_area_size}u\n\
         #define WASM_POSIX_CHANNEL_SIG_DELIVERY_SIZE {sig_delivery_size}u\n\
         #define WASM_POSIX_CHANNEL_SIG_WORD_BYTES {sig_word_bytes}u\n\
         #define WASM_POSIX_CHANNEL_SIG_SI_VALUE_BYTES {sig_si_value_bytes}u\n\
         #define WASM_POSIX_CHANNEL_SIG_OLD_MASK_BYTES {sig_old_mask_bytes}u\n\
         #define WASM_POSIX_CHANNEL_SIG_ALT_SP_BYTES {sig_alt_sp_bytes}u\n\
         #define WASM_POSIX_CHANNEL_SIG_ALT_SIZE_BYTES {sig_alt_size_bytes}u\n\
         #define WASM_POSIX_CHANNEL_SIG_BASE_OFFSET {sig_base}u\n\
         #define WASM_POSIX_CHANNEL_SIG_SIGNUM_OFFSET {sig_signum}u\n\
         #define WASM_POSIX_CHANNEL_SIG_HANDLER_OFFSET {sig_handler}u\n\
         #define WASM_POSIX_CHANNEL_SIG_FLAGS_OFFSET {sig_flags}u\n\
         #define WASM_POSIX_CHANNEL_SIG_SI_VALUE_OFFSET {sig_si_value}u\n\
         #define WASM_POSIX_CHANNEL_SIG_OLD_MASK_OFFSET {sig_old_mask}u\n\
         #define WASM_POSIX_CHANNEL_SIG_SI_CODE_OFFSET {sig_si_code}u\n\
         #define WASM_POSIX_CHANNEL_SIGINFO_WORD_1_OFFSET {siginfo_word_1}u\n\
         #define WASM_POSIX_CHANNEL_SIGINFO_WORD_2_OFFSET {siginfo_word_2}u\n\
         #define WASM_POSIX_CHANNEL_SIG_ALT_SP_OFFSET {sig_alt_sp}u\n\
         #define WASM_POSIX_CHANNEL_SIG_ALT_SIZE_OFFSET {sig_alt_size}u\n\
         \n",
        status_idle = shared::ChannelStatus::Idle as u32,
        status_pending = shared::ChannelStatus::Pending as u32,
        status_complete = shared::ChannelStatus::Complete as u32,
        status_error = shared::ChannelStatus::Error as u32,
        status_teardown = shared::ChannelStatus::Teardown as u32,
        status_offset = channel::STATUS_OFFSET,
        status_size = channel::STATUS_SIZE,
        syscall_offset = channel::SYSCALL_OFFSET,
        syscall_size = channel::SYSCALL_SIZE,
        args_offset = channel::ARGS_OFFSET,
        args_count = channel::ARGS_COUNT,
        arg_size = channel::ARG_SIZE,
        return_offset = channel::RETURN_OFFSET,
        return_size = channel::RETURN_SIZE,
        errno_offset = channel::ERRNO_OFFSET,
        errno_size = channel::ERRNO_SIZE,
        request_flags_offset = channel::REQUEST_FLAGS_OFFSET,
        request_flags_size = channel::REQUEST_FLAGS_SIZE,
        defer_signal_delivery = channel::REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
        request_flag_cancellation_point = channel::REQUEST_FLAG_CANCELLATION_POINT,
        request_flag_cancellation_wake_allowed = channel::REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED,
        request_flag_opaque_record = channel::REQUEST_FLAG_OPAQUE_RECORD,
        request_flags_known_mask = channel::REQUEST_FLAGS_KNOWN_MASK,
        data_offset = channel::DATA_OFFSET,
        data_size = channel::DATA_SIZE,
        header_size = channel::HEADER_SIZE,
        min_size = channel::MIN_CHANNEL_SIZE,
        sig_area_size = channel::SIG_AREA_SIZE,
        sig_delivery_size = channel::SIG_DELIVERY_SIZE,
        sig_word_bytes = shared::kernel_scratch_wire::SIGNAL_WORD_BYTES,
        sig_si_value_bytes = shared::kernel_scratch_wire::SIGNAL_SI_VALUE_BYTES,
        sig_old_mask_bytes = shared::kernel_scratch_wire::SIGNAL_OLD_MASK_BYTES,
        sig_alt_sp_bytes = shared::kernel_scratch_wire::SIGNAL_ALT_SP_BYTES,
        sig_alt_size_bytes = shared::kernel_scratch_wire::SIGNAL_ALT_SIZE_BYTES,
        sig_base = channel::SIG_BASE,
        sig_signum = channel::SIG_SIGNUM,
        sig_handler = channel::SIG_HANDLER,
        sig_flags = channel::SIG_FLAGS,
        sig_si_value = channel::SIG_SI_VALUE,
        sig_old_mask = channel::SIG_OLD_MASK,
        sig_si_code = channel::SIG_SI_CODE,
        siginfo_word_1 = channel::SIGINFO_WORD_1,
        siginfo_word_2 = channel::SIGINFO_WORD_2,
        sig_alt_sp = channel::SIG_ALT_SP,
        sig_alt_size = channel::SIG_ALT_SIZE,
    )
}

/// Kandelo-owned wasm32 OSS source ABI. Generate this SDK header from the
/// same Rust constants recorded in the ABI snapshot so C and Rust cannot
/// silently assign different request numbers.
fn render_soundcard_header() -> String {
    let mut out = String::from(
        "/* GENERATED by `cargo xtask dump-abi`. Do not edit by hand. */\n\
         /* Kandelo-owned wasm32 OSS source ABI; independent of the host UAPI. */\n\
         #ifndef KANDELO_SYS_SOUNDCARD_H\n\
         #define KANDELO_SYS_SOUNDCARD_H\n\
         \n\
         #include <stddef.h>\n\
         #include <stdint.h>\n\
         \n",
    );

    for (name, value) in oss_format_constants() {
        out.push_str(&format!("#define {name} 0x{value:08x}u\n"));
    }
    for (alias, target) in oss_format_aliases() {
        out.push_str(&format!("#define {alias} {target}\n"));
    }
    out.push_str(
        "\n\
         typedef struct audio_buf_info {\n\
         \tint32_t fragments;\n\
         \tint32_t fragstotal;\n\
         \tint32_t fragsize;\n\
         \tint32_t bytes;\n\
         } audio_buf_info;\n\
         \n\
         typedef struct count_info {\n\
         \tint32_t bytes;\n\
         \tint32_t blocks;\n\
         \tint32_t ptr;\n\
         } count_info;\n\
         \n\
         /* Declared for source compatibility; Kandelo does not support DSP mmap. */\n\
         typedef struct buffmem_desc {\n\
         \tvoid *buffer;\n\
         \tint32_t size;\n\
         } buffmem_desc;\n\
         \n",
    );
    for (name, value) in oss_ioctl_constants() {
        out.push_str(&format!("#define {name} 0x{value:08x}u\n"));
    }
    for (alias, target) in oss_source_aliases() {
        out.push_str(&format!("#define {alias} {target}\n"));
    }
    out.push('\n');
    for (name, value) in oss_trigger_constants() {
        out.push_str(&format!("#define {name} 0x{value:08x}u\n"));
    }
    out.push('\n');
    for (name, value) in oss_capability_constants() {
        out.push_str(&format!("#define {name} 0x{value:08x}u\n"));
    }
    out.push_str(
        "#define DSP_CAP_REVISION PCM_CAP_REVISION\n\
         #define DSP_CAP_DUPLEX PCM_CAP_DUPLEX\n\
         #define DSP_CAP_REALTIME PCM_CAP_REALTIME\n\
         #define DSP_CAP_BATCH PCM_CAP_BATCH\n\
         #define DSP_CAP_COPROC PCM_CAP_COPROC\n\
         #define DSP_CAP_TRIGGER PCM_CAP_TRIGGER\n\
         #define DSP_CAP_MMAP PCM_CAP_MMAP\n\
         #define DSP_CAP_MULTI PCM_CAP_MULTI\n\
         #define DSP_CAP_BIND PCM_CAP_BIND\n\
         #define DSP_CAP_INPUT PCM_CAP_INPUT\n\
         #define DSP_CAP_OUTPUT PCM_CAP_OUTPUT\n\
         #define DSP_CAP_VIRTUAL PCM_CAP_VIRTUAL\n\
         #define DSP_CAP_DEFAULT PCM_CAP_DEFAULT\n\
         \n\
         #if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L\n",
    );
    for (name, value) in oss_format_constants()
        .into_iter()
        .chain(oss_ioctl_constants())
        .chain(oss_trigger_constants())
        .chain(oss_capability_constants())
    {
        out.push_str(&format!(
            "_Static_assert({name} == 0x{value:08x}u, \"{name} ABI\");\n"
        ));
    }
    for (alias, target) in oss_source_aliases() {
        out.push_str(&format!(
            "_Static_assert({alias} == {target}, \"{alias} source alias\");\n"
        ));
    }
    for (alias, target) in oss_format_aliases() {
        out.push_str(&format!(
            "_Static_assert({alias} == {target}, \"{alias} source alias\");\n"
        ));
    }
    out.push_str(
        "_Static_assert(sizeof(audio_buf_info) == 16, \"audio_buf_info ABI size\");\n\
         _Static_assert(_Alignof(audio_buf_info) == 4, \"audio_buf_info ABI align\");\n\
         _Static_assert(offsetof(audio_buf_info, fragments) == 0, \"audio_buf_info.fragments ABI offset\");\n\
         _Static_assert(offsetof(audio_buf_info, fragstotal) == 4, \"audio_buf_info.fragstotal ABI offset\");\n\
         _Static_assert(offsetof(audio_buf_info, fragsize) == 8, \"audio_buf_info.fragsize ABI offset\");\n\
         _Static_assert(offsetof(audio_buf_info, bytes) == 12, \"audio_buf_info.bytes ABI offset\");\n\
         _Static_assert(sizeof(count_info) == 12, \"count_info ABI size\");\n\
         _Static_assert(_Alignof(count_info) == 4, \"count_info ABI align\");\n\
         _Static_assert(offsetof(count_info, bytes) == 0, \"count_info.bytes ABI offset\");\n\
         _Static_assert(offsetof(count_info, blocks) == 4, \"count_info.blocks ABI offset\");\n\
         _Static_assert(offsetof(count_info, ptr) == 8, \"count_info.ptr ABI offset\");\n\
         #endif\n\
         \n\
         #endif /* KANDELO_SYS_SOUNDCARD_H */\n",
    );
    out
}

fn oss_format_constants() -> Vec<(&'static str, u32)> {
    use shared::oss;
    vec![
        ("AFMT_QUERY", oss::AFMT_QUERY),
        ("AFMT_MU_LAW", oss::AFMT_MU_LAW),
        ("AFMT_A_LAW", oss::AFMT_A_LAW),
        ("AFMT_IMA_ADPCM", oss::AFMT_IMA_ADPCM),
        ("AFMT_U8", oss::AFMT_U8),
        ("AFMT_S16_LE", oss::AFMT_S16_LE),
        ("AFMT_S16_BE", oss::AFMT_S16_BE),
        ("AFMT_S8", oss::AFMT_S8),
        ("AFMT_U16_LE", oss::AFMT_U16_LE),
        ("AFMT_U16_BE", oss::AFMT_U16_BE),
        ("AFMT_MPEG", oss::AFMT_MPEG),
        ("AFMT_AC3", oss::AFMT_AC3),
        ("AFMT_S32_LE", oss::AFMT_S32_LE),
        ("AFMT_S32_BE", oss::AFMT_S32_BE),
        ("AFMT_U32_LE", oss::AFMT_U32_LE),
        ("AFMT_U32_BE", oss::AFMT_U32_BE),
        ("AFMT_S24_LE", oss::AFMT_S24_LE),
        ("AFMT_S24_BE", oss::AFMT_S24_BE),
        ("AFMT_U24_LE", oss::AFMT_U24_LE),
        ("AFMT_U24_BE", oss::AFMT_U24_BE),
        ("AFMT_F32_LE", oss::AFMT_F32_LE),
        ("AFMT_F32_BE", oss::AFMT_F32_BE),
    ]
}

/// The Kandelo SDK targets little-endian wasm32. Publish FreeBSD's canonical
/// native/opposite-endian format spellings without duplicating numeric values
/// in the ABI snapshot.
fn oss_format_aliases() -> Vec<(&'static str, &'static str)> {
    vec![
        ("AFMT_S16_NE", "AFMT_S16_LE"),
        ("AFMT_S16_OE", "AFMT_S16_BE"),
        ("AFMT_S24_NE", "AFMT_S24_LE"),
        ("AFMT_S24_OE", "AFMT_S24_BE"),
        ("AFMT_S32_NE", "AFMT_S32_LE"),
        ("AFMT_S32_OE", "AFMT_S32_BE"),
        ("AFMT_U16_NE", "AFMT_U16_LE"),
        ("AFMT_U16_OE", "AFMT_U16_BE"),
        ("AFMT_U24_NE", "AFMT_U24_LE"),
        ("AFMT_U24_OE", "AFMT_U24_BE"),
        ("AFMT_U32_NE", "AFMT_U32_LE"),
        ("AFMT_U32_OE", "AFMT_U32_BE"),
        ("AFMT_F32_NE", "AFMT_F32_LE"),
        ("AFMT_F32_OE", "AFMT_F32_BE"),
        ("AFMT_FLOAT", "AFMT_F32_NE"),
    ]
}

fn oss_ioctl_constants() -> Vec<(&'static str, u32)> {
    use shared::oss;
    vec![
        ("SNDCTL_DSP_RESET", oss::SNDCTL_DSP_RESET),
        ("SNDCTL_DSP_SYNC", oss::SNDCTL_DSP_SYNC),
        ("SNDCTL_DSP_SPEED", oss::SNDCTL_DSP_SPEED),
        ("SNDCTL_DSP_STEREO", oss::SNDCTL_DSP_STEREO),
        ("SNDCTL_DSP_GETBLKSIZE", oss::SNDCTL_DSP_GETBLKSIZE),
        ("SNDCTL_DSP_SETBLKSIZE", oss::SNDCTL_DSP_SETBLKSIZE),
        ("SNDCTL_DSP_SETFMT", oss::SNDCTL_DSP_SETFMT),
        ("SNDCTL_DSP_CHANNELS", oss::SNDCTL_DSP_CHANNELS),
        ("SOUND_PCM_WRITE_FILTER", oss::SOUND_PCM_WRITE_FILTER),
        ("SNDCTL_DSP_POST", oss::SNDCTL_DSP_POST),
        ("SNDCTL_DSP_SUBDIVIDE", oss::SNDCTL_DSP_SUBDIVIDE),
        ("SNDCTL_DSP_SETFRAGMENT", oss::SNDCTL_DSP_SETFRAGMENT),
        ("SNDCTL_DSP_GETFMTS", oss::SNDCTL_DSP_GETFMTS),
        ("SNDCTL_DSP_GETOSPACE", oss::SNDCTL_DSP_GETOSPACE),
        ("SNDCTL_DSP_GETISPACE", oss::SNDCTL_DSP_GETISPACE),
        ("SNDCTL_DSP_NONBLOCK", oss::SNDCTL_DSP_NONBLOCK),
        ("SNDCTL_DSP_GETCAPS", oss::SNDCTL_DSP_GETCAPS),
        ("SNDCTL_DSP_SETTRIGGER", oss::SNDCTL_DSP_SETTRIGGER),
        ("SNDCTL_DSP_GETTRIGGER", oss::SNDCTL_DSP_GETTRIGGER),
        ("SNDCTL_DSP_GETIPTR", oss::SNDCTL_DSP_GETIPTR),
        ("SNDCTL_DSP_GETOPTR", oss::SNDCTL_DSP_GETOPTR),
        ("SNDCTL_DSP_MAPINBUF", oss::SNDCTL_DSP_MAPINBUF),
        ("SNDCTL_DSP_MAPOUTBUF", oss::SNDCTL_DSP_MAPOUTBUF),
        ("SNDCTL_DSP_SETSYNCRO", oss::SNDCTL_DSP_SETSYNCRO),
        ("SNDCTL_DSP_SETDUPLEX", oss::SNDCTL_DSP_SETDUPLEX),
        ("SNDCTL_DSP_GETODELAY", oss::SNDCTL_DSP_GETODELAY),
        ("SOUND_PCM_READ_RATE", oss::SOUND_PCM_READ_RATE),
        ("SOUND_PCM_READ_BITS", oss::SOUND_PCM_READ_BITS),
        ("SOUND_PCM_READ_CHANNELS", oss::SOUND_PCM_READ_CHANNELS),
        ("SOUND_PCM_READ_FILTER", oss::SOUND_PCM_READ_FILTER),
    ]
}

/// Canonical OSS compatibility spellings that do not introduce additional
/// ioctl values. Keep aliases out of the ABI snapshot's numeric map: their
/// targets are already pinned there, while the generated C assertions protect
/// the source-level contract.
fn oss_source_aliases() -> Vec<(&'static str, &'static str)> {
    vec![
        ("SNDCTL_DSP_HALT", "SNDCTL_DSP_RESET"),
        ("SNDCTL_DSP_SAMPLESIZE", "SNDCTL_DSP_SETFMT"),
        ("SOUND_PCM_WRITE_RATE", "SNDCTL_DSP_SPEED"),
        ("SOUND_PCM_WRITE_CHANNELS", "SNDCTL_DSP_CHANNELS"),
        ("SOUND_PCM_WRITE_BITS", "SNDCTL_DSP_SETFMT"),
        ("SOUND_PCM_SETFMT", "SNDCTL_DSP_SETFMT"),
        ("SOUND_PCM_POST", "SNDCTL_DSP_POST"),
        ("SOUND_PCM_RESET", "SNDCTL_DSP_RESET"),
        ("SOUND_PCM_SYNC", "SNDCTL_DSP_SYNC"),
        ("SOUND_PCM_SUBDIVIDE", "SNDCTL_DSP_SUBDIVIDE"),
        ("SOUND_PCM_SETFRAGMENT", "SNDCTL_DSP_SETFRAGMENT"),
        ("SOUND_PCM_GETFMTS", "SNDCTL_DSP_GETFMTS"),
        ("SOUND_PCM_GETOSPACE", "SNDCTL_DSP_GETOSPACE"),
        ("SOUND_PCM_GETISPACE", "SNDCTL_DSP_GETISPACE"),
        ("SOUND_PCM_NONBLOCK", "SNDCTL_DSP_NONBLOCK"),
        ("SOUND_PCM_GETCAPS", "SNDCTL_DSP_GETCAPS"),
        ("SOUND_PCM_GETTRIGGER", "SNDCTL_DSP_GETTRIGGER"),
        ("SOUND_PCM_SETTRIGGER", "SNDCTL_DSP_SETTRIGGER"),
        ("SOUND_PCM_SETSYNCRO", "SNDCTL_DSP_SETSYNCRO"),
        ("SOUND_PCM_GETIPTR", "SNDCTL_DSP_GETIPTR"),
        ("SOUND_PCM_GETOPTR", "SNDCTL_DSP_GETOPTR"),
        ("SOUND_PCM_MAPINBUF", "SNDCTL_DSP_MAPINBUF"),
        ("SOUND_PCM_MAPOUTBUF", "SNDCTL_DSP_MAPOUTBUF"),
    ]
}

fn oss_trigger_constants() -> Vec<(&'static str, u32)> {
    use shared::oss;
    vec![
        ("PCM_ENABLE_INPUT", oss::PCM_ENABLE_INPUT),
        ("PCM_ENABLE_OUTPUT", oss::PCM_ENABLE_OUTPUT),
    ]
}

fn oss_capability_constants() -> Vec<(&'static str, u32)> {
    use shared::oss;
    vec![
        ("PCM_CAP_REVISION", oss::PCM_CAP_REVISION),
        ("PCM_CAP_DUPLEX", oss::PCM_CAP_DUPLEX),
        ("PCM_CAP_REALTIME", oss::PCM_CAP_REALTIME),
        ("PCM_CAP_BATCH", oss::PCM_CAP_BATCH),
        ("PCM_CAP_COPROC", oss::PCM_CAP_COPROC),
        ("PCM_CAP_TRIGGER", oss::PCM_CAP_TRIGGER),
        ("PCM_CAP_MMAP", oss::PCM_CAP_MMAP),
        ("PCM_CAP_MULTI", oss::PCM_CAP_MULTI),
        ("PCM_CAP_BIND", oss::PCM_CAP_BIND),
        ("PCM_CAP_INPUT", oss::PCM_CAP_INPUT),
        ("PCM_CAP_OUTPUT", oss::PCM_CAP_OUTPUT),
        ("PCM_CAP_VIRTUAL", oss::PCM_CAP_VIRTUAL),
        ("PCM_CAP_DEFAULT", oss::PCM_CAP_DEFAULT),
    ]
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

    // Not an ABI value: the one fixed instant image builders use when a fixed
    // time is needed (wasm_posix_shared::KANDELO_REFERENCE_EPOCH_SECONDS). It
    // lives in this generated module so the TypeScript builders read the same
    // number the Rust image writer does rather than a second literal.
    out.push_str(&format!(
        "/* Kandelo's reference instant: the first Kandelo commit's time. Stamped\n\
         * on image files when no time is supplied; never 0, which software\n\
         * reads as \"no timestamp\" (wasm_posix_shared::KANDELO_REFERENCE_EPOCH_SECONDS). */\n\
         export const KANDELO_REFERENCE_EPOCH_SECONDS = {} as const;\n\n",
        shared::KANDELO_REFERENCE_EPOCH_SECONDS,
    ));

    // Phase 2 (Option A) RAW syscall set, projected from
    // wasm_posix_shared::host_raw_syscalls. These syscalls keep raw i64 args and
    // are never carried as an opaque record. The blind record fast-path in
    // kernel-worker.ts asserts a RAW syscall never arrives with RECORD_MAGIC.
    out.push_str(&format!(
        "/* Opaque channel-record sentinel (wasm_posix_shared::channel_record). */\n\
         export const RECORD_MAGIC = 0x{:08X} as const;\n\
         /* The record frames itself: the host copies RECORD_LEN_OFFSET's u32\n\
          * bytes (clamped to [RECORD_HEADER_BYTES, RECORD_INLINE_BUDGET]) and\n\
          * reads nothing else inside the record. */\n\
         export const RECORD_HEADER_BYTES = {} as const;\n\
         export const RECORD_LEN_OFFSET = {} as const;\n\
         export const RECORD_INLINE_BUDGET = {} as const;\n\n",
        shared::channel_record::RECORD_MAGIC,
        shared::channel_record::RECORD_HEADER_BYTES,
        shared::channel_record::RECORD_LEN_OFFSET,
        shared::channel_record::RECORD_INLINE_BUDGET,
    ));
    {
        use shared::host_raw_syscalls::host_raw_syscalls_sorted;
        let (sorted, len) = host_raw_syscalls_sorted();
        out.push_str(
            "/* Phase 2 RAW syscalls (keep raw args, never a record). Source of\n\
             * truth: wasm_posix_shared::host_raw_syscalls; mirror of the guest\n\
             * marshal header's kandelo_raw_syscalls. */\n\
             export const HOST_RAW_SYSCALLS: ReadonlySet<number> = new Set<number>([\n",
        );
        for &n in &sorted[..len] {
            out.push_str(&format!("  {n},\n"));
        }
        out.push_str("]);\n\n");
    }

    out.push_str(&format!(
        "export const WPK_FORK_LINKED_FRAME_FORMAT_SECTION = {:?} as const;\n",
        shared::abi::WPK_FORK_LINKED_FRAME_FORMAT_SECTION
    ));
    out.push_str(&format!(
        "export const WPK_FORK_LINKED_FRAME_FORMAT_VERSION = {} as const;\n",
        shared::abi::WPK_FORK_LINKED_FRAME_FORMAT_VERSION
    ));
    out.push_str(&format!(
        "export const WPK_FORK_LINKED_FRAME_FORMAT_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_LINKED_FRAME_FORMAT_MAGIC
    ));
    out.push_str(&format!(
        "export const WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE = {} as const;\n",
        shared::abi::WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE
    ));
    out.push_str(&format!(
        "export const WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT = {} as const;\n",
        shared::abi::WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT
    ));
    out.push_str(&format!(
        "export const WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS = {} as const;\n",
        shared::abi::WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS
    ));
    out.push_str("export const WPK_FORK_LINKED_FRAME_POINTER_WIDTHS = [\n");
    for pointer_width in shared::abi::WPK_FORK_LINKED_FRAME_POINTER_WIDTHS {
        out.push_str(&format!(
            "  {{ bytes: {}, chunkHeaderSize: {}, nodeHeaderSize: {} }},\n",
            pointer_width,
            shared::abi::wpk_fork_linked_chunk_header_size(*pointer_width)
                .expect("supported pointer width must have a chunk header"),
            shared::abi::wpk_fork_linked_node_header_size(*pointer_width)
                .expect("supported pointer width must have a node header"),
        ));
    }
    out.push_str("] as const;\n");
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_FORMAT_SECTION = {:?} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_FORMAT_SECTION
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_FORMAT_VERSION = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_FORMAT_VERSION
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_FORMAT_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_FORMAT_MAGIC
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_REQUIRED_FLAGS = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_REQUIRED_FLAGS
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_KNOWN_FLAGS = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_KNOWN_FLAGS
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_ARENA_VERSION = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_ARENA_VERSION
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_RECORD_VERSION = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_RECORD_VERSION
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_CHUNK_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_CHUNK_MAGIC
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_CHUNK_KNOWN_FLAGS = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_CHUNK_KNOWN_FLAGS
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_RECORD_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_RECORD_MAGIC
    ));
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE = {} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE
    ));
    for (name, value) in [
        (
            "MODULE",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE,
        ),
        (
            "REFERENCE_RECIPE",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE,
        ),
        (
            "MUTABLE_GLOBAL",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL,
        ),
        (
            "TABLE",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE,
        ),
        (
            "TABLE_PAGE",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE,
        ),
        (
            "ELEMENT_SEGMENTS",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS,
        ),
        (
            "DATA_SEGMENTS",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS,
        ),
        (
            "REPLAY_EVENTS",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENTS,
        ),
        (
            "IMPORTED_GLOBAL_BINDINGS",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
        ),
        (
            "ACTIVATION_CONTINUATIONS",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_ACTIVATION_CONTINUATIONS,
        ),
        (
            "IMPORTED_TABLE_BINDINGS",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_TABLE_BINDINGS,
        ),
        (
            "REFERENCE_RECIPE_SEGMENT",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE_SEGMENT,
        ),
        (
            "REPLAY_EVENT_SEGMENT",
            shared::abi::WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENT_SEGMENT,
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_MODULE_STATE_RECORD_KIND_{name} = {value} as const;\n"
        ));
    }
    out.push_str("export const WPK_FORK_MODULE_STATE_RECORD_KINDS = [\n");
    for kind in shared::abi::WPK_FORK_MODULE_STATE_RECORD_KINDS {
        out.push_str(&format!(
            "  {{ number: {}, name: {:?} }},\n",
            kind.number, kind.name
        ));
    }
    out.push_str("] as const;\n");
    out.push_str("export const WPK_FORK_MODULE_STATE_POINTER_WIDTHS = [\n");
    for pointer_width in shared::abi::WPK_FORK_MODULE_STATE_POINTER_WIDTHS {
        out.push_str(&format!(
            "  {{ bytes: {}, chunkHeaderSize: {} }},\n",
            pointer_width,
            shared::abi::wpk_fork_module_state_chunk_header_size(*pointer_width)
                .expect("supported pointer width must have a module-state chunk header"),
        ));
    }
    out.push_str("] as const;\n");
    out.push_str(&format!(
        "export const WPK_FORK_MODULE_STATE_REPLAY_EVENTS_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_MODULE_STATE_REPLAY_EVENTS_MAGIC,
    ));
    out.push_str(&format!(
        "export const WPK_FORK_REFERENCE_TRANSACTION_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_REFERENCE_TRANSACTION_MAGIC,
    ));
    out.push_str(&format!(
        "export const WPK_FORK_REFERENCE_SEGMENT_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_REFERENCE_SEGMENT_MAGIC,
    ));
    for (name, value) in [
        (
            "TRANSACTION_OWNER",
            shared::abi::WPK_FORK_REFERENCE_TRANSACTION_OWNER,
        ),
        (
            "TRANSACTION_VERSION",
            u32::from(shared::abi::WPK_FORK_REFERENCE_TRANSACTION_VERSION),
        ),
        (
            "TRANSACTION_MANIFEST_SIZE",
            u32::from(shared::abi::WPK_FORK_REFERENCE_TRANSACTION_MANIFEST_SIZE),
        ),
        (
            "TRANSACTION_FLAG_SEALED",
            shared::abi::WPK_FORK_REFERENCE_TRANSACTION_FLAG_SEALED,
        ),
        (
            "TRANSACTION_KNOWN_FLAGS",
            shared::abi::WPK_FORK_REFERENCE_TRANSACTION_KNOWN_FLAGS,
        ),
        (
            "SEGMENT_HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_REFERENCE_SEGMENT_HEADER_SIZE),
        ),
        (
            "SEGMENT_KNOWN_FLAGS",
            u32::from(shared::abi::WPK_FORK_REFERENCE_SEGMENT_KNOWN_FLAGS),
        ),
        (
            "NODE_RECORD_SIZE",
            u32::from(shared::abi::WPK_FORK_REFERENCE_NODE_RECORD_SIZE),
        ),
        (
            "VECTOR_INDEX_SIZE",
            u32::from(shared::abi::WPK_FORK_REFERENCE_VECTOR_INDEX_SIZE),
        ),
        (
            "SECTION_NODES",
            u32::from(shared::abi::WPK_FORK_REFERENCE_SECTION_NODES),
        ),
        (
            "SECTION_EDGES",
            u32::from(shared::abi::WPK_FORK_REFERENCE_SECTION_EDGES),
        ),
        (
            "SECTION_SCALARS",
            u32::from(shared::abi::WPK_FORK_REFERENCE_SECTION_SCALARS),
        ),
        (
            "SECTION_VECTOR_INDEX",
            u32::from(shared::abi::WPK_FORK_REFERENCE_SECTION_VECTOR_INDEX),
        ),
        (
            "SECTION_VECTOR_ENTRIES",
            u32::from(shared::abi::WPK_FORK_REFERENCE_SECTION_VECTOR_ENTRIES),
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_REFERENCE_{name} = {value} as const;\n"
        ));
    }
    for (name, value) in [
        (
            "MODULE_TEMPLATE_ID_SIZE",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE),
        ),
        (
            "MODULE_RECORD_PAYLOAD_SIZE",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE),
        ),
        (
            "MODULE_RECORD_KNOWN_FLAGS",
            shared::abi::WPK_FORK_MODULE_STATE_MODULE_RECORD_KNOWN_FLAGS,
        ),
        (
            "GLOBAL_HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE),
        ),
        (
            "TABLE_BASELINE_FINGERPRINT_SIZE",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE),
        ),
        (
            "TABLE_DESCRIPTOR_PAYLOAD_SIZE",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE),
        ),
        (
            "TABLE_FLAG_SPARSE_OVERRIDES",
            shared::abi::WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES,
        ),
        (
            "TABLE_KNOWN_FLAGS",
            shared::abi::WPK_FORK_MODULE_STATE_TABLE_KNOWN_FLAGS,
        ),
        (
            "TABLE_PAGE_HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE),
        ),
        (
            "TABLE_RUN_HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE),
        ),
        (
            "ELEMENT_SEGMENT_HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE),
        ),
        (
            "DATA_SEGMENT_HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE),
        ),
        (
            "REPLAY_EVENTS_OWNER",
            shared::abi::WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER,
        ),
        (
            "REPLAY_EVENTS_VERSION",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_REPLAY_EVENTS_VERSION),
        ),
        (
            "REPLAY_EVENTS_HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_REPLAY_EVENTS_HEADER_SIZE),
        ),
        (
            "REPLAY_EVENT_SIZE",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_REPLAY_EVENT_SIZE),
        ),
        (
            "REPLAY_EVENTS_KNOWN_FLAGS",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_REPLAY_EVENTS_KNOWN_FLAGS),
        ),
        (
            "REPLAY_EVENT_SEGMENT_VERSION",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_VERSION),
        ),
        (
            "REPLAY_EVENT_SEGMENT_HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_HEADER_SIZE),
        ),
        (
            "REPLAY_EVENT_SEGMENT_CAPACITY",
            shared::abi::WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_CAPACITY,
        ),
        (
            "REPLAY_EVENT_SEGMENT_KNOWN_FLAGS",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_KNOWN_FLAGS),
        ),
        (
            "MIN_TABLE_PAGE_SHIFT",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT),
        ),
        (
            "MAX_TABLE_PAGE_SHIFT",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT),
        ),
        (
            "TABLE_PAGE_SHIFT",
            u32::from(shared::abi::WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT),
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_MODULE_STATE_{name} = {value} as const;\n"
        ));
    }
    out.push_str(&format!(
        "export const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC,
    ));
    for (name, value) in [
        (
            "OWNER",
            shared::abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER,
        ),
        (
            "VERSION",
            u32::from(shared::abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_VERSION),
        ),
        (
            "HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE),
        ),
        (
            "ENTRY_SIZE",
            u32::from(shared::abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE),
        ),
        (
            "KNOWN_FLAGS",
            u32::from(shared::abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_KNOWN_FLAGS),
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_{name} = {value} as const;\n"
        ));
    }
    for (name, value) in [
        (
            "RAW_NUMBER",
            shared::abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER,
        ),
        (
            "RAW_BIGINT",
            shared::abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT,
        ),
        (
            "RAW_REFERENCE",
            shared::abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE,
        ),
        (
            "ACTIVATION_GLOBAL",
            shared::abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL,
        ),
        (
            "BASE_IMPORT",
            shared::abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT,
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_IMPORTED_GLOBAL_BINDING_{name} = {value} as const;\n"
        ));
    }
    out.push_str(&format!(
        "export const WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX = {:?} as const;\n",
        shared::abi::WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
    ));
    out.push_str(&format!(
        "export const WPK_FORK_ACTIVATION_CONTINUATIONS_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_ACTIVATION_CONTINUATIONS_MAGIC,
    ));
    for (name, value) in [
        (
            "OWNER",
            u32::from(shared::abi::WPK_FORK_ACTIVATION_CONTINUATIONS_OWNER),
        ),
        (
            "VERSION",
            u32::from(shared::abi::WPK_FORK_ACTIVATION_CONTINUATIONS_VERSION),
        ),
        (
            "HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE),
        ),
        (
            "ENTRY_SIZE",
            u32::from(shared::abi::WPK_FORK_ACTIVATION_CONTINUATION_ENTRY_SIZE),
        ),
        (
            "KNOWN_FLAGS",
            u32::from(shared::abi::WPK_FORK_ACTIVATION_CONTINUATIONS_KNOWN_FLAGS),
        ),
        (
            "ENTRY_KNOWN_FLAGS",
            shared::abi::WPK_FORK_ACTIVATION_CONTINUATION_ENTRY_KNOWN_FLAGS,
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_ACTIVATION_CONTINUATIONS_{name} = {value} as const;\n"
        ));
    }
    out.push_str(&format!(
        "export const WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC,
    ));
    for (name, value) in [
        ("OWNER", shared::abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_OWNER),
        (
            "VERSION",
            u32::from(shared::abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_VERSION),
        ),
        (
            "HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE),
        ),
        (
            "ENTRY_SIZE",
            u32::from(shared::abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE),
        ),
        (
            "KNOWN_FLAGS",
            u32::from(shared::abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_KNOWN_FLAGS),
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_IMPORTED_TABLE_BINDINGS_{name} = {value} as const;\n"
        ));
    }
    for (name, value) in [
        (
            "ACTIVATION_TABLE",
            shared::abi::WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE,
        ),
        (
            "BASE_IMPORT",
            shared::abi::WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT,
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_IMPORTED_TABLE_BINDING_{name} = {value} as const;\n"
        ));
    }
    out.push_str(&format!(
        "export const WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX = {:?} as const;\n",
        shared::abi::WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
    ));
    for (name, value) in [
        ("I32", shared::abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32),
        ("I64", shared::abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64),
        ("F32", shared::abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32),
        ("F64", shared::abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64),
        ("V128", shared::abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128),
        (
            "FUNCREF",
            shared::abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
        ),
        (
            "EXTERNREF",
            shared::abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
        ),
        (
            "EXNREF",
            shared::abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
        ),
        (
            "ANYREF",
            shared::abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_{name} = {value} as const;\n"
        ));
    }
    out.push_str(&format!(
        "export const WPK_FORK_CAPABILITIES_SECTION = {:?} as const;\n",
        shared::abi::WPK_FORK_CAPABILITIES_SECTION
    ));
    out.push_str(&format!(
        "export const WPK_FORK_CAPABILITIES_VERSION = {} as const;\n",
        shared::abi::WPK_FORK_CAPABILITIES_VERSION
    ));
    out.push_str(&format!(
        "export const WPK_FORK_CAP_SIDE_ENTRY = {} as const;\n",
        shared::abi::WPK_FORK_CAP_SIDE_ENTRY
    ));
    out.push_str(&format!(
        "export const WPK_FORK_CAP_DYLINK_MAIN = {} as const;\n",
        shared::abi::WPK_FORK_CAP_DYLINK_MAIN
    ));
    out.push_str(&format!(
        "export const WPK_FORK_CAP_ACTIVATION_STATE_SAFE = {} as const;\n",
        shared::abi::WPK_FORK_CAP_ACTIVATION_STATE_SAFE
    ));
    out.push_str(&format!(
        "export const WPK_FORK_CAP_KNOWN_MASK = {} as const;\n",
        shared::abi::WPK_FORK_CAP_KNOWN_MASK
    ));
    out.push_str(&format!(
        "export const WPK_FORK_CAP_REQUIRED_FLAGS = {} as const;\n",
        shared::abi::WPK_FORK_CAP_REQUIRED_FLAGS
    ));
    out.push_str(&format!(
        "export const WPK_FORK_EXCEPTION_CODEC_SECTION = {:?} as const;\n",
        shared::abi::WPK_FORK_EXCEPTION_CODEC_SECTION
    ));
    for (name, value) in [
        (
            "VERSION",
            u32::from(shared::abi::WPK_FORK_EXCEPTION_CODEC_VERSION),
        ),
        (
            "HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE),
        ),
        (
            "TAG_RECORD_SIZE",
            u32::from(shared::abi::WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE),
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_EXCEPTION_CODEC_{name} = {value} as const;\n"
        ));
    }
    out.push_str(&format!(
        "export const WPK_FORK_GC_CODEC_SECTION = {:?} as const;\n",
        shared::abi::WPK_FORK_GC_CODEC_SECTION
    ));
    out.push_str(&format!(
        "export const WPK_FORK_GC_CODEC_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_GC_CODEC_MAGIC,
    ));
    for (name, value) in [
        ("VERSION", u32::from(shared::abi::WPK_FORK_GC_CODEC_VERSION)),
        (
            "HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_GC_CODEC_HEADER_SIZE),
        ),
        (
            "LAYOUT_RECORD_SIZE",
            u32::from(shared::abi::WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE),
        ),
        (
            "FIELD_RECORD_SIZE",
            u32::from(shared::abi::WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE),
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_GC_CODEC_{name} = {value} as const;\n"
        ));
    }
    for (name, value) in [
        (
            "WPK_FORK_UNWIND_TAG_IMPORT_MODULE",
            shared::abi::WPK_FORK_UNWIND_TAG_IMPORT_MODULE,
        ),
        (
            "WPK_FORK_UNWIND_TAG_IMPORT_NAME",
            shared::abi::WPK_FORK_UNWIND_TAG_IMPORT_NAME,
        ),
        (
            "WPK_FORK_UNWIND_TRANSPORT_SECTION",
            shared::abi::WPK_FORK_UNWIND_TRANSPORT_SECTION,
        ),
        (
            "WPK_FORK_STATIC_ROOT_CATALOG_EXPORT",
            shared::abi::WPK_FORK_STATIC_ROOT_CATALOG_EXPORT,
        ),
        (
            "WPK_FORK_STATIC_ROOT_CATALOG_SECTION",
            shared::abi::WPK_FORK_STATIC_ROOT_CATALOG_SECTION,
        ),
        (
            "WPK_FORK_STATIC_ROOT_HARVEST_EXPORT",
            shared::abi::WPK_FORK_STATIC_ROOT_HARVEST_EXPORT,
        ),
    ] {
        out.push_str(&format!("export const {name} = {value:?} as const;\n"));
    }
    for (name, value) in [
        (
            "WPK_FORK_UNWIND_TRANSPORT_VERSION",
            u32::from(shared::abi::WPK_FORK_UNWIND_TRANSPORT_VERSION),
        ),
        (
            "WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY",
            u32::from(shared::abi::WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY),
        ),
        (
            "WPK_FORK_STATIC_ROOT_CATALOG_VERSION",
            u32::from(shared::abi::WPK_FORK_STATIC_ROOT_CATALOG_VERSION),
        ),
        (
            "WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE),
        ),
    ] {
        out.push_str(&format!("export const {name} = {value} as const;\n"));
    }
    out.push_str(&format!(
        "export const WPK_FORK_STATIC_ROOT_CATALOG_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_STATIC_ROOT_CATALOG_MAGIC,
    ));
    for (name, value) in [
        (
            "WPK_FORK_IMPORTED_GLOBALS_SECTION",
            shared::abi::WPK_FORK_IMPORTED_GLOBALS_SECTION,
        ),
        (
            "WPK_FORK_FRAME_IMPORT_COMMIT",
            shared::abi::WPK_FORK_FRAME_IMPORT_COMMIT,
        ),
        (
            "WPK_FORK_FRAME_IMPORT_NEXT",
            shared::abi::WPK_FORK_FRAME_IMPORT_NEXT,
        ),
        (
            "WPK_FORK_FRAME_IMPORT_PEEK",
            shared::abi::WPK_FORK_FRAME_IMPORT_PEEK,
        ),
        (
            "WPK_FORK_FRAME_IMPORT_RESERVE",
            shared::abi::WPK_FORK_FRAME_IMPORT_RESERVE,
        ),
        (
            "WPK_FORK_RESUME_IMPORT_PEEK",
            shared::abi::WPK_FORK_RESUME_IMPORT_PEEK,
        ),
        (
            "WPK_FORK_RESUME_IMPORT_TABLE",
            shared::abi::WPK_FORK_RESUME_IMPORT_TABLE,
        ),
        (
            "WPK_FORK_BOUNDARY_IMPORT",
            shared::abi::WPK_FORK_BOUNDARY_IMPORT,
        ),
        (
            "WPK_FORK_RESUME_SINK_EXPORT",
            shared::abi::WPK_FORK_RESUME_SINK_EXPORT,
        ),
        (
            "WPK_FORK_BOUNDARIES_SECTION",
            shared::abi::WPK_FORK_BOUNDARIES_SECTION,
        ),
    ] {
        out.push_str(&format!("export const {name} = {value:?} as const;\n"));
    }
    out.push_str(&format!(
        "export const WPK_FORK_IMPORTED_GLOBALS_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_IMPORTED_GLOBALS_MAGIC,
    ));
    for (name, value) in [
        (
            "VERSION",
            u32::from(shared::abi::WPK_FORK_IMPORTED_GLOBALS_VERSION),
        ),
        (
            "HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE),
        ),
        (
            "RECORD_HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE),
        ),
        (
            "FLAG_MUTABLE",
            u32::from(shared::abi::WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE),
        ),
        (
            "FLAG_SHARED",
            u32::from(shared::abi::WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED),
        ),
        (
            "KNOWN_FLAGS",
            u32::from(shared::abi::WPK_FORK_IMPORTED_GLOBAL_KNOWN_FLAGS),
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_IMPORTED_GLOBALS_{name} = {value} as const;\n"
        ));
    }
    out.push_str(&format!(
        "export const WPK_FORK_IMPORTED_TABLES_SECTION = {:?} as const;\n",
        shared::abi::WPK_FORK_IMPORTED_TABLES_SECTION,
    ));
    out.push_str(&format!(
        "export const WPK_FORK_IMPORTED_TABLES_MAGIC = {:?} as const;\n",
        shared::abi::WPK_FORK_IMPORTED_TABLES_MAGIC,
    ));
    for (name, value) in [
        (
            "VERSION",
            u32::from(shared::abi::WPK_FORK_IMPORTED_TABLES_VERSION),
        ),
        (
            "HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_IMPORTED_TABLES_HEADER_SIZE),
        ),
        (
            "RECORD_HEADER_SIZE",
            u32::from(shared::abi::WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE),
        ),
        (
            "FLAG_TABLE64",
            u32::from(shared::abi::WPK_FORK_IMPORTED_TABLE_FLAG_TABLE64),
        ),
        (
            "KNOWN_FLAGS",
            u32::from(shared::abi::WPK_FORK_IMPORTED_TABLE_KNOWN_FLAGS),
        ),
    ] {
        out.push_str(&format!(
            "export const WPK_FORK_IMPORTED_TABLES_{name} = {value} as const;\n"
        ));
    }
    for (name, value) in [
        (
            "WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE",
            shared::abi::WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
        ),
        (
            "WPK_FORK_EXCEPTION_IMPORT_ACTIVATION",
            shared::abi::WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
        ),
        (
            "WPK_FORK_EXCEPTION_IMPORT_BROKER_ENCODE",
            shared::abi::WPK_FORK_EXCEPTION_IMPORT_BROKER_ENCODE,
        ),
        (
            "WPK_FORK_EXCEPTION_IMPORT_BROKER_THROW_RECIPE",
            shared::abi::WPK_FORK_EXCEPTION_IMPORT_BROKER_THROW_RECIPE,
        ),
        (
            "WPK_FORK_EXCEPTION_IMPORT_CACHE_INDEX",
            shared::abi::WPK_FORK_EXCEPTION_IMPORT_CACHE_INDEX,
        ),
        (
            "WPK_FORK_EXCEPTION_IMPORT_CLAIM",
            shared::abi::WPK_FORK_EXCEPTION_IMPORT_CLAIM,
        ),
        (
            "WPK_FORK_EXCEPTION_IMPORT_DEFINE",
            shared::abi::WPK_FORK_EXCEPTION_IMPORT_DEFINE,
        ),
        (
            "WPK_FORK_EXCEPTION_IMPORT_INGRESS_THROW",
            shared::abi::WPK_FORK_EXCEPTION_IMPORT_INGRESS_THROW,
        ),
        (
            "WPK_FORK_EXCEPTION_IMPORT_LOAD",
            shared::abi::WPK_FORK_EXCEPTION_IMPORT_LOAD,
        ),
        (
            "WPK_FORK_EXCEPTION_IMPORT_LOOKUP",
            shared::abi::WPK_FORK_EXCEPTION_IMPORT_LOOKUP,
        ),
        (
            "WPK_FORK_EXCEPTION_IMPORT_ROUTE",
            shared::abi::WPK_FORK_EXCEPTION_IMPORT_ROUTE,
        ),
        (
            "WPK_FORK_EXCEPTION_EXPORT_ABORT",
            shared::abi::WPK_FORK_EXCEPTION_EXPORT_ABORT,
        ),
        (
            "WPK_FORK_EXCEPTION_EXPORT_CLEAR",
            shared::abi::WPK_FORK_EXCEPTION_EXPORT_CLEAR,
        ),
        (
            "WPK_FORK_EXCEPTION_EXPORT_DECODE",
            shared::abi::WPK_FORK_EXCEPTION_EXPORT_DECODE,
        ),
        (
            "WPK_FORK_EXCEPTION_EXPORT_ENCODE",
            shared::abi::WPK_FORK_EXCEPTION_EXPORT_ENCODE,
        ),
        (
            "WPK_FORK_EXCEPTION_EXPORT_ENCODE_INGRESS",
            shared::abi::WPK_FORK_EXCEPTION_EXPORT_ENCODE_INGRESS,
        ),
        (
            "WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE",
            shared::abi::WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE,
        ),
        (
            "WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE",
            shared::abi::WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE,
        ),
        (
            "WPK_FORK_EXCEPTION_EXPORT_THROW_SLOT",
            shared::abi::WPK_FORK_EXCEPTION_EXPORT_THROW_SLOT,
        ),
        (
            "WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT",
            shared::abi::WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT,
        ),
        (
            "WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND",
            shared::abi::WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND,
        ),
        (
            "WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE",
            shared::abi::WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE,
        ),
        (
            "WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT",
            shared::abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT,
        ),
        (
            "WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK",
            shared::abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK,
        ),
        (
            "WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE",
            shared::abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE,
        ),
        (
            "WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED",
            shared::abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED,
        ),
        (
            "WPK_FORK_EXPORT_MODULE_BOOTSTRAP",
            shared::abi::WPK_FORK_EXPORT_MODULE_BOOTSTRAP,
        ),
        (
            "WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE",
            shared::abi::WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE,
        ),
        (
            "WPK_FORK_EXPORT_MODULE_STATE_RESTORE",
            shared::abi::WPK_FORK_EXPORT_MODULE_STATE_RESTORE,
        ),
        (
            "WPK_FORK_EXPORT_MODULE_STATE_SAVE",
            shared::abi::WPK_FORK_EXPORT_MODULE_STATE_SAVE,
        ),
        (
            "WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP",
            shared::abi::WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP,
        ),
        (
            "WPK_FORK_EXPORT_RESUME_START",
            shared::abi::WPK_FORK_EXPORT_RESUME_START,
        ),
        (
            "WPK_FORK_EXPORT_RESUME_THREAD",
            shared::abi::WPK_FORK_EXPORT_RESUME_THREAD,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_DECODE_ANYREF",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_DECODE_ANYREF,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_DECODE_EXNREF",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_DECODE_EXNREF,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_DECODE_EXTERNREF",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_DECODE_EXTERNREF,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_DECODE_FUNCREF",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_DECODE_FUNCREF,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_ENCODE_ANYREF",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_ENCODE_ANYREF,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_ENCODE_EXNREF",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_ENCODE_EXNREF,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_ENCODE_EXTERNREF",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_ENCODE_EXTERNREF,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_ENCODE_FUNCREF",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_ENCODE_FUNCREF,
        ),
        (
            "WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE",
            shared::abi::WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_BROKER_ENCODE",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_BROKER_ENCODE,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_CLAIM",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_CLAIM,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_DEFINE",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_DEFINE,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_I31",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_I31,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_LOAD",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_LOAD,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_LOOKUP",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_LOOKUP,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_PAYLOAD_LEN",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_PAYLOAD_LEN,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_BEGIN",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_BEGIN,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_END",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_END,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_REF",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_REF,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_ROUTE",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_ROUTE,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT,
        ),
        (
            "WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE",
            shared::abi::WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE,
        ),
        (
            "WPK_FORK_REFERENCE_EXPORT_GC_ENCODE_SLOT",
            shared::abi::WPK_FORK_REFERENCE_EXPORT_GC_ENCODE_SLOT,
        ),
        (
            "WPK_FORK_REFERENCE_EXPORT_GC_FILL",
            shared::abi::WPK_FORK_REFERENCE_EXPORT_GC_FILL,
        ),
        (
            "WPK_FORK_REFERENCE_EXPORT_GC_PUBLISH_EXTERNREF",
            shared::abi::WPK_FORK_REFERENCE_EXPORT_GC_PUBLISH_EXTERNREF,
        ),
        (
            "WPK_FORK_REFERENCE_EXPORT_GC_PROBE",
            shared::abi::WPK_FORK_REFERENCE_EXPORT_GC_PROBE,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_SCRATCH_RELEASE",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_SCRATCH_RELEASE,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_SCRATCH_RESERVE",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_SCRATCH_RESERVE,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_VECTOR_APPEND",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_VECTOR_APPEND,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_VECTOR_BEGIN",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_VECTOR_BEGIN,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_VECTOR_FINISH",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_VECTOR_FINISH,
        ),
        (
            "WPK_FORK_REFERENCE_IMPORT_VECTOR_GET",
            shared::abi::WPK_FORK_REFERENCE_IMPORT_VECTOR_GET,
        ),
    ] {
        out.push_str(&format!("export const {name} = {value:?} as const;\n"));
    }
    out.push_str(&format!(
        "export const PROCESS_FORK_MODE_FORK = {} as const;\n",
        shared::fork_contract::MODE_FORK,
    ));
    out.push_str(&format!(
        "export const PROCESS_FORK_MODE_VFORK = {} as const;\n",
        shared::fork_contract::MODE_VFORK,
    ));
    out.push_str(
        "export type ProcessForkMode =\n  | typeof PROCESS_FORK_MODE_FORK\n  | typeof PROCESS_FORK_MODE_VFORK;\n",
    );
    let process_fork_import = shared::abi::WPK_FORK_PROCESS_IMPORT;
    out.push_str(&format!(
        "export const WPK_FORK_PROCESS_IMPORT = {{ module: {:?}, name: {:?}, params: {}, results: {} }} as const;\n",
        process_fork_import.module,
        process_fork_import.name,
        render_ts_program_artifact_types(process_fork_import.params),
        render_ts_program_artifact_types(process_fork_import.results),
    ));
    let heap_safepoint_import = shared::abi::HEAP_SAFEPOINT_PROCESS_IMPORT;
    out.push_str(&format!(
        "export const HEAP_SAFEPOINT_PROCESS_IMPORT = {{ module: {:?}, name: {:?}, params: {}, results: {} }} as const;\n",
        heap_safepoint_import.module,
        heap_safepoint_import.name,
        render_ts_program_artifact_types(heap_safepoint_import.params),
        render_ts_program_artifact_types(heap_safepoint_import.results),
    ));
    out.push_str(
        "/** The `env` imports the host supplies to user programs (besides the fork runtime's). */\n",
    );
    out.push_str("export const HOST_ENV_IMPORTS = [\n");
    {
        let mut list: Vec<&shared::abi::HostEnvImport> =
            shared::abi::HOST_ENV_IMPORTS.iter().collect();
        list.sort_by_key(|i| i.name);
        for i in list {
            out.push_str(&format!(
                "  {{ name: \"{}\", kind: \"{}\", linkTime: {} }},\n",
                i.name,
                i.kind.as_str(),
                i.link_time
            ));
        }
    }
    out.push_str("] as const;\n\n");
    out.push_str("export const WPK_FORK_REQUIRED_IMPORTS = [\n");
    for requirement in shared::abi::WPK_FORK_REQUIRED_IMPORTS {
        out.push_str(&format!(
            "  {{ module: {:?}, name: {:?}, params: {}, results: {} }},\n",
            requirement.module,
            requirement.name,
            render_ts_program_artifact_types(requirement.params),
            render_ts_program_artifact_types(requirement.results),
        ));
    }
    out.push_str("] as const;\n");
    out.push_str("export const WPK_FORK_REQUIRED_TABLE_IMPORTS = [\n");
    for requirement in shared::abi::WPK_FORK_REQUIRED_TABLE_IMPORTS {
        out.push_str(&format!(
            "  {{ module: {:?}, name: {:?}, table64: {}, element: {:?}, minimum: {}, maximum: {} }},\n",
            requirement.module,
            requirement.name,
            requirement.table64,
            program_artifact_type_name(requirement.element),
            requirement.minimum,
            requirement
                .maximum
                .map_or_else(|| "null".to_owned(), |maximum| maximum.to_string()),
        ));
    }
    out.push_str("] as const;\n");
    out.push_str("export const WPK_FORK_GLOBAL_IMPORTS = [\n");
    for import in shared::abi::WPK_FORK_GLOBAL_IMPORTS {
        out.push_str(&format!(
            "  {{ module: {:?}, name: {:?}, value: {:?} }},\n",
            import.module,
            import.name,
            program_artifact_type_name(import.value),
        ));
    }
    out.push_str("] as const;\n");
    out.push_str("export const WPK_FORK_REQUIRED_EXPORTS = [\n");
    for requirement in shared::abi::WPK_FORK_REQUIRED_EXPORTS {
        out.push_str(&format!(
            "  {{ name: {:?}, params: {}, results: {} }},\n",
            requirement.name,
            render_ts_program_artifact_types(requirement.params),
            render_ts_program_artifact_types(requirement.results),
        ));
    }
    out.push_str("] as const;\n\n");
    out.push_str(&format!(
        "export const SCHED_AFFINITY_MASK_SIZE = {} as const;\n\n",
        shared::SCHED_AFFINITY_MASK_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_SNAPSHOT_COUNT_OFFSET = {} as const;\n",
        shared::process_snapshot_wire::COUNT_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SNAPSHOT_COUNT_BYTES = {} as const;\n",
        shared::process_snapshot_wire::COUNT_BYTES
    ));
    out.push_str(&format!(
        "export const PROCESS_SNAPSHOT_RECORDS_OFFSET = {} as const;\n",
        shared::process_snapshot_wire::RECORDS_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SNAPSHOT_HEADER_BYTES = {} as const;\n",
        shared::process_snapshot_wire::HEADER_BYTES
    ));
    out.push_str(&format!(
        "export const PROCESS_SNAPSHOT_PID_OFFSET = {} as const;\n",
        shared::process_snapshot_wire::PID_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SNAPSHOT_PPID_OFFSET = {} as const;\n",
        shared::process_snapshot_wire::PPID_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SNAPSHOT_UID_OFFSET = {} as const;\n",
        shared::process_snapshot_wire::UID_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SNAPSHOT_GID_OFFSET = {} as const;\n",
        shared::process_snapshot_wire::GID_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SNAPSHOT_VSIZE_OFFSET = {} as const;\n",
        shared::process_snapshot_wire::VSIZE_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SNAPSHOT_STATE_OFFSET = {} as const;\n",
        shared::process_snapshot_wire::STATE_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SNAPSHOT_COMM_LEN_OFFSET = {} as const;\n",
        shared::process_snapshot_wire::COMM_LEN_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SNAPSHOT_CMDLINE_LEN_OFFSET = {} as const;\n\n",
        shared::process_snapshot_wire::CMDLINE_LEN_OFFSET
    ));
    out.push_str(&format!(
        "export const WAKEUP_EVENT_RECORD_BYTES = {} as const;\n",
        shared::wakeup_event_wire::RECORD_BYTES
    ));
    out.push_str("export const WAKEUP_EVENT_TYPES = {\n");
    for event_type in wakeup_event_types() {
        out.push_str(&format!("  {}: {},\n", event_type.name, event_type.bit));
    }
    out.push_str("} as const;\n");
    out.push_str("export const WAKEUP_EVENT_FIELDS = {\n");
    for field in wakeup_event_fields() {
        out.push_str(&format!(
            "  {}: {{ offset: {}, size: {}, type: {:?} }},\n",
            field.name, field.offset, field.size, field.ty
        ));
    }
    out.push_str("} as const;\n\n");
    out.push_str(&render_ts_wait_completion_wire());
    out.push_str("export const POLL_EVENTS = {\n");
    for (name, value) in poll_events() {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str("} as const;\n\n");
    out.push_str("export const EPOLL_EVENTS = {\n");
    for (name, value) in epoll_events() {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str("} as const;\n\n");
    out.push_str(
        "/* Facts a host network engine reports over `host_net_readiness`.\n\
         * The host reports these; the kernel alone decides `revents` from\n\
         * them (runtime_core::net_readiness::stream_revents). */\n",
    );
    out.push_str("export const NET_READINESS = {\n");
    for (name, value) in net_readiness_facts() {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str(&format!(
        "  ERRNO_SHIFT: {},\n  FLAG_MASK: {},\n",
        shared::net_readiness::ERRNO_SHIFT,
        shared::net_readiness::FLAG_MASK,
    ));
    out.push_str("} as const;\n\n");
    out.push_str("export const OPEN_FLAGS = {\n");
    for (name, value) in open_flags() {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str("} as const;\n\n");
    out.push_str("export const AT_FLAGS = {\n");
    for (name, value) in at_flags() {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str("} as const;\n\n");
    out.push_str("export const FD_FLAGS = {\n");
    for (name, value) in fd_flags() {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str("} as const;\n\n");
    out.push_str("export const FCNTL_COMMANDS = {\n");
    for (name, value) in fcntl_commands() {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str("} as const;\n\n");
    out.push_str("export const ACCESS_MODES = {\n");
    for (name, value) in access_modes() {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str("} as const;\n\n");
    out.push_str("export const STATFS_FLAGS = {\n");
    for (name, value) in statfs_flags() {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str("} as const;\n\n");
    out.push_str("export const FILE_MODES = {\n");
    for (name, value) in file_modes() {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str("} as const;\n\n");
    out.push_str("export const DIRENT_TYPES = {\n");
    for (name, value) in dirent_types() {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str("} as const;\n\n");
    out.push_str("export const SEEK_WHENCE = {\n");
    for (name, value) in seek_whence() {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str("} as const;\n\n");
    out.push_str(&format!(
        "export const KERNEL_SCRATCH_SIGNAL_DELIVERY_BYTES = {} as const;\n",
        shared::kernel_scratch_wire::SIGNAL_DELIVERY_BYTES
    ));
    out.push_str(&format!(
        "export const KERNEL_SCRATCH_FD_PAIR_BYTES = {} as const;\n",
        shared::kernel_scratch_wire::FD_PAIR_BYTES
    ));
    out.push_str(&format!(
        "export const KERNEL_SCRATCH_MQUEUE_NOTIFICATION_BYTES = {} as const;\n",
        shared::kernel_scratch_wire::MQUEUE_NOTIFICATION_BYTES
    ));
    out.push_str(&format!(
        "export const KERNEL_SCRATCH_SOCKLEN_BYTES = {} as const;\n",
        shared::kernel_scratch_wire::SOCKLEN_BYTES
    ));
    out.push_str(&format!(
        "export const KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES = {} as const;\n",
        shared::kernel_scratch_wire::SOCKADDR_STORAGE_BYTES
    ));
    out.push_str(&format!(
        "export const KERNEL_SCRATCH_SOCKADDR_UNIX_BYTES = {} as const;\n",
        shared::kernel_scratch_wire::SOCKADDR_UNIX_BYTES
    ));
    out.push_str(&format!(
        "export const KERNEL_SCRATCH_SOCKADDR_UNIX_PATH_OFFSET_BYTES = {} as const;\n",
        shared::kernel_scratch_wire::SOCKADDR_UNIX_PATH_OFFSET_BYTES
    ));
    out.push_str(&format!(
        "export const KERNEL_SCRATCH_SOCKADDR_UNIX_PATH_BYTES = {} as const;\n",
        shared::kernel_scratch_wire::SOCKADDR_UNIX_PATH_BYTES
    ));
    out.push_str(&format!(
        "export const KERNEL_SCRATCH_SOCKET_OPTION_MAX_BYTES = {} as const;\n",
        shared::kernel_scratch_wire::SOCKET_OPTION_MAX_BYTES
    ));
    out.push_str(&format!(
        "export const KERNEL_SCRATCH_SOCKET_OPTION_INPUT_MAX_BYTES = {} as const;\n",
        shared::kernel_scratch_wire::SOCKET_OPTION_INPUT_MAX_BYTES
    ));
    out.push_str(&format!(
        "export const PR_SET_NAME = {} as const;\n",
        shared::prctl::PR_SET_NAME
    ));
    out.push_str(&format!(
        "export const PR_GET_NAME = {} as const;\n",
        shared::prctl::PR_GET_NAME
    ));
    out.push_str(&format!(
        "export const PRCTL_NAME_BYTES = {} as const;\n",
        shared::kernel_scratch_wire::PRCTL_NAME_BYTES
    ));
    out.push_str(&format!(
        "export const FCNTL_FLOCK_BYTES = {} as const;\n",
        shared::kernel_scratch_wire::FCNTL_FLOCK_BYTES
    ));
    out.push_str(&format!(
        "export const SIGNAL_MASK_BYTES = {} as const;\n\n",
        shared::kernel_scratch_wire::SIGNAL_MASK_BYTES
    ));
    out.push_str(&format!(
        "export const POSIX_ARG_MAX_BYTES = {} as const;\n",
        shared::platform_limits::ARG_MAX_BYTES
    ));
    out.push_str(&format!(
        "export const POSIX_PATH_MAX_BYTES = {} as const;\n",
        shared::platform_limits::PATH_MAX_BYTES
    ));
    out.push_str(&format!(
        "export const POSIX_NAME_MAX_BYTES = {} as const;\n",
        shared::platform_limits::NAME_MAX_BYTES
    ));
    out.push_str(&format!(
        "export const XATTR_SIZE_MAX_BYTES = {} as const;\n",
        shared::platform_limits::XATTR_SIZE_MAX_BYTES
    ));
    out.push_str(&format!(
        "export const PROCESS_METADATA_ENTRY_MAX_BYTES = {} as const;\n",
        shared::platform_limits::PROCESS_METADATA_ENTRY_MAX_BYTES
    ));
    out.push_str(&format!(
        "export const PROCESS_STARTUP_MAX_ARGV_COUNT = {} as const;\n",
        shared::platform_limits::PROCESS_STARTUP_MAX_ARGV_COUNT
    ));
    out.push_str(&format!(
        "export const PROCESS_STARTUP_MAX_ENVP_COUNT = {} as const;\n",
        shared::platform_limits::PROCESS_STARTUP_MAX_ENVP_COUNT
    ));
    out.push_str(&format!(
        "export const PROCESS_METADATA_KIND_ARGV = {} as const;\n",
        shared::process_metadata_contract::KIND_ARGV
    ));
    out.push_str(&format!(
        "export const PROCESS_METADATA_KIND_ENVIRONMENT = {} as const;\n",
        shared::process_metadata_contract::KIND_ENVIRONMENT
    ));
    out.push_str(&format!(
        "export const POSIX_NGROUPS_MAX = {} as const;\n",
        shared::platform_limits::NGROUPS_MAX
    ));
    out.push_str(&format!(
        "export const SYSV_MSG_MAX_BYTES = {} as const;\n",
        shared::platform_limits::SYSV_MSG_MAX_BYTES
    ));
    out.push_str(&format!(
        "export const MAX_REPORTABLE_TRANSFER_BYTES = {} as const;\n",
        shared::platform_limits::MAX_REPORTABLE_TRANSFER_BYTES
    ));
    out.push_str(&format!(
        "export const MAX_TRANSFER_ALLOCATION_BYTES = {} as const;\n",
        shared::platform_limits::MAX_TRANSFER_ALLOCATION_BYTES
    ));
    out.push_str(&format!(
        "export const POSIX_IOV_MAX = {} as const;\n",
        shared::platform_limits::IOV_MAX
    ));
    out.push_str(&format!(
        "export const SELECT_FD_SETSIZE = {} as const;\n",
        shared::select::FD_SETSIZE
    ));
    out.push_str(&format!(
        "export const SELECT_FD_SET_BYTES = {} as const;\n",
        shared::select::FD_SET_BYTES
    ));
    out.push_str(&format!(
        "export const PROCESS_IOVEC_WASM32_SIZE = {} as const;\n",
        shared::process_layout::iovec::WASM32_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_IOVEC_WASM32_BASE_OFFSET = {} as const;\n",
        shared::process_layout::iovec::WASM32_BASE_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_IOVEC_WASM32_LEN_OFFSET = {} as const;\n",
        shared::process_layout::iovec::WASM32_LEN_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_IOVEC_WASM64_SIZE = {} as const;\n",
        shared::process_layout::iovec::WASM64_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_IOVEC_WASM64_BASE_OFFSET = {} as const;\n",
        shared::process_layout::iovec::WASM64_BASE_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_IOVEC_WASM64_LEN_OFFSET = {} as const;\n",
        shared::process_layout::iovec::WASM64_LEN_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM32_SIZE = {} as const;\n",
        shared::process_layout::msghdr::WASM32_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM32_NAME_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM32_NAME_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM32_NAMELEN_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM32_NAMELEN_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM32_IOV_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM32_IOV_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM32_IOVLEN_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM32_IOVLEN_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM32_CONTROL_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM32_CONTROL_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM32_CONTROLLEN_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM32_CONTROLLEN_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM32_FLAGS_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM32_FLAGS_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM64_SIZE = {} as const;\n",
        shared::process_layout::msghdr::WASM64_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM64_NAME_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM64_NAME_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM64_NAMELEN_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM64_NAMELEN_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM64_IOV_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM64_IOV_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM64_IOVLEN_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM64_IOVLEN_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM64_CONTROL_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM64_CONTROL_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM64_CONTROLLEN_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM64_CONTROLLEN_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_MSGHDR_WASM64_FLAGS_OFFSET = {} as const;\n",
        shared::process_layout::msghdr::WASM64_FLAGS_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_CMSGHDR_WASM32_SIZE = {} as const;\n",
        shared::process_layout::cmsghdr::WASM32_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_CMSGHDR_WASM32_ALIGN = {} as const;\n",
        shared::process_layout::cmsghdr::WASM32_ALIGN
    ));
    out.push_str(&format!(
        "export const PROCESS_CMSGHDR_WASM32_LEN_OFFSET = {} as const;\n",
        shared::process_layout::cmsghdr::WASM32_LEN_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_CMSGHDR_WASM32_LEVEL_OFFSET = {} as const;\n",
        shared::process_layout::cmsghdr::WASM32_LEVEL_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_CMSGHDR_WASM32_TYPE_OFFSET = {} as const;\n",
        shared::process_layout::cmsghdr::WASM32_TYPE_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_CMSGHDR_WASM32_DATA_OFFSET = {} as const;\n",
        shared::process_layout::cmsghdr::WASM32_DATA_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_CMSGHDR_WASM64_SIZE = {} as const;\n",
        shared::process_layout::cmsghdr::WASM64_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_CMSGHDR_WASM64_ALIGN = {} as const;\n",
        shared::process_layout::cmsghdr::WASM64_ALIGN
    ));
    out.push_str(&format!(
        "export const PROCESS_CMSGHDR_WASM64_LEN_OFFSET = {} as const;\n",
        shared::process_layout::cmsghdr::WASM64_LEN_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_CMSGHDR_WASM64_LEVEL_OFFSET = {} as const;\n",
        shared::process_layout::cmsghdr::WASM64_LEVEL_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_CMSGHDR_WASM64_TYPE_OFFSET = {} as const;\n",
        shared::process_layout::cmsghdr::WASM64_TYPE_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_CMSGHDR_WASM64_DATA_OFFSET = {} as const;\n",
        shared::process_layout::cmsghdr::WASM64_DATA_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_GROUP_REQ_WASM32_SIZE = {} as const;\n",
        shared::process_layout::multicast_group_request::WASM32_GROUP_REQ_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_GROUP_REQ_WASM32_GROUP_OFFSET = {} as const;\n",
        shared::process_layout::multicast_group_request::WASM32_GROUP_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_GROUP_SOURCE_REQ_WASM32_SIZE = {} as const;\n",
        shared::process_layout::multicast_group_request::WASM32_GROUP_SOURCE_REQ_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_GROUP_SOURCE_REQ_WASM32_SOURCE_OFFSET = {} as const;\n",
        shared::process_layout::multicast_group_request::WASM32_SOURCE_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_GROUP_REQ_WASM64_SIZE = {} as const;\n",
        shared::process_layout::multicast_group_request::WASM64_GROUP_REQ_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_GROUP_REQ_WASM64_GROUP_OFFSET = {} as const;\n",
        shared::process_layout::multicast_group_request::WASM64_GROUP_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_GROUP_SOURCE_REQ_WASM64_SIZE = {} as const;\n",
        shared::process_layout::multicast_group_request::WASM64_GROUP_SOURCE_REQ_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_GROUP_SOURCE_REQ_WASM64_SOURCE_OFFSET = {} as const;\n",
        shared::process_layout::multicast_group_request::WASM64_SOURCE_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_SIGNO_OFFSET = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::SIGNO_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_ERRNO_OFFSET = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::ERRNO_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_CODE_OFFSET = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::CODE_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_WASM32_SIZE = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::WASM32_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_WASM32_PID_OFFSET = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::WASM32_PID_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_WASM32_UID_OFFSET = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::WASM32_UID_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_WASM32_VALUE_OFFSET = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::WASM32_VALUE_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_WASM32_VALUE_SIZE = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::WASM32_VALUE_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_WASM64_SIZE = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::WASM64_SIZE
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_WASM64_PID_OFFSET = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::WASM64_PID_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_WASM64_UID_OFFSET = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::WASM64_UID_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_WASM64_VALUE_OFFSET = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::WASM64_VALUE_OFFSET
    ));
    out.push_str(&format!(
        "export const PROCESS_SIGINFO_WASM64_VALUE_SIZE = {} as const;\n",
        shared::process_layout::rt_sigqueueinfo::WASM64_VALUE_SIZE
    ));
    out.push_str(&format!(
        "export const SOCKET_SOL_SOCKET = {} as const;\n",
        shared::socket::SOL_SOCKET
    ));
    out.push_str(&format!(
        "export const SOCKET_SCM_RIGHTS = {} as const;\n",
        shared::socket::SCM_RIGHTS
    ));
    out.push_str(&format!(
        "export const SOCKET_MSG_TRUNC = {} as const;\n",
        shared::socket::MSG_TRUNC
    ));
    out.push_str(&format!(
        "export const SCM_RIGHTS_FD_BYTES = {} as const;\n",
        shared::socket::SCM_RIGHTS_FD_BYTES
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_HEADER_BYTES = {} as const;\n",
        shared::spawn_contract::WIRE_HEADER_BYTES
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_STRING_OFFSET_BYTES = {} as const;\n",
        shared::spawn_contract::WIRE_STRING_OFFSET_BYTES
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_HEADER_ARGC_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_HEADER_ARGC_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_HEADER_ENVC_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_HEADER_ENVC_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_HEADER_ACTION_COUNT_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_HEADER_ACTION_COUNT_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_HEADER_ATTR_FLAGS_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_HEADER_ATTR_FLAGS_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_HEADER_PGRP_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_HEADER_PGRP_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_HEADER_PAD_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_HEADER_PAD_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_HEADER_SIGDEF_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_HEADER_SIGDEF_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_HEADER_SIGMASK_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_HEADER_SIGMASK_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_ACTION_RECORD_BYTES = {} as const;\n",
        shared::spawn_contract::WIRE_ACTION_RECORD_BYTES
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_ACTION_OP_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_ACTION_OP_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_ACTION_FD_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_ACTION_FD_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_ACTION_NEWFD_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_ACTION_NEWFD_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_ACTION_PATH_OFF_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_ACTION_PATH_OFF_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_ACTION_PATH_LEN_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_ACTION_PATH_LEN_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_ACTION_OFLAG_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_ACTION_OFLAG_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_ACTION_MODE_OFFSET = {} as const;\n",
        shared::spawn_contract::WIRE_ACTION_MODE_OFFSET
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_OP_OPEN = {} as const;\n",
        shared::spawn_contract::WIRE_OP_OPEN
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_OP_CLOSE = {} as const;\n",
        shared::spawn_contract::WIRE_OP_CLOSE
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_OP_DUP2 = {} as const;\n",
        shared::spawn_contract::WIRE_OP_DUP2
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_OP_CHDIR = {} as const;\n",
        shared::spawn_contract::WIRE_OP_CHDIR
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_OP_FCHDIR = {} as const;\n",
        shared::spawn_contract::WIRE_OP_FCHDIR
    ));
    out.push_str(&format!(
        "export const SPAWN_ATTR_RESETIDS = {} as const;\n",
        shared::spawn_contract::ATTR_RESETIDS
    ));
    out.push_str(&format!(
        "export const SPAWN_ATTR_SETPGROUP = {} as const;\n",
        shared::spawn_contract::ATTR_SETPGROUP
    ));
    out.push_str(&format!(
        "export const SPAWN_ATTR_SETSIGDEF = {} as const;\n",
        shared::spawn_contract::ATTR_SETSIGDEF
    ));
    out.push_str(&format!(
        "export const SPAWN_ATTR_SETSIGMASK = {} as const;\n",
        shared::spawn_contract::ATTR_SETSIGMASK
    ));
    out.push_str(&format!(
        "export const SPAWN_ATTR_SETSCHEDPARAM = {} as const;\n",
        shared::spawn_contract::ATTR_SETSCHEDPARAM
    ));
    out.push_str(&format!(
        "export const SPAWN_ATTR_SETSCHEDULER = {} as const;\n",
        shared::spawn_contract::ATTR_SETSCHEDULER
    ));
    out.push_str(&format!(
        "export const SPAWN_ATTR_USEVFORK = {} as const;\n",
        shared::spawn_contract::ATTR_USEVFORK
    ));
    out.push_str(&format!(
        "export const SPAWN_ATTR_SETSID = {} as const;\n",
        shared::spawn_contract::ATTR_SETSID
    ));
    out.push_str(&format!(
        "export const SPAWN_MAX_ARGV_COUNT = {} as const;\n",
        shared::spawn_contract::MAX_ARGV_COUNT
    ));
    out.push_str(&format!(
        "export const SPAWN_MAX_ENVP_COUNT = {} as const;\n",
        shared::spawn_contract::MAX_ENVP_COUNT
    ));
    out.push_str(&format!(
        "export const SPAWN_MAX_ACTION_COUNT = {} as const;\n",
        shared::spawn_contract::MAX_ACTION_COUNT
    ));
    out.push_str(&format!(
        "export const SPAWN_WIRE_MAX_BYTES = {} as const;\n\n",
        shared::spawn_contract::WIRE_MAX_BYTES
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

    out.push_str(&format!(
        "export const HOST_ADAPTER_KERNEL_EXPORT_LIFECYCLES = {} as const;\n\n",
        serde_json::to_string_pretty(&host_adapter_kernel_export_lifecycles())
            .expect("serialize kernel export lifecycles")
    ));

    render_pcm_ts_bindings(&mut out);

    render_input_ts_bindings(&mut out);

    render_clipboard_ts_bindings(&mut out);

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
        "export const CHANNEL_STATUS_ERROR = {} as const;\n",
        shared::ChannelStatus::Error as u32
    ));
    out.push_str(&format!(
        "export const CHANNEL_STATUS_TEARDOWN = {} as const;\n\n",
        shared::ChannelStatus::Teardown as u32
    ));

    out.push_str("export const CHANNEL_STATUS = {\n");
    out.push_str("  Idle: CHANNEL_STATUS_IDLE,\n");
    out.push_str("  Pending: CHANNEL_STATUS_PENDING,\n");
    out.push_str("  Complete: CHANNEL_STATUS_COMPLETE,\n");
    out.push_str("  Error: CHANNEL_STATUS_ERROR,\n");
    out.push_str("  Teardown: CHANNEL_STATUS_TEARDOWN,\n");
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
        "export const CH_REQUEST_FLAGS = {} as const;\n",
        channel::REQUEST_FLAGS_OFFSET
    ));
    out.push_str(&format!(
        "export const CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY = {} as const;\n",
        channel::REQUEST_FLAG_DEFER_SIGNAL_DELIVERY
    ));
    out.push_str(&format!(
        "export const CHANNEL_REQUEST_FLAG_CANCELLATION_POINT = {} as const;\n",
        channel::REQUEST_FLAG_CANCELLATION_POINT
    ));
    out.push_str(&format!(
        "export const CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED = {} as const;\n",
        channel::REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED
    ));
    out.push_str(&format!(
        "export const CHANNEL_REQUEST_FLAG_OPAQUE_RECORD = {} as const;\n",
        channel::REQUEST_FLAG_OPAQUE_RECORD
    ));
    out.push_str(&format!(
        "export const CHANNEL_REQUEST_FLAGS_KNOWN_MASK = {} as const;\n",
        channel::REQUEST_FLAGS_KNOWN_MASK
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
        "export const PROCESS_MEMORY_FORK_SAVE_CONTROL_PREFIX_SIZE = {} as const;\n",
        shared::process_memory::FORK_SAVE_CONTROL_PREFIX_SIZE
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
        "export const CH_SIG_AREA_SIZE = {} as const;\n",
        channel::SIG_AREA_SIZE
    ));
    out.push_str(&format!(
        "export const CH_SIG_DELIVERY_SIZE = {} as const;\n",
        channel::SIG_DELIVERY_SIZE
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
        "export const CH_SIG_SI_VALUE = {} as const;\n",
        channel::SIG_SI_VALUE
    ));
    out.push_str(&format!(
        "export const CH_SIG_OLD_MASK = {} as const;\n",
        channel::SIG_OLD_MASK
    ));
    out.push_str(&format!(
        "export const CH_SIG_SI_CODE = {} as const;\n",
        channel::SIG_SI_CODE
    ));
    out.push_str(&format!(
        "export const CH_SIGINFO_WORD_1 = {} as const;\n",
        channel::SIGINFO_WORD_1
    ));
    out.push_str(&format!(
        "export const CH_SIGINFO_WORD_2 = {} as const;\n",
        channel::SIGINFO_WORD_2
    ));
    out.push_str(&format!(
        "export const CH_SIG_ALT_SP = {} as const;\n",
        channel::SIG_ALT_SP
    ));
    out.push_str(&format!(
        "export const CH_SIG_ALT_SIZE = {} as const;\n\n",
        channel::SIG_ALT_SIZE
    ));
    out.push_str(&format!(
        "export const SIGNAL_ACTION_RESTART = {} as const;\n\n",
        shared::signal::SA_RESTART
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
        "export const WASM_DIRENT_INO_OFFSET = {} as const;\n",
        offset_of!(shared::WasmDirent, d_ino)
    ));
    out.push_str(&format!(
        "export const WASM_DIRENT_TYPE_OFFSET = {} as const;\n",
        offset_of!(shared::WasmDirent, d_type)
    ));
    out.push_str(&format!(
        "export const WASM_DIRENT_NAME_LENGTH_OFFSET = {} as const;\n",
        offset_of!(shared::WasmDirent, d_namlen)
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
        "export const WASM_POLL_FD_FD_OFFSET = {} as const;\n",
        offset_of!(shared::WasmPollFd, fd)
    ));
    out.push_str(&format!(
        "export const WASM_POLL_FD_EVENTS_OFFSET = {} as const;\n",
        offset_of!(shared::WasmPollFd, events)
    ));
    out.push_str(&format!(
        "export const WASM_POLL_FD_REVENTS_OFFSET = {} as const;\n",
        offset_of!(shared::WasmPollFd, revents)
    ));
    out.push_str(&format!(
        "export const STRUCT_SIZE_WASM_EPOLL_EVENT = {} as const;\n",
        size_of::<shared::WasmEpollEvent>()
    ));
    out.push_str(&format!(
        "export const WASM_EPOLL_EVENT_EVENTS_OFFSET = {} as const;\n",
        offset_of!(shared::WasmEpollEvent, events)
    ));
    out.push_str(&format!(
        "export const WASM_EPOLL_EVENT_PAD_OFFSET = {} as const;\n",
        offset_of!(shared::WasmEpollEvent, _pad)
    ));
    out.push_str(&format!(
        "export const WASM_EPOLL_EVENT_DATA_OFFSET = {} as const;\n",
        offset_of!(shared::WasmEpollEvent, data)
    ));
    out.push_str(&format!(
        "export const STRUCT_SIZE_WASM_SYSV_MESSAGE_HEADER = {} as const;\n",
        size_of::<shared::WasmSysvMessageHeader>()
    ));
    out.push_str(&format!(
        "export const STRUCT_SIZE_WASM_STATFS = {} as const;\n",
        size_of::<shared::WasmStatfs>()
    ));
    out.push_str(&format!(
        "export const STRUCT_SIZE_WPK_DRM_MODE_MODEINFO = {} as const;\n",
        size_of::<shared::dri::WpkDrmModeModeinfo>()
    ));
    out.push_str(&format!(
        "export const STRUCT_SIZE_WASM_RUSAGE_WIRE = {} as const;\n",
        size_of::<shared::WasmRusageWire>()
    ));
    out.push_str("
");

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

    out.push_str(
        "export type ChannelScalarSlotKind =\n\
         \x20 | \"i32\"\n\
         \x20 | \"u32\"\n\
         \x20 | \"exact-u32\"\n\
         \x20 | \"process-size\"\n\
         \x20 | \"process-address\"\n\
         \x20 | \"i64\"\n\
         \x20 | \"split-i64-low-u32\"\n\
         \x20 | \"split-i64-high-i32\";\n\
         export type ChannelResultKind = \"i32\" | \"i64\" | \"process-address\";\n\
         export type ChannelArgumentIndex = 0 | 1 | 2 | 3 | 4 | 5;\n\n\
         export const CHANNEL_SCALAR_DEFAULT_SLOT_KIND = \"i32\" as const;\n\
         export const CHANNEL_RESULT_DEFAULT_KIND = \"i32\" as const;\n\
         export const CHANNEL_SCALAR_SLOT_CONTRACTS: Readonly<\n\
         \x20 Record<number, Readonly<Partial<Record<ChannelArgumentIndex, ChannelScalarSlotKind>>>>\n\
         > = {\n",
    );
    for contract in shared::channel_scalar::SYSCALLS {
        if contract.arguments.is_empty() {
            continue;
        }
        out.push_str(&format!("  {}: {{", contract.syscall_number));
        for argument in contract.arguments {
            out.push_str(&format!(
                " {}: {:?},",
                argument.index,
                argument.kind.abi_name(),
            ));
        }
        out.push_str(" },\n");
    }
    out.push_str("} as const;\n");
    out.push_str(
        "export const CHANNEL_RESULT_CONTRACTS: Readonly<\n\
         \x20 Partial<Record<number, ChannelResultKind>>\n\
         > = {\n",
    );
    for contract in shared::channel_scalar::SYSCALLS {
        if contract.result == shared::channel_scalar::ChannelResultKind::I32 {
            continue;
        }
        out.push_str(&format!(
            "  {}: {:?},\n",
            contract.syscall_number,
            contract.result.abi_name(),
        ));
    }
    out.push_str("} as const;\n\n");

    out.push_str("export const PATHCONF_NAMES = {\n");
    for (name, number) in shared::pathconf::ABI_NAMES {
        out.push_str(&format!("  {name}: {number},\n"));
    }
    out.push_str("} as const;\n\n");

    // Errno values, POSITIVE as POSIX and `shared::Errno` define them.
    //
    // These had no generator while their neighbours (open flags, mode bits,
    // syscall names) had one, so the TypeScript filesystem and
    // `host/src/exec-target.ts` each hand-wrote the subset they needed.
    //
    // Consumers that follow the negated-errno convention must negate
    // explicitly; see `host/src/vfs/vfs-errors.ts`. Emitting the POSIX sign
    // and negating at one visible place beats baking a second convention into
    // the generated table.
    out.push_str("export const ERRNO = {\n");
    for value in 1u32..=256 {
        if let Some(errno) = shared::Errno::from_u32(value) {
            // `Debug` is the variant name; ENOTSUP aliases EOPNOTSUPP, so the
            // canonical name for a shared value appears once.
            out.push_str(&format!("  {:?}: {value},\n", errno));
        }
    }
    out.push_str("} as const;\n\n");

    out.push_str("export const ABI_SYSCALL_NAMES: Record<number, string> = {\n");
    for (number, name) in all_syscall_log_names() {
        out.push_str(&format!("  {number}: {name:?},\n"));
    }
    out.push_str("} as const;\n\n");

    out.push_str("export type SyscallArgDirection = \"in\" | \"out\" | \"inout\";\n\n");
    out.push_str("export type SyscallArgSizeSpec =\n");
    out.push_str("  | { type: \"cstring\"; maxBytes: number; tooLongErrno: number }\n");
    out.push_str("  | { type: \"arg\"; argIndex: number; multiplier?: number; add?: number }\n");
    out.push_str("  | { type: \"deref\"; argIndex: number }\n");
    out.push_str("  | { type: \"fixed\"; size: number }\n");
    out.push_str("  | { type: \"process-layout\"; wasm32Size: number; wasm64Size: number }\n");
    out.push_str("  | { type: \"kernel-dereferenced\" };\n\n");
    out.push_str("export type SyscallArgCopyOutLengthSpec =\n");
    out.push_str("  | { type: \"u32-field\"; argIndex: number; offset: number }\n");
    out.push_str(
        "  | { type: \"return-value\"; multiplier: number; maxValue: number };\n\n",
    );
    out.push_str("export interface SyscallArgDesc {\n");
    out.push_str("  argIndex: number;\n");
    out.push_str("  direction: SyscallArgDirection;\n");
    out.push_str("  size: SyscallArgSizeSpec;\n");
    out.push_str("  copyOutLength?: SyscallArgCopyOutLengthSpec;\n");
    out.push_str("  nullable?: boolean;\n");
    out.push_str("  required?: boolean;\n");
    out.push_str("}\n\n");

    out.push_str("export type IoctlArgKind = \"none\" | \"scalar-i32\" | \"pointer\";\n");
    out.push_str("export type IoctlDirection = \"none\" | \"in\" | \"out\" | \"inout\";\n\n");
    out.push_str("export interface IoctlRequestContract {\n");
    out.push_str("  argKind: IoctlArgKind;\n");
    out.push_str("  direction: IoctlDirection;\n");
    out.push_str("  wasm32Size: number | null;\n");
    out.push_str("  wasm64Size: number | null;\n");
    out.push_str("}\n\n");
    out.push_str("export const IOCTL_REQUESTS: Record<number, IoctlRequestContract> = {\n");
    for contract in shared::ioctl_contract::IOCTL_REQUEST_CONTRACTS {
        out.push_str(&format!(
            "  {}: {{ argKind: {:?}, direction: {:?}, wasm32Size: {}, wasm64Size: {} }},\n",
            contract.request,
            ioctl_arg_kind_name(contract.arg_kind),
            ioctl_direction_name(contract.direction),
            ts_optional_u32(contract.wasm32_size),
            ts_optional_u32(contract.wasm64_size),
        ));
    }
    out.push_str("};\n\n");

    out.push_str("export interface IoctlRequestFamily {\n");
    out.push_str("  dir: number;\n");
    out.push_str("  magic: number;\n");
    out.push_str("  nrFirst: number;\n");
    out.push_str("  nrLast: number;\n");
    out.push_str("  direction: IoctlDirection;\n");
    out.push_str("  fixedSize: number | null;\n");
    out.push_str("  maxCallerSize: number | null;\n");
    out.push_str("}\n\n");
    out.push_str("export const IOCTL_REQUEST_FAMILIES: IoctlRequestFamily[] = [\n");
    for family in shared::ioctl_contract::IOCTL_REQUEST_FAMILIES {
        let (fixed_size, max_caller_size) = match family.size {
            shared::ioctl_contract::IoctlFamilySize::Fixed(size) => (Some(size), None),
            shared::ioctl_contract::IoctlFamilySize::CallerEncoded { max } => (None, Some(max)),
        };
        out.push_str(&format!(
            "  {{ dir: {}, magic: {}, nrFirst: {}, nrLast: {}, direction: {:?}, \
fixedSize: {}, maxCallerSize: {} }},\n",
            family.dir,
            family.magic,
            family.nr_first,
            family.nr_last,
            ioctl_direction_name(family.direction),
            ts_optional_u32(fixed_size),
            ts_optional_u32(max_caller_size),
        ));
    }
    out.push_str("];\n\n");

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

fn render_ts_program_artifact_types(values: &[shared::abi::ProgramArtifactValueType]) -> String {
    let values = values
        .iter()
        .map(|value| format!("{:?}", program_artifact_type_name(*value)))
        .collect::<Vec<_>>()
        .join(", ");
    format!("[{values}]")
}

fn program_artifact_type_name(value: shared::abi::ProgramArtifactValueType) -> &'static str {
    use shared::abi::ProgramArtifactValueType;
    match value {
        ProgramArtifactValueType::Pointer => "ptr",
        ProgramArtifactValueType::I32 => "i32",
        ProgramArtifactValueType::I64 => "i64",
        ProgramArtifactValueType::FuncRef => "funcref",
        ProgramArtifactValueType::ExternRef => "externref",
        ProgramArtifactValueType::ExnRef => "exnref",
        ProgramArtifactValueType::AnyRef => "anyref",
    }
}

/// Emit every evdev event-type / SYN / KEY / BTN / REL / ABS code as a
/// single frozen `INPUT_CODES` object, sourced from the authoritative
/// `shared::input::CODE_TABLE`. The browser input translator and the
/// `KeyboardEvent.code` → `KEY_*` table import these values instead of
/// hand-redeclaring them, so a code renumber in `shared::input` flows to
/// the host through the generated ABI rather than silently diverging.
fn render_input_ts_bindings(out: &mut String) {
    out.push_str("export const INPUT_CODES = {\n");
    for (name, value) in shared::input::CODE_TABLE {
        out.push_str(&format!("  {}: {},\n", name, value));
    }
    out.push_str("} as const;\n\n");
}

fn render_pcm_ts_bindings(out: &mut String) {
    use shared::pcm;

    for (name, value) in [
        ("PCM_TRANSPORT_MAGIC", pcm::PCM_TRANSPORT_MAGIC),
        ("PCM_TRANSPORT_VERSION", pcm::PCM_TRANSPORT_VERSION),
        ("PCM_TRANSPORT_HEADER_BYTES", pcm::PCM_TRANSPORT_HEADER_BYTES),
        ("PCM_TRANSPORT_RING_BYTES", pcm::PCM_TRANSPORT_RING_BYTES),
        ("PCM_TRANSPORT_BYTES", pcm::PCM_TRANSPORT_BYTES),
        ("PCM_STATE_CLOSED", pcm::PCM_STATE_CLOSED),
        ("PCM_STATE_STOPPED", pcm::PCM_STATE_STOPPED),
        ("PCM_STATE_RUNNING", pcm::PCM_STATE_RUNNING),
        ("PCM_STATE_DRAINING", pcm::PCM_STATE_DRAINING),
        ("PCM_FORMAT_UNKNOWN", pcm::PCM_FORMAT_UNKNOWN),
        ("PCM_FORMAT_U8", pcm::PCM_FORMAT_U8),
        ("PCM_FORMAT_S16_LE", pcm::PCM_FORMAT_S16_LE),
        ("PCM_FORMAT_S16_BE", pcm::PCM_FORMAT_S16_BE),
        ("PCM_TRANSPORT_UNCLAIMED", pcm::PCM_TRANSPORT_UNCLAIMED),
        ("PCM_TRANSPORT_LEGACY_PULL", pcm::PCM_TRANSPORT_LEGACY_PULL),
        ("PCM_TRANSPORT_SHARED_CLOCK", pcm::PCM_TRANSPORT_SHARED_CLOCK),
        ("PCM_FLAG_CONFIGURING", pcm::PCM_FLAG_CONFIGURING),
        ("PCM_FLAG_UNDERRUN_ACTIVE", pcm::PCM_FLAG_UNDERRUN_ACTIVE),
        ("PCM_FLAG_FATAL_ERROR", pcm::PCM_FLAG_FATAL_ERROR),
    ] {
        out.push_str(&format!("export const {name} = {value} as const;\n"));
    }
    out.push('\n');

    out.push_str("export const PCM_SHARED_CONTROL_FIELDS = {\n");
    for (name, offset) in [
        ("magic", offset_of!(pcm::PcmSharedControl, magic)),
        ("version", offset_of!(pcm::PcmSharedControl, version)),
        ("headerBytes", offset_of!(pcm::PcmSharedControl, header_bytes)),
        ("physicalCapacityBytes", offset_of!(pcm::PcmSharedControl, physical_capacity_bytes)),
        ("activeCapacityBytes", offset_of!(pcm::PcmSharedControl, active_capacity_bytes)),
        ("format", offset_of!(pcm::PcmSharedControl, format)),
        ("sampleRate", offset_of!(pcm::PcmSharedControl, rate)),
        ("channels", offset_of!(pcm::PcmSharedControl, channels)),
        ("frameBytes", offset_of!(pcm::PcmSharedControl, frame_bytes)),
        ("fragmentBytes", offset_of!(pcm::PcmSharedControl, fragment_bytes)),
        ("fragments", offset_of!(pcm::PcmSharedControl, fragment_count)),
        ("state", offset_of!(pcm::PcmSharedControl, state)),
        ("generation", offset_of!(pcm::PcmSharedControl, generation)),
        ("flags", offset_of!(pcm::PcmSharedControl, flags)),
        ("transportMode", offset_of!(pcm::PcmSharedControl, transport_mode)),
        ("producerSeq", offset_of!(pcm::PcmSharedControl, producer_seq)),
        ("producerLo", offset_of!(pcm::PcmSharedControl, producer_lo)),
        ("producerHi", offset_of!(pcm::PcmSharedControl, producer_hi)),
        ("consumerSeq", offset_of!(pcm::PcmSharedControl, consumer_seq)),
        ("consumerLo", offset_of!(pcm::PcmSharedControl, consumer_lo)),
        ("consumerHi", offset_of!(pcm::PcmSharedControl, consumer_hi)),
        ("discardSeq", offset_of!(pcm::PcmSharedControl, discard_seq)),
        ("discardLo", offset_of!(pcm::PcmSharedControl, discard_lo)),
        ("discardHi", offset_of!(pcm::PcmSharedControl, discard_hi)),
        ("underruns", offset_of!(pcm::PcmSharedControl, underruns)),
        ("wakeSeq", offset_of!(pcm::PcmSharedControl, wake_seq)),
    ] {
        out.push_str(&format!("  {name}: {{ offset: {offset}, size: 4 }},\n"));
    }
    out.push_str("} as const;\n\n");
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
    if let Some(copy_out_length) = desc.copy_out_length {
        s.push_str(&format!(
            ", copyOutLength: {}",
            ts_syscall_arg_copy_out_length(copy_out_length)
        ));
    }
    s.push_str(" }");
    s
}

fn ts_syscall_arg_copy_out_length(
    length: shared::host_abi::SyscallArgCopyOutLength,
) -> String {
    use shared::host_abi::SyscallArgCopyOutLength;

    match length {
        SyscallArgCopyOutLength::U32Field { arg_index, offset } => {
            format!(
                "{{ type: \"u32-field\", argIndex: {arg_index}, offset: {offset} }}"
            )
        }
        SyscallArgCopyOutLength::ReturnValue {
            multiplier,
            max_value,
        } => {
            format!(
                "{{ type: \"return-value\", multiplier: {multiplier}, maxValue: {max_value} }}"
            )
        }
    }
}

fn ts_syscall_arg_size(size: shared::host_abi::SyscallArgSize) -> String {
    use shared::host_abi::SyscallArgSize;

    match size {
        SyscallArgSize::CString {
            max_bytes,
            too_long_errno,
        } => {
            format!(
                "{{ type: \"cstring\", maxBytes: {max_bytes}, tooLongErrno: {too_long_errno} }}"
            )
        }
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
        SyscallArgSize::KernelDereferenced => {
            "{ type: \"kernel-dereferenced\" }".to_string()
        }
        SyscallArgSize::ProcessLayout {
            wasm32_size,
            wasm64_size,
        } => format!(
            "{{ type: \"process-layout\", wasm32Size: {wasm32_size}, wasm64Size: {wasm64_size} }}"
        ),
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

fn ioctl_arg_kind_name(kind: shared::ioctl_contract::IoctlArgKind) -> &'static str {
    use shared::ioctl_contract::IoctlArgKind;

    match kind {
        IoctlArgKind::None => "none",
        IoctlArgKind::ScalarI32 => "scalar-i32",
        IoctlArgKind::Pointer => "pointer",
    }
}

fn ioctl_direction_name(direction: shared::ioctl_contract::IoctlDirection) -> &'static str {
    use shared::ioctl_contract::IoctlDirection;

    match direction {
        IoctlDirection::None => "none",
        IoctlDirection::In => "in",
        IoctlDirection::Out => "out",
        IoctlDirection::InOut => "inout",
    }
}

fn ts_optional_u32(value: Option<u32>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "null".into())
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

fn build_typed_struct_layout(
    total_size: usize,
    alignment: usize,
    fields: &[(&'static str, usize, usize, &'static str)],
) -> Value {
    let fields = fields
        .iter()
        .map(|(name, offset, span, field_type)| {
            let mut field: JsonMap = BTreeMap::new();
            field.insert("name".into(), json!(name));
            field.insert("offset".into(), json!(offset));
            field.insert("span".into(), json!(span));
            field.insert("type".into(), json!(field_type));
            Value::Object(field.into_iter().collect())
        })
        .collect();
    let mut layout: JsonMap = BTreeMap::new();
    layout.insert("size".into(), json!(total_size));
    layout.insert("align".into(), json!(alignment));
    layout.insert("fields".into(), Value::Array(fields));
    Value::Object(layout.into_iter().collect())
}

/// Who depends on a snapshot section, and so what a change to it forces.
///
/// WHY: an already-built program carries a digest of the sections it depends
/// on (`kandelo.abi.contract`, see `local_abi_identity`), and the host refuses
/// to run it when that digest differs from the kernel's. Binding programs to
/// the whole snapshot made every kernel-host change -- a new optional kernel
/// export, a new host import -- invalidate every program, package and fixture,
/// although none of them can observe it. The kernel and host ship together and
/// check each other through `kernel_exports`, `kernel_imports` and
/// `host_adapter` instead.
///
/// Every section declares its surface where it is produced, so a new section
/// cannot be added without choosing one. A section a running program can
/// observe at all -- even if parts of it are kernel-host only -- is `Program`:
/// over-binding costs a rebuild, under-binding lets a stale program run.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Surface {
    /// Visible to a running program: what it was compiled and linked against
    /// (syscall numbers and marshalling, channel and memory layout, structs,
    /// custom sections, imports, fork instrumentation formats).
    Program,
    /// Seen only by the kernel Wasm and the host runtime, which ship together.
    KernelHost,
}

/// Snapshot key that records each section's [`Surface`].
pub(crate) const SURFACES_KEY: &str = "abi_surfaces";

struct Sections {
    root: JsonMap,
    program: Vec<&'static str>,
    kernel_host: Vec<&'static str>,
}

impl Sections {
    fn add(&mut self, surface: Surface, name: &'static str, value: Value) {
        assert!(
            self.root.insert(name.into(), value).is_none(),
            "ABI snapshot section {name} declared twice"
        );
        match surface {
            Surface::Program => self.program.push(name),
            Surface::KernelHost => self.kernel_host.push(name),
        }
    }

    fn finish(mut self) -> JsonMap {
        self.program.sort_unstable();
        self.kernel_host.sort_unstable();
        self.root.insert(
            SURFACES_KEY.into(),
            json!({ "program": self.program, "kernel_host": self.kernel_host }),
        );
        self.root
    }
}

fn build_snapshot(kernel_wasm: &std::path::Path) -> Result<JsonMap, String> {
    use Surface::{KernelHost, Program};
    let mut root: JsonMap = BTreeMap::new();
    // The ABI epoch is hashed into every digest separately; it is not a section.
    root.insert("abi_version".into(), json!(shared::ABI_VERSION));
    let mut s = Sections {
        root,
        program: Vec::new(),
        kernel_host: Vec::new(),
    };

    s.add(Program, "platform_limits", platform_limits());
    // Argument kinds of the host's process-metadata export.
    s.add(KernelHost, "process_metadata_contract", process_metadata_contract());
    // The process table the kernel hands the host (ps, the inspector).
    s.add(KernelHost, "process_snapshot_wire", process_snapshot_wire());
    s.add(KernelHost, "wakeup_event_wire", wakeup_event_wire());
    s.add(KernelHost, "wait_completion_wire", wait_completion_wire());
    s.add(Program, "io_multiplexing", io_multiplexing());
    s.add(Program, "vfs_metadata", vfs_metadata());
    s.add(Program, "spawn_contract", spawn_contract());
    s.add(Program, "gl_inline_client_draw", gl_inline_client_draw());

    s.add(Program, "channel_header", channel_header());
    s.add(Program, "channel_request_flags", channel_request_flags());
    s.add(Program, "channel_signal_area", channel_signal_area());
    s.add(Program, "channel_buffers", channel_buffers());
    s.add(Program, "channel_scalar_contract", channel_scalar_contract());

    s.add(Program, "marshalled_structs", marshalled_structs());
    s.add(Program, "clipboard_device_abi", clipboard_device_abi());
    s.add(Program, "oss_source_abi", oss_source_abi());
    // The shared PCM ring between the kernel and the host's audio output.
    s.add(KernelHost, "pcm_transport_abi", pcm_transport_abi());
    s.add(Program, "syscalls", syscalls());
    s.add(Program, "pathconf_names", pathconf_names());
    s.add(Program, "wait_contract", wait_contract());
    s.add(Program, "host_intercepted_syscalls", host_intercepted_syscalls());
    s.add(KernelHost, "host_adapter", host_adapter());
    s.add(Program, "syscall_arg_descriptors", syscall_arg_descriptors());
    s.add(Program, "ioctl_request_contracts", ioctl_request_contracts());
    s.add(Program, "ioctl_request_families", ioctl_request_families());
    s.add(Program, "channel_status_codes", channel_status_codes());
    s.add(Program, "process_native_layouts", process_native_layouts());
    s.add(Program, "process_memory_layout", process_memory_layout());
    s.add(Program, "custom_sections", custom_sections());
    s.add(Program, "process_expected_globals", process_expected_globals());
    // What a program imports from `env`: the host supplies it to programs.
    s.add(Program, "host_env_imports", host_env_imports());
    s.add(Program, "program_artifact", program_artifact());

    // Which kernel Wasm exports the build keeps.
    s.add(KernelHost, "export_deny", export_deny());

    let wasm =
        std::fs::read(kernel_wasm).map_err(|e| format!("read {}: {e}", kernel_wasm.display()))?;
    let exports = kernel_exports(&wasm)?;
    validate_host_adapter_export_lifecycles(&s.root["host_adapter"], &exports)?;
    s.add(KernelHost, "kernel_exports", exports);
    s.add(KernelHost, "kernel_imports", kernel_imports(&wasm)?);

    Ok(s.finish())
}

fn gl_inline_client_draw() -> Value {
    use shared::gl::{OP_DRAW_CLIENT_ARRAYS, OP_VERSION, inline_client_draw as wire};
    // The payload is read by the host, but emitted by already-built programs.
    // An unchanged unpublished epoch must not admit a different record digest.
    json!({
        "op_version": OP_VERSION,
        "opcode": OP_DRAW_CLIENT_ARRAYS,
        "byte_order": "little-endian",
        "header_bytes": wire::HEADER_BYTES,
        "header_fields": {"mode_u32": 0, "first_i32": 4, "count_i32": 8, "attribute_count_u32": 12},
        "attribute_bytes": wire::ATTRIBUTE_BYTES,
        "attribute_fields": {"index_u32": 0, "components_u32": 4, "type_u32": 8, "normalized_u32": 12, "packed_bytes_u32": 16},
        "max_payload_bytes": wire::MAX_BYTES,
        "max_attributes": wire::MAX_ATTRIBUTES,
        "minimum_count": 1,
        "attribute_order": "strictly-increasing-index",
        "data_layout": "count-packed-elements-at-original-vertex-indices",
        "component_types": [0x1400, 0x1401, 0x1402, 0x1403, 0x1406, 0x140c],
        "public_buffer_names": false,
    })
}

fn platform_limits() -> Value {
    json!({
        "arg_max_bytes": shared::platform_limits::ARG_MAX_BYTES,
        "fd_set_bytes": shared::select::FD_SET_BYTES,
        "fd_setsize": shared::select::FD_SETSIZE,
        "iov_max": shared::platform_limits::IOV_MAX,
        "max_reportable_transfer_bytes":
            shared::platform_limits::MAX_REPORTABLE_TRANSFER_BYTES,
        "max_transfer_allocation_bytes":
            shared::platform_limits::MAX_TRANSFER_ALLOCATION_BYTES,
        "ngroups_max": shared::platform_limits::NGROUPS_MAX,
        "path_max_bytes": shared::platform_limits::PATH_MAX_BYTES,
        "process_startup_max_argv_count":
            shared::platform_limits::PROCESS_STARTUP_MAX_ARGV_COUNT,
        "process_startup_max_envp_count":
            shared::platform_limits::PROCESS_STARTUP_MAX_ENVP_COUNT,
        "sysv_msg_max_bytes": shared::platform_limits::SYSV_MSG_MAX_BYTES,
    })
}

fn process_metadata_contract() -> Value {
    use shared::process_metadata_contract as contract;

    json!({
        "kind_argv": contract::KIND_ARGV,
        "kind_environment": contract::KIND_ENVIRONMENT,
    })
}

fn process_snapshot_wire() -> Value {
    use shared::process_snapshot_wire as wire;

    json!({
        "count_offset": wire::COUNT_OFFSET,
        "count_size": wire::COUNT_BYTES,
        "records_offset": wire::RECORDS_OFFSET,
        "header": build_struct_layout(
            wire::HEADER_BYTES,
            vec![
                ("pid", wire::PID_OFFSET),
                ("ppid", wire::PPID_OFFSET),
                ("uid", wire::UID_OFFSET),
                ("gid", wire::GID_OFFSET),
                ("vsize", wire::VSIZE_OFFSET),
                ("state", wire::STATE_OFFSET),
                ("comm_len", wire::COMM_LEN_OFFSET),
                ("cmdline_len", wire::CMDLINE_LEN_OFFSET),
            ],
        ),
    })
}

struct WakeupEventField {
    name: &'static str,
    offset: usize,
    size: usize,
    ty: &'static str,
}

fn wakeup_event_fields() -> [WakeupEventField; 2] {
    use shared::wakeup_event_wire as wire;

    [
        WakeupEventField {
            name: "idx",
            offset: wire::IDX_OFFSET,
            size: wire::IDX_BYTES,
            ty: "u32",
        },
        WakeupEventField {
            name: "wakeType",
            offset: wire::TYPE_OFFSET,
            size: wire::TYPE_BYTES,
            ty: "u8",
        },
    ]
}

struct WakeupEventType {
    name: &'static str,
    bit: u8,
}

fn wakeup_event_types() -> [WakeupEventType; 8] {
    use shared::wakeup_event_wire as wire;

    [
        WakeupEventType {
            name: "readable",
            bit: wire::TYPE_READABLE,
        },
        WakeupEventType {
            name: "writable",
            bit: wire::TYPE_WRITABLE,
        },
        WakeupEventType {
            name: "accept",
            bit: wire::TYPE_ACCEPT,
        },
        WakeupEventType {
            name: "datagramWritable",
            bit: wire::TYPE_DATAGRAM_WRITABLE,
        },
        WakeupEventType {
            name: "processStopped",
            bit: wire::TYPE_PROCESS_STOPPED,
        },
        WakeupEventType {
            name: "processContinued",
            bit: wire::TYPE_PROCESS_CONTINUED,
        },
        WakeupEventType {
            name: "advisoryLock",
            bit: wire::TYPE_ADVISORY_LOCK,
        },
        WakeupEventType {
            name: "waitComplete",
            bit: wire::TYPE_WAIT_COMPLETE,
        },
    ]
}

fn wakeup_event_wire() -> Value {
    let fields: Vec<Value> = wakeup_event_fields()
        .iter()
        .map(|field| {
            json!({
                "name": field.name,
                "offset": field.offset,
                "size": field.size,
                "type": field.ty,
            })
        })
        .collect();
    let types: Vec<Value> = wakeup_event_types()
        .iter()
        .map(|event_type| {
            json!({
                "name": event_type.name,
                "bit": event_type.bit,
            })
        })
        .collect();

    json!({
        "record_size": shared::wakeup_event_wire::RECORD_BYTES,
        "fields": fields,
        "types": types,
    })
}

fn wait_completion_fields() -> [WakeupEventField; 5] {
    use shared::wait_completion_wire as wire;

    [
        WakeupEventField {
            name: "generation",
            offset: wire::GENERATION_OFFSET,
            size: 8,
            ty: "u64",
        },
        WakeupEventField {
            name: "pid",
            offset: wire::PID_OFFSET,
            size: 4,
            ty: "u32",
        },
        WakeupEventField {
            name: "tid",
            offset: wire::TID_OFFSET,
            size: 4,
            ty: "u32",
        },
        WakeupEventField {
            name: "value",
            offset: wire::VALUE_OFFSET,
            size: 4,
            ty: "i32",
        },
        WakeupEventField {
            name: "flags",
            offset: wire::FLAGS_OFFSET,
            size: 4,
            ty: "u32",
        },
    ]
}

fn wait_completion_wire() -> Value {
    use shared::wait_completion_wire as wire;

    let fields: Vec<Value> = wait_completion_fields()
        .iter()
        .map(|field| {
            json!({
                "name": field.name,
                "offset": field.offset,
                "size": field.size,
                "type": field.ty,
            })
        })
        .collect();
    json!({
        "record_size": wire::RECORD_BYTES,
        "parked_errno": wire::PARKED_ERRNO,
        "fields": fields,
        "flags": {
            "suppressRestart": wire::FLAG_SUPPRESS_RESTART,
            "cancelled": wire::FLAG_CANCELLED,
            "published": wire::FLAG_PUBLISHED,
        },
    })
}

fn render_ts_wait_completion_wire() -> String {
    use shared::wait_completion_wire as wire;

    let mut out = String::new();
    out.push_str(&format!(
        "export const WAIT_COMPLETION_RECORD_BYTES = {} as const;\n",
        wire::RECORD_BYTES
    ));
    out.push_str(&format!(
        "export const KERNEL_WAIT_PARKED_ERRNO = {} as const;\n",
        wire::PARKED_ERRNO
    ));
    out.push_str("export const WAIT_COMPLETION_FIELDS = {\n");
    for field in wait_completion_fields() {
        out.push_str(&format!(
            "  {}: {{ offset: {}, size: {}, type: {:?} }},\n",
            field.name, field.offset, field.size, field.ty
        ));
    }
    out.push_str("} as const;\n");
    out.push_str(&format!(
        "export const WAIT_COMPLETION_FLAGS = {{\n  suppressRestart: {},\n  cancelled: {},\n  published: {},\n}} as const;\n\n",
        wire::FLAG_SUPPRESS_RESTART,
        wire::FLAG_CANCELLED,
        wire::FLAG_PUBLISHED
    ));
    out
}

fn poll_events() -> [(&'static str, i16); 11] {
    use shared::poll::*;

    [
        ("POLLIN", POLLIN),
        ("POLLPRI", POLLPRI),
        ("POLLOUT", POLLOUT),
        ("POLLERR", POLLERR),
        ("POLLHUP", POLLHUP),
        ("POLLNVAL", POLLNVAL),
        ("POLLRDNORM", POLLRDNORM),
        ("POLLRDBAND", POLLRDBAND),
        ("POLLWRNORM", POLLWRNORM),
        ("POLLWRBAND", POLLWRBAND),
        ("POLLRDHUP", POLLRDHUP),
    ]
}

fn epoll_events() -> [(&'static str, u32); 14] {
    use shared::epoll::*;

    [
        ("EPOLLIN", EPOLLIN),
        ("EPOLLOUT", EPOLLOUT),
        ("EPOLLERR", EPOLLERR),
        ("EPOLLHUP", EPOLLHUP),
        ("EPOLLPRI", EPOLLPRI),
        ("EPOLLRDNORM", EPOLLRDNORM),
        ("EPOLLRDBAND", EPOLLRDBAND),
        ("EPOLLWRNORM", EPOLLWRNORM),
        ("EPOLLWRBAND", EPOLLWRBAND),
        ("EPOLLRDHUP", EPOLLRDHUP),
        ("EPOLLEXCLUSIVE", EPOLLEXCLUSIVE),
        ("EPOLLWAKEUP", EPOLLWAKEUP),
        ("EPOLLONESHOT", EPOLLONESHOT),
        ("EPOLLET", EPOLLET),
    ]
}

/// Facts a host network engine reports over `host_net_readiness`.
///
/// These cross the host/kernel boundary, so the host's copy is generated from
/// this one rather than retyped. The readiness *decision* they feed is the
/// kernel's alone; see `runtime_core::net_readiness`.
fn net_readiness_facts() -> [(&'static str, u32); 7] {
    use shared::net_readiness::*;

    [
        ("RECV_READY", RECV_READY),
        ("RECV_EOF", RECV_EOF),
        ("SEND_READY", SEND_READY),
        ("SEND_CLOSED", SEND_CLOSED),
        ("HANGUP", HANGUP),
        ("ERROR", ERROR),
        ("UNOBSERVABLE", UNOBSERVABLE),
    ]
}

fn io_multiplexing() -> Value {
    let poll_events: Vec<Value> = poll_events()
        .into_iter()
        .map(|(name, value)| json!({ "name": name, "value": value }))
        .collect();
    let epoll_events: Vec<Value> = epoll_events()
        .into_iter()
        .map(|(name, value)| json!({ "name": name, "value": value }))
        .collect();
    let net_readiness_facts: Vec<Value> = net_readiness_facts()
        .into_iter()
        .map(|(name, value)| json!({ "name": name, "value": value }))
        .collect();

    json!({
        "poll_events": poll_events,
        "epoll_events": epoll_events,
        "net_readiness": {
            "facts": net_readiness_facts,
            "errno_shift": shared::net_readiness::ERRNO_SHIFT,
            "flag_mask": shared::net_readiness::FLAG_MASK,
        },
        "select": {
            "fd_setsize": shared::select::FD_SETSIZE,
            "fd_set_bytes": shared::select::FD_SET_BYTES,
        },
    })
}

fn open_flags() -> [(&'static str, u32); 16] {
    use shared::flags::*;

    [
        ("O_RDONLY", O_RDONLY),
        ("O_WRONLY", O_WRONLY),
        ("O_RDWR", O_RDWR),
        ("O_ACCMODE", O_ACCMODE),
        ("O_CREAT", O_CREAT),
        ("O_EXCL", O_EXCL),
        ("O_NOCTTY", O_NOCTTY),
        ("O_TRUNC", O_TRUNC),
        ("O_APPEND", O_APPEND),
        ("O_NONBLOCK", O_NONBLOCK),
        ("O_ASYNC", O_ASYNC),
        ("O_DIRECTORY", O_DIRECTORY),
        ("O_NOFOLLOW", O_NOFOLLOW),
        ("O_CLOEXEC", O_CLOEXEC),
        ("O_PATH", O_PATH),
        ("O_CLOFORK", O_CLOFORK),
    ]
}

fn at_flags() -> [(&'static str, i32); 4] {
    use shared::flags::*;

    [
        ("AT_FDCWD", AT_FDCWD),
        ("AT_SYMLINK_NOFOLLOW", AT_SYMLINK_NOFOLLOW as i32),
        ("AT_REMOVEDIR", AT_REMOVEDIR as i32),
        ("AT_EMPTY_PATH", AT_EMPTY_PATH as i32),
    ]
}

fn fd_flags() -> [(&'static str, u32); 2] {
    use shared::fd_flags::*;

    [("FD_CLOEXEC", FD_CLOEXEC), ("FD_CLOFORK", FD_CLOFORK)]
}

fn fcntl_commands() -> [(&'static str, u32); 16] {
    use shared::fcntl_cmd::*;

    [
        ("F_DUPFD", F_DUPFD),
        ("F_GETFD", F_GETFD),
        ("F_SETFD", F_SETFD),
        ("F_GETFL", F_GETFL),
        ("F_SETFL", F_SETFL),
        ("F_GETLK", F_GETLK),
        ("F_SETLK", F_SETLK),
        ("F_SETLKW", F_SETLKW),
        ("F_SETOWN", F_SETOWN),
        ("F_GETOWN", F_GETOWN),
        ("F_DUPFD_QUERY", F_DUPFD_QUERY),
        ("F_DUPFD_CLOEXEC", F_DUPFD_CLOEXEC),
        ("F_DUPFD_CLOFORK", F_DUPFD_CLOFORK),
        ("F_OFD_GETLK", F_OFD_GETLK),
        ("F_OFD_SETLK", F_OFD_SETLK),
        ("F_OFD_SETLKW", F_OFD_SETLKW),
    ]
}

fn access_modes() -> [(&'static str, u32); 4] {
    use shared::access::*;

    [
        ("F_OK", F_OK),
        ("R_OK", R_OK),
        ("W_OK", W_OK),
        ("X_OK", X_OK),
    ]
}

fn file_modes() -> [(&'static str, u32); 24] {
    use shared::mode::*;

    [
        ("S_IFMT", S_IFMT),
        ("S_IFSOCK", S_IFSOCK),
        ("S_IFLNK", S_IFLNK),
        ("S_IFREG", S_IFREG),
        ("S_IFBLK", S_IFBLK),
        ("S_IFDIR", S_IFDIR),
        ("S_IFCHR", S_IFCHR),
        ("S_IFIFO", S_IFIFO),
        ("S_ISUID", S_ISUID),
        ("S_ISGID", S_ISGID),
        ("S_ISVTX", S_ISVTX),
        ("S_IRWXU", S_IRWXU),
        ("S_IRUSR", S_IRUSR),
        ("S_IWUSR", S_IWUSR),
        ("S_IXUSR", S_IXUSR),
        ("S_IRWXG", S_IRWXG),
        ("S_IRGRP", S_IRGRP),
        ("S_IWGRP", S_IWGRP),
        ("S_IXGRP", S_IXGRP),
        ("S_IRWXO", S_IRWXO),
        ("S_IROTH", S_IROTH),
        ("S_IWOTH", S_IWOTH),
        ("S_IXOTH", S_IXOTH),
        ("S_MODE_BITS", S_MODE_BITS),
    ]
}

fn dirent_types() -> [(&'static str, u32); 8] {
    use shared::dirent::*;

    [
        ("DT_UNKNOWN", DT_UNKNOWN),
        ("DT_FIFO", DT_FIFO),
        ("DT_CHR", DT_CHR),
        ("DT_DIR", DT_DIR),
        ("DT_BLK", DT_BLK),
        ("DT_REG", DT_REG),
        ("DT_LNK", DT_LNK),
        ("DT_SOCK", DT_SOCK),
    ]
}

fn seek_whence() -> [(&'static str, u32); 3] {
    use shared::seek::*;

    [
        ("SEEK_SET", SEEK_SET),
        ("SEEK_CUR", SEEK_CUR),
        ("SEEK_END", SEEK_END),
    ]
}

fn named_values<const N: usize>(entries: [(&'static str, u32); N]) -> Value {
    Value::Array(
        entries
            .into_iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect(),
    )
}

fn named_signed_values<const N: usize>(entries: [(&'static str, i32); N]) -> Value {
    Value::Array(
        entries
            .into_iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect(),
    )
}

fn vfs_metadata() -> Value {
    json!({
        "open_flags": named_values(open_flags()),
        "at_flags": named_signed_values(at_flags()),
        "fd_flags": named_values(fd_flags()),
        "fcntl_commands": named_values(fcntl_commands()),
        "access_modes": named_values(access_modes()),
        "statfs_flags": named_values(statfs_flags()),
        "file_modes": named_values(file_modes()),
        "dirent_types": named_values(dirent_types()),
        "seek_whence": named_values(seek_whence()),
    })
}

fn statfs_flags() -> [(&'static str, u32); 1] {
    [("ST_NOSUID", shared::statfs_flags::ST_NOSUID)]
}

fn channel_scalar_contract() -> Value {
    let syscalls: Vec<Value> = shared::channel_scalar::SYSCALLS
        .iter()
        .map(|contract| {
            let arguments: Vec<Value> = contract
                .arguments
                .iter()
                .map(|argument| {
                    json!({
                        "index": argument.index,
                        "kind": argument.kind.abi_name(),
                    })
                })
                .collect();
            json!({
                "arguments": arguments,
                "musl_name": contract.musl_name,
                "number": contract.syscall_number,
                "result": contract.result.abi_name(),
            })
        })
        .collect();

    json!({
        "default_argument_kind": shared::channel_scalar::ChannelScalarKind::I32.abi_name(),
        "default_result_kind": shared::channel_scalar::ChannelResultKind::I32.abi_name(),
        "syscalls": syscalls,
    })
}

fn process_native_layouts() -> Value {
    use shared::process_layout::{
        cmsghdr, iovec, msghdr, multicast_group_request, rt_sigqueueinfo, sigevent,
    };

    json!({
        "cmsghdr": {
            "wasm32": {
                "align": cmsghdr::WASM32_ALIGN,
                "data_offset": cmsghdr::WASM32_DATA_OFFSET,
                "len_offset": cmsghdr::WASM32_LEN_OFFSET,
                "level_offset": cmsghdr::WASM32_LEVEL_OFFSET,
                "size": cmsghdr::WASM32_SIZE,
                "type_offset": cmsghdr::WASM32_TYPE_OFFSET,
            },
            "wasm64": {
                "align": cmsghdr::WASM64_ALIGN,
                "data_offset": cmsghdr::WASM64_DATA_OFFSET,
                "len_offset": cmsghdr::WASM64_LEN_OFFSET,
                "level_offset": cmsghdr::WASM64_LEVEL_OFFSET,
                "size": cmsghdr::WASM64_SIZE,
                "type_offset": cmsghdr::WASM64_TYPE_OFFSET,
            },
        },
        "scm_rights": {
            "fd_bytes": shared::socket::SCM_RIGHTS_FD_BYTES,
            "level": shared::socket::SOL_SOCKET,
            "type": shared::socket::SCM_RIGHTS,
        },
        "socket_message_flags": {
            "trunc": shared::socket::MSG_TRUNC,
        },
        "iovec": {
            "wasm32": {
                "base_offset": iovec::WASM32_BASE_OFFSET,
                "len_offset": iovec::WASM32_LEN_OFFSET,
                "size": iovec::WASM32_SIZE,
            },
            "wasm64": {
                "base_offset": iovec::WASM64_BASE_OFFSET,
                "len_offset": iovec::WASM64_LEN_OFFSET,
                "size": iovec::WASM64_SIZE,
            },
        },
        "multicast_group_request": {
            "wasm32": {
                "group_req_size": multicast_group_request::WASM32_GROUP_REQ_SIZE,
                "group_offset": multicast_group_request::WASM32_GROUP_OFFSET,
                "group_source_req_size":
                    multicast_group_request::WASM32_GROUP_SOURCE_REQ_SIZE,
                "source_offset": multicast_group_request::WASM32_SOURCE_OFFSET,
            },
            "wasm64": {
                "group_req_size": multicast_group_request::WASM64_GROUP_REQ_SIZE,
                "group_offset": multicast_group_request::WASM64_GROUP_OFFSET,
                "group_source_req_size":
                    multicast_group_request::WASM64_GROUP_SOURCE_REQ_SIZE,
                "source_offset": multicast_group_request::WASM64_SOURCE_OFFSET,
            },
        },
        "msghdr": {
            "wasm32": {
                "control_offset": msghdr::WASM32_CONTROL_OFFSET,
                "controllen_offset": msghdr::WASM32_CONTROLLEN_OFFSET,
                "flags_offset": msghdr::WASM32_FLAGS_OFFSET,
                "iov_offset": msghdr::WASM32_IOV_OFFSET,
                "iovlen_offset": msghdr::WASM32_IOVLEN_OFFSET,
                "name_offset": msghdr::WASM32_NAME_OFFSET,
                "namelen_offset": msghdr::WASM32_NAMELEN_OFFSET,
                "size": msghdr::WASM32_SIZE,
            },
            "wasm64": {
                "control_offset": msghdr::WASM64_CONTROL_OFFSET,
                "controllen_offset": msghdr::WASM64_CONTROLLEN_OFFSET,
                "flags_offset": msghdr::WASM64_FLAGS_OFFSET,
                "iov_offset": msghdr::WASM64_IOV_OFFSET,
                "iovlen_offset": msghdr::WASM64_IOVLEN_OFFSET,
                "name_offset": msghdr::WASM64_NAME_OFFSET,
                "namelen_offset": msghdr::WASM64_NAMELEN_OFFSET,
                "size": msghdr::WASM64_SIZE,
            },
        },
        "siginfo": {
            "signo_offset": rt_sigqueueinfo::SIGNO_OFFSET,
            "errno_offset": rt_sigqueueinfo::ERRNO_OFFSET,
            "code_offset": rt_sigqueueinfo::CODE_OFFSET,
            "wasm32": {
                "size": rt_sigqueueinfo::WASM32_SIZE,
                "pid_offset": rt_sigqueueinfo::WASM32_PID_OFFSET,
                "uid_offset": rt_sigqueueinfo::WASM32_UID_OFFSET,
                "value_offset": rt_sigqueueinfo::WASM32_VALUE_OFFSET,
                "value_size": rt_sigqueueinfo::WASM32_VALUE_SIZE,
            },
            "wasm64": {
                "size": rt_sigqueueinfo::WASM64_SIZE,
                "pid_offset": rt_sigqueueinfo::WASM64_PID_OFFSET,
                "uid_offset": rt_sigqueueinfo::WASM64_UID_OFFSET,
                "value_offset": rt_sigqueueinfo::WASM64_VALUE_OFFSET,
                "value_size": rt_sigqueueinfo::WASM64_VALUE_SIZE,
            },
        },
        "sigevent": {
            "wasm32": {
                "size": sigevent::WASM32_SIZE,
                "value_offset": sigevent::WASM32_VALUE_OFFSET,
                "value_size": sigevent::WASM32_VALUE_SIZE,
                "signo_offset": sigevent::WASM32_SIGNO_OFFSET,
                "notify_offset": sigevent::WASM32_NOTIFY_OFFSET,
                "payload_offset": sigevent::WASM32_PAYLOAD_OFFSET,
            },
            "wasm64": {
                "size": sigevent::WASM64_SIZE,
                "value_offset": sigevent::WASM64_VALUE_OFFSET,
                "value_size": sigevent::WASM64_VALUE_SIZE,
                "signo_offset": sigevent::WASM64_SIGNO_OFFSET,
                "notify_offset": sigevent::WASM64_NOTIFY_OFFSET,
                "payload_offset": sigevent::WASM64_PAYLOAD_OFFSET,
            },
        },
    })
}

fn spawn_contract() -> Value {
    use shared::spawn_contract;

    json!({
        "action_record": {
            "bytes": spawn_contract::WIRE_ACTION_RECORD_BYTES,
            "offsets": {
                "fd": spawn_contract::WIRE_ACTION_FD_OFFSET,
                "mode": spawn_contract::WIRE_ACTION_MODE_OFFSET,
                "newfd": spawn_contract::WIRE_ACTION_NEWFD_OFFSET,
                "oflag": spawn_contract::WIRE_ACTION_OFLAG_OFFSET,
                "op": spawn_contract::WIRE_ACTION_OP_OFFSET,
                "path_len": spawn_contract::WIRE_ACTION_PATH_LEN_OFFSET,
                "path_off": spawn_contract::WIRE_ACTION_PATH_OFF_OFFSET,
            },
        },
        "attribute_bits": {
            "resetids": spawn_contract::ATTR_RESETIDS,
            "setpgroup": spawn_contract::ATTR_SETPGROUP,
            "setschedparam": spawn_contract::ATTR_SETSCHEDPARAM,
            "setscheduler": spawn_contract::ATTR_SETSCHEDULER,
            "setsid": spawn_contract::ATTR_SETSID,
            "setsigdef": spawn_contract::ATTR_SETSIGDEF,
            "setsigmask": spawn_contract::ATTR_SETSIGMASK,
            "usevfork": spawn_contract::ATTR_USEVFORK,
        },
        "count_caps": {
            "actions": spawn_contract::MAX_ACTION_COUNT,
            "argv": spawn_contract::MAX_ARGV_COUNT,
            "envp": spawn_contract::MAX_ENVP_COUNT,
        },
        "header": {
            "bytes": spawn_contract::WIRE_HEADER_BYTES,
            "offsets": {
                "action_count": spawn_contract::WIRE_HEADER_ACTION_COUNT_OFFSET,
                "argc": spawn_contract::WIRE_HEADER_ARGC_OFFSET,
                "attr_flags": spawn_contract::WIRE_HEADER_ATTR_FLAGS_OFFSET,
                "envc": spawn_contract::WIRE_HEADER_ENVC_OFFSET,
                "pad": spawn_contract::WIRE_HEADER_PAD_OFFSET,
                "pgrp": spawn_contract::WIRE_HEADER_PGRP_OFFSET,
                "sigdef": spawn_contract::WIRE_HEADER_SIGDEF_OFFSET,
                "sigmask": spawn_contract::WIRE_HEADER_SIGMASK_OFFSET,
            },
        },
        "opcodes": {
            "chdir": spawn_contract::WIRE_OP_CHDIR,
            "close": spawn_contract::WIRE_OP_CLOSE,
            "dup2": spawn_contract::WIRE_OP_DUP2,
            "fchdir": spawn_contract::WIRE_OP_FCHDIR,
            "open": spawn_contract::WIRE_OP_OPEN,
        },
        "platform_aliases": {
            "arg_max_bytes": spawn_contract::POSIX_ARG_MAX_BYTES,
            "path_max_bytes": spawn_contract::POSIX_PATH_MAX_BYTES,
        },
        "string_offset_bytes": spawn_contract::WIRE_STRING_OFFSET_BYTES,
        "syscall_number": shared::abi::host_intercepted::SYS_SPAWN,
        "wire_max_bytes": spawn_contract::WIRE_MAX_BYTES,
    })
}

fn channel_header() -> Value {
    use shared::channel::*;
    // Names and type labels are descriptive. Every offset, size, and repeated
    // count comes from the shared channel contract, so snapshot generation
    // cannot preserve stale arithmetic after that contract changes.
    let fields = [
        ("status", STATUS_OFFSET, STATUS_SIZE, "i32".to_string()),
        ("syscall", SYSCALL_OFFSET, SYSCALL_SIZE, "i32".to_string()),
        (
            "args",
            ARGS_OFFSET,
            ARGS_COUNT * ARG_SIZE,
            format!("[i64; {ARGS_COUNT}]"),
        ),
        ("ret", RETURN_OFFSET, RETURN_SIZE, "i64".to_string()),
        ("errno", ERRNO_OFFSET, ERRNO_SIZE, "i32".to_string()),
        (
            "request_flags",
            REQUEST_FLAGS_OFFSET,
            REQUEST_FLAGS_SIZE,
            "u32".to_string(),
        ),
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

    assert_eq!(
        covered, HEADER_SIZE,
        "channel header fields must cover HEADER_SIZE exactly"
    );

    let mut m: JsonMap = BTreeMap::new();
    m.insert("size".into(), json!(HEADER_SIZE));
    m.insert("fields".into(), Value::Array(fields_json));
    m.insert(
        "request_flags".into(),
        json!({
            "cancellation_point": REQUEST_FLAG_CANCELLATION_POINT,
            "cancellation_wake_allowed": REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED,
            "known_mask": REQUEST_FLAGS_KNOWN_MASK,
        }),
    );
    Value::Object(m.into_iter().collect())
}

fn channel_request_flags() -> Value {
    let mut flag: JsonMap = BTreeMap::new();
    flag.insert("name".into(), json!("defer_signal_delivery"));
    flag.insert(
        "bit".into(),
        json!(shared::channel::REQUEST_FLAG_DEFER_SIGNAL_DELIVERY),
    );
    Value::Array(vec![Value::Object(flag.into_iter().collect())])
}

fn channel_buffers() -> Value {
    use shared::channel::*;
    let mut m: JsonMap = BTreeMap::new();
    m.insert("data_offset".into(), json!(DATA_OFFSET));
    m.insert("data_size".into(), json!(DATA_SIZE));
    m.insert("min_channel_size".into(), json!(MIN_CHANNEL_SIZE));
    Value::Object(m.into_iter().collect())
}

/// `/dev/kandelo/clipboard`'s guest-visible wire format and the
/// `kernel_clipboard_*` export results, one list for every rendering.
fn clipboard_constants() -> Vec<(&'static str, i64)> {
    use shared::clipboard::*;
    vec![
        ("KANDELO_CLIPBOARD_RECORD_VERSION", RECORD_VERSION as i64),
        ("KANDELO_CLIPBOARD_KIND_OFFER_TEXT", KIND_OFFER_TEXT as i64),
        ("KANDELO_CLIPBOARD_KIND_GUEST_TEXT", KIND_GUEST_TEXT as i64),
        ("KANDELO_CLIPBOARD_MAX_TEXT_BYTES", MAX_TEXT_BYTES as i64),
        ("KANDELO_CLIPBOARD_RECORD_HEADER_SIZE", RECORD_HEADER_SIZE as i64),
        ("KANDELO_CLIPBOARD_ACK_SIZE", ACK_SIZE as i64),
        ("KANDELO_CLIPBOARD_ACK_PENDING", ACK_PENDING as i64),
        ("KANDELO_CLIPBOARD_ACK_SUPERSEDED", ACK_SUPERSEDED as i64),
        ("KANDELO_CLIPBOARD_ACK_NO_AGENT", ACK_NO_AGENT as i64),
        ("KANDELO_CLIPBOARD_ACK_UNKNOWN_SEQ", ACK_UNKNOWN_SEQ as i64),
    ]
}

fn clipboard_device_abi() -> Value {
    use shared::clipboard::*;
    let mut constants: JsonMap = BTreeMap::new();
    for (name, value) in clipboard_constants() {
        constants.insert(name.into(), json!(value));
    }
    let mut abi: JsonMap = BTreeMap::new();
    abi.insert("device_path".into(), json!(DEVICE_PATH));
    abi.insert("constants".into(), Value::Object(constants.into_iter().collect()));
    abi.insert(
        "record_header".into(),
        json!({
            "size": size_of::<ClipboardRecordHeader>(),
            "fields": [
                {"name": "version", "offset": offset_of!(ClipboardRecordHeader, version), "type": "u32"},
                {"name": "kind", "offset": offset_of!(ClipboardRecordHeader, kind), "type": "u32"},
                {"name": "seq", "offset": offset_of!(ClipboardRecordHeader, seq), "type": "u32"},
                {"name": "len", "offset": offset_of!(ClipboardRecordHeader, len), "type": "u32"},
            ],
        }),
    );
    abi.insert(
        "ack".into(),
        json!({
            "size": size_of::<ClipboardAck>(),
            "fields": [
                {"name": "seq", "offset": offset_of!(ClipboardAck, seq), "type": "u32"},
                {"name": "status", "offset": offset_of!(ClipboardAck, status), "type": "i32"},
            ],
        }),
    );
    Value::Object(abi.into_iter().collect())
}

fn render_clipboard_ts_bindings(out: &mut String) {
    out.push_str(&format!(
        "export const KANDELO_CLIPBOARD_DEVICE_PATH = {:?} as const;\n",
        shared::clipboard::DEVICE_PATH
    ));
    for (name, value) in clipboard_constants() {
        out.push_str(&format!("export const {name} = {value} as const;\n"));
    }
    out.push('\n');
}

/// `<kandelo/clipboard.h>`: what a C clipboard agent reads and writes.
fn render_clipboard_header() -> String {
    use shared::clipboard::*;
    let mut out = String::from(
        "/* GENERATED by `cargo xtask dump-abi`. Do not edit by hand. */\n\
         /* /dev/kandelo/clipboard: host clipboard text for a guest agent. */\n\
         /* Source of truth: crates/shared/src/lib.rs, module `clipboard`. */\n\
         #ifndef KANDELO_CLIPBOARD_H\n\
         #define KANDELO_CLIPBOARD_H\n\
         \n\
         #include <stddef.h>\n\
         #include <stdint.h>\n\
         \n",
    );
    out.push_str(&format!("#define KANDELO_CLIPBOARD_DEVICE_PATH {:?}\n", DEVICE_PATH));
    for (name, value) in clipboard_constants() {
        out.push_str(&format!("#define {name} ({value})\n"));
    }
    out.push_str(
        "\n\
         /* One record as read from the device: this header, then `len` */\n\
         /* bytes of UTF-8 text. All fields are little-endian. */\n\
         struct kandelo_clipboard_record {\n\
         \tuint32_t version;\n\
         \tuint32_t kind;\n\
         \tuint32_t seq;\n\
         \tuint32_t len;\n\
         };\n\
         \n\
         /* Written back after an offer: status 0 once the selection is */\n\
         /* installed, else a negative errno. */\n\
         struct kandelo_clipboard_ack {\n\
         \tuint32_t seq;\n\
         \tint32_t status;\n\
         };\n\
         \n\
         #if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L\n",
    );
    out.push_str(&format!(
        "_Static_assert(sizeof(struct kandelo_clipboard_record) == {}, \"record ABI size\");\n",
        size_of::<ClipboardRecordHeader>()
    ));
    out.push_str(&format!(
        "_Static_assert(offsetof(struct kandelo_clipboard_record, len) == {}, \"record.len ABI offset\");\n",
        offset_of!(ClipboardRecordHeader, len)
    ));
    out.push_str(&format!(
        "_Static_assert(sizeof(struct kandelo_clipboard_ack) == {}, \"ack ABI size\");\n",
        size_of::<ClipboardAck>()
    ));
    out.push_str(&format!(
        "_Static_assert(offsetof(struct kandelo_clipboard_ack, status) == {}, \"ack.status ABI offset\");\n",
        offset_of!(ClipboardAck, status)
    ));
    out.push_str("#endif\n\n#endif /* KANDELO_CLIPBOARD_H */\n");
    out
}

fn oss_source_abi() -> Value {
    let mut ioctls: JsonMap = BTreeMap::new();
    for (name, value) in oss_ioctl_constants() {
        ioctls.insert(name.into(), json!(value));
    }
    let mut formats: JsonMap = BTreeMap::new();
    for (name, value) in oss_format_constants() {
        formats.insert(name.into(), json!(value));
    }
    let mut capabilities: JsonMap = BTreeMap::new();
    for (name, value) in oss_capability_constants() {
        capabilities.insert(name.into(), json!(value));
    }
    let mut trigger_values: JsonMap = BTreeMap::new();
    for (name, value) in oss_trigger_constants() {
        trigger_values.insert(name.into(), json!(value));
    }

    let mut abi: JsonMap = BTreeMap::new();
    abi.insert(
        "ioctls".into(),
        Value::Object(ioctls.into_iter().collect()),
    );
    abi.insert(
        "formats".into(),
        Value::Object(formats.into_iter().collect()),
    );
    abi.insert(
        "capabilities".into(),
        Value::Object(capabilities.into_iter().collect()),
    );
    abi.insert(
        "trigger_values".into(),
        Value::Object(trigger_values.into_iter().collect()),
    );
    Value::Object(abi.into_iter().collect())
}

fn pcm_transport_abi() -> Value {
    use shared::pcm;

    let mut constants: JsonMap = BTreeMap::new();
    for (name, value) in [
        ("magic", pcm::PCM_TRANSPORT_MAGIC),
        ("version", pcm::PCM_TRANSPORT_VERSION),
        ("header_bytes", pcm::PCM_TRANSPORT_HEADER_BYTES),
        ("ring_bytes", pcm::PCM_TRANSPORT_RING_BYTES),
        ("total_bytes", pcm::PCM_TRANSPORT_BYTES),
        ("state_closed", pcm::PCM_STATE_CLOSED),
        ("state_stopped", pcm::PCM_STATE_STOPPED),
        ("state_running", pcm::PCM_STATE_RUNNING),
        ("state_draining", pcm::PCM_STATE_DRAINING),
        ("format_unknown", pcm::PCM_FORMAT_UNKNOWN),
        ("format_u8", pcm::PCM_FORMAT_U8),
        ("format_s16_le", pcm::PCM_FORMAT_S16_LE),
        ("format_s16_be", pcm::PCM_FORMAT_S16_BE),
        ("transport_unclaimed", pcm::PCM_TRANSPORT_UNCLAIMED),
        ("transport_legacy_pull", pcm::PCM_TRANSPORT_LEGACY_PULL),
        ("transport_shared_clock", pcm::PCM_TRANSPORT_SHARED_CLOCK),
        ("flag_configuring", pcm::PCM_FLAG_CONFIGURING),
        ("flag_underrun_active", pcm::PCM_FLAG_UNDERRUN_ACTIVE),
        ("flag_fatal_error", pcm::PCM_FLAG_FATAL_ERROR),
    ] {
        constants.insert(name.into(), json!(value));
    }
    Value::Object(constants.into_iter().collect())
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
        "fork_save_control_prefix_size".into(),
        json!(pm::FORK_SAVE_CONTROL_PREFIX_SIZE),
    );
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
    use shared::kernel_scratch_wire as signal_wire;
    let entries = [
        (
            "SIG_SIGNUM",
            SIG_SIGNUM,
            signal_wire::SIGNAL_WORD_BYTES,
            "u32, signal number (0=none)",
        ),
        (
            "SIG_HANDLER",
            SIG_HANDLER,
            signal_wire::SIGNAL_WORD_BYTES,
            "u32, handler table index",
        ),
        (
            "SIG_FLAGS",
            SIG_FLAGS,
            signal_wire::SIGNAL_WORD_BYTES,
            "u32, sa_flags",
        ),
        (
            "SIG_SI_VALUE",
            SIG_SI_VALUE,
            signal_wire::SIGNAL_SI_VALUE_BYTES,
            "raw u64 sigval bits (wasm32 uses low 32 bits)",
        ),
        (
            "SIG_OLD_MASK",
            SIG_OLD_MASK,
            signal_wire::SIGNAL_OLD_MASK_BYTES,
            "u64 (LE), saved blocked mask",
        ),
        (
            "SIG_SI_CODE",
            SIG_SI_CODE,
            signal_wire::SIGNAL_WORD_BYTES,
            "i32, siginfo si_code",
        ),
        (
            "SIGINFO_WORD_1",
            SIGINFO_WORD_1,
            signal_wire::SIGNAL_WORD_BYTES,
            "i32, pid or SI_TIMER timer ID",
        ),
        (
            "SIGINFO_WORD_2",
            SIGINFO_WORD_2,
            signal_wire::SIGNAL_WORD_BYTES,
            "raw u32 uid bits or i32 SI_TIMER overrun",
        ),
        (
            "SIG_ALT_SP",
            SIG_ALT_SP,
            signal_wire::SIGNAL_ALT_SP_BYTES,
            "u64, caller-native alternate stack pointer or zero",
        ),
        (
            "SIG_ALT_SIZE",
            SIG_ALT_SIZE,
            signal_wire::SIGNAL_ALT_SIZE_BYTES,
            "u64, caller-native alternate stack size",
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
    m.insert("area_size".into(), json!(SIG_AREA_SIZE));
    m.insert("base".into(), json!(SIG_BASE));
    m.insert("delivery_size".into(), json!(SIG_DELIVERY_SIZE));
    m.insert(
        "reserved_tail_size".into(),
        json!(SIG_AREA_SIZE - SIG_DELIVERY_SIZE),
    );
    m.insert("slots".into(), Value::Array(list));
    Value::Object(m.into_iter().collect())
}

fn marshalled_structs() -> Value {
    use shared::dri::{
        WpkDrmBindForeignTexture, WpkDrmImportImage, WpkDrmEventVblank, WpkDrmGemClose, WpkDrmGetCap,
        WpkDrmGpuBoCreate, WpkDrmModeCardRes, WpkDrmModeCreateDumb, WpkDrmModeCrtcPageFlip,
        WpkDrmModeDestroyDumb, WpkDrmModeFbCmd2, WpkDrmModeGetConnector, WpkDrmModeGetCrtc,
        WpkDrmModeGetEncoder, WpkDrmModeMapDumb, WpkDrmModeModeinfo, WpkDrmPrimeHandle,
        WpkDrmVersion, WpkDrmWaitVblankReply, WpkDrmWaitVblankRequest,
        WpkDrmModeFbCmd, WpkDrmModeSetPlane,
    };
    use shared::fbdev::{FbBitfield, FbFixScreenInfo, FbVarScreenInfo};
    use shared::gl::{GlContextAttrs, GlInitInfo, GlMakeCurrent, GlQueryInfo, GlQueryInfo64, GlSubmitInfo, GlSurfaceAttrs, GlSurfaceFrontCopyInfo};
    use shared::oss::{AudioBufInfo, CountInfo};
    use shared::pcm::PcmSharedControl;
    use shared::{
        WasmDirent,
        WasmEpollEvent, WasmFlock, WasmPollFd, WasmRusageWire, WasmStat, WasmStatfs,
        WasmSysvMessageHeader, WasmTimespec,
    };

    let mut structs: JsonMap = BTreeMap::new();
    structs.insert(
        "AudioBufInfo".into(),
        build_typed_struct_layout(
            size_of::<AudioBufInfo>(),
            align_of::<AudioBufInfo>(),
            &[
                ("fragments", offset_of!(AudioBufInfo, fragments), 4, "i32"),
                ("fragstotal", offset_of!(AudioBufInfo, fragstotal), 4, "i32"),
                ("fragsize", offset_of!(AudioBufInfo, fragsize), 4, "i32"),
                ("bytes", offset_of!(AudioBufInfo, bytes), 4, "i32"),
            ],
        ),
    );
    structs.insert(
        "CountInfo".into(),
        build_typed_struct_layout(
            size_of::<CountInfo>(),
            align_of::<CountInfo>(),
            &[
                ("bytes", offset_of!(CountInfo, bytes), 4, "i32"),
                ("blocks", offset_of!(CountInfo, blocks), 4, "i32"),
                ("ptr", offset_of!(CountInfo, ptr), 4, "i32"),
            ],
        ),
    );
    structs.insert(
        "PcmSharedControl".into(),
        build_typed_struct_layout(
            size_of::<PcmSharedControl>(),
            align_of::<PcmSharedControl>(),
            &[
                ("magic", offset_of!(PcmSharedControl, magic), 4, "u32"),
                ("version", offset_of!(PcmSharedControl, version), 4, "u32"),
                ("header_bytes", offset_of!(PcmSharedControl, header_bytes), 4, "u32"),
                ("physical_capacity_bytes", offset_of!(PcmSharedControl, physical_capacity_bytes), 4, "u32"),
                ("active_capacity_bytes", offset_of!(PcmSharedControl, active_capacity_bytes), 4, "u32"),
                ("format", offset_of!(PcmSharedControl, format), 4, "u32"),
                ("rate", offset_of!(PcmSharedControl, rate), 4, "u32"),
                ("channels", offset_of!(PcmSharedControl, channels), 4, "u32"),
                ("frame_bytes", offset_of!(PcmSharedControl, frame_bytes), 4, "u32"),
                ("fragment_bytes", offset_of!(PcmSharedControl, fragment_bytes), 4, "u32"),
                ("fragment_count", offset_of!(PcmSharedControl, fragment_count), 4, "u32"),
                ("state", offset_of!(PcmSharedControl, state), 4, "u32"),
                ("generation", offset_of!(PcmSharedControl, generation), 4, "u32"),
                ("flags", offset_of!(PcmSharedControl, flags), 4, "u32"),
                ("transport_mode", offset_of!(PcmSharedControl, transport_mode), 4, "u32"),
                ("producer_seq", offset_of!(PcmSharedControl, producer_seq), 4, "u32"),
                ("producer_lo", offset_of!(PcmSharedControl, producer_lo), 4, "u32"),
                ("producer_hi", offset_of!(PcmSharedControl, producer_hi), 4, "u32"),
                ("consumer_seq", offset_of!(PcmSharedControl, consumer_seq), 4, "u32"),
                ("consumer_lo", offset_of!(PcmSharedControl, consumer_lo), 4, "u32"),
                ("consumer_hi", offset_of!(PcmSharedControl, consumer_hi), 4, "u32"),
                ("discard_seq", offset_of!(PcmSharedControl, discard_seq), 4, "u32"),
                ("discard_lo", offset_of!(PcmSharedControl, discard_lo), 4, "u32"),
                ("discard_hi", offset_of!(PcmSharedControl, discard_hi), 4, "u32"),
                ("underruns", offset_of!(PcmSharedControl, underruns), 4, "u32"),
                ("wake_seq", offset_of!(PcmSharedControl, wake_seq), 4, "u32"),
                ("reserved", offset_of!(PcmSharedControl, reserved), 24, "[u32; 6]"),
            ],
        ),
    );
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
            st_rdev,
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
        "WasmEpollEvent".into(),
        struct_layout!(WasmEpollEvent { events, _pad, data }),
    );
    structs.insert(
        "WasmSysvMessageHeader".into(),
        struct_layout!(WasmSysvMessageHeader { mtype }),
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
        "GlInitInfo".into(),
        struct_layout!(GlInitInfo { op_version, role, display_fd, display_id }),
    );
    structs.insert(
        "GlSubmitInfo".into(),
        struct_layout!(GlSubmitInfo { offset, length }),
    );
    structs.insert(
        "GlMakeCurrent".into(),
        struct_layout!(GlMakeCurrent { context_id, draw_surface_id, read_surface_id }),
    );
    structs.insert(
        "GlContextAttrs".into(),
        struct_layout!(GlContextAttrs {
            client_version,
            share_context_id,
            reserved,
            context_id
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
        "GlSurfaceFrontCopyInfo".into(),
        struct_layout!(GlSurfaceFrontCopyInfo {
            kind, width, height, config_id, target_reserved, copy_target_bo, format, pitch
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
        "GlQueryInfo64".into(),
        struct_layout!(GlQueryInfo64 {
            op, padding0, in_buf_ptr, in_buf_len, padding1,
            out_buf_ptr, out_buf_len, reserved
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
        struct_layout!(WpkDrmPrimeHandle { handle, flags, fd }),
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
        "WpkDrmImportImage".into(),
        struct_layout!(WpkDrmImportImage { bo_handle, ctx_id, width, height, format, pitch, offset, source }),
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
    structs.insert("WpkDrmModeFbCmd".into(), struct_layout!(WpkDrmModeFbCmd {
        fb_id, width, height, pitch, bpp, depth, handle
    }));
    structs.insert("WpkDrmModeSetPlane".into(), struct_layout!(WpkDrmModeSetPlane {
        plane_id, crtc_id, fb_id, flags, crtc_x, crtc_y, crtc_w, crtc_h,
        src_x, src_y, src_h, src_w
    }));
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
        ("WAIT_EVENT_CONTINUED", json!(shared::wait::EVENT_CONTINUED)),
        ("WAIT_WNOHANG", json!(shared::wait::WNOHANG)),
        ("WAIT_WUNTRACED", json!(shared::wait::WUNTRACED)),
        ("WAIT_WSTOPPED", json!(shared::wait::WSTOPPED)),
        ("WAIT_WEXITED", json!(shared::wait::WEXITED)),
        ("WAIT_WCONTINUED", json!(shared::wait::WCONTINUED)),
        ("WAIT_WNOWAIT", json!(shared::wait::WNOWAIT)),
        ("WAIT_CLD_EXITED", json!(shared::wait::CLD_EXITED)),
        ("WAIT_CLD_KILLED", json!(shared::wait::CLD_KILLED)),
        ("WAIT_CLD_STOPPED", json!(shared::wait::CLD_STOPPED)),
        ("WAIT_CLD_CONTINUED", json!(shared::wait::CLD_CONTINUED)),
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

fn ioctl_request_contracts() -> Value {
    let mut contracts: JsonMap = BTreeMap::new();
    for contract in shared::ioctl_contract::IOCTL_REQUEST_CONTRACTS {
        let mut value: JsonMap = BTreeMap::new();
        value.insert(
            "argKind".into(),
            json!(ioctl_arg_kind_name(contract.arg_kind)),
        );
        value.insert(
            "direction".into(),
            json!(ioctl_direction_name(contract.direction)),
        );
        value.insert("wasm32Size".into(), json!(contract.wasm32_size));
        value.insert("wasm64Size".into(), json!(contract.wasm64_size));
        contracts.insert(
            contract.request.to_string(),
            Value::Object(value.into_iter().collect()),
        );
    }
    Value::Object(contracts.into_iter().collect())
}

fn ioctl_request_families() -> Value {
    let families = shared::ioctl_contract::IOCTL_REQUEST_FAMILIES
        .iter()
        .map(|family| {
            let (fixed_size, max_caller_size) = match family.size {
                shared::ioctl_contract::IoctlFamilySize::Fixed(size) => {
                    (Some(size), None)
                }
                shared::ioctl_contract::IoctlFamilySize::CallerEncoded { max } => {
                    (None, Some(max))
                }
            };
            let mut value: JsonMap = BTreeMap::new();
            value.insert("dir".into(), json!(family.dir));
            value.insert("magic".into(), json!(family.magic));
            value.insert("nrFirst".into(), json!(family.nr_first));
            value.insert("nrLast".into(), json!(family.nr_last));
            value.insert(
                "direction".into(),
                json!(ioctl_direction_name(family.direction)),
            );
            value.insert("fixedSize".into(), json!(fixed_size));
            value.insert("maxCallerSize".into(), json!(max_caller_size));
            Value::Object(value.into_iter().collect())
        })
        .collect();
    Value::Array(families)
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
    m.insert(
        "kernel_export_lifecycles".into(),
        host_adapter_kernel_export_lifecycles(),
    );
    Value::Object(m.into_iter().collect())
}

fn host_adapter_kernel_export_lifecycles() -> Value {
    Value::Array(
        shared::abi::HOST_ADAPTER_KERNEL_EXPORTS
            .iter()
            .filter_map(|export| match export.policy {
                shared::abi::HostAdapterExportPolicy::OptionalUntil {
                    optional_since_abi,
                    required_from_abi,
                } => Some(json!({
                    "name": export.name,
                    "optional_since_abi": optional_since_abi,
                    "required_from_abi": required_from_abi,
                })),
                _ => None,
            })
            .collect(),
    )
}

/// Schedules must describe a real export and agree with the effective lists.
/// This also checks snapshots supplied to the compatibility classifier, so
/// metadata cannot disguise an early requirement as a future-only addition.
fn validate_host_adapter_export_lifecycles(host: &Value, exports: &Value) -> Result<(), String> {
    let Some(lifecycles) = host.get("kernel_export_lifecycles") else {
        return Ok(());
    };
    let records = lifecycles
        .as_array()
        .ok_or("kernel_export_lifecycles must be an array")?;
    let abi = host["manifest"]["abi_version"]
        .as_u64()
        .ok_or("host manifest ABI must be numeric")?;
    let required = host["required_kernel_exports"]
        .as_array()
        .ok_or("required kernel exports must be an array")?;
    let optional = host["optional_kernel_exports"]
        .as_array()
        .ok_or("optional kernel exports must be an array")?;
    let exports = exports
        .as_array()
        .ok_or("kernel exports must be an array")?;
    let mut previous = "";
    for record in records {
        let name = record["name"]
            .as_str()
            .ok_or("kernel export lifecycle name must be a string")?;
        let since = record["optional_since_abi"]
            .as_u64()
            .ok_or("optional_since_abi must be numeric")?;
        let from = record["required_from_abi"]
            .as_u64()
            .ok_or("required_from_abi must be numeric")?;
        if record.as_object().is_none_or(|fields| fields.len() != 3)
            || name <= previous
            || since == 0
            || since > abi
            || from <= since
            || from > u32::MAX as u64
        {
            return Err(format!(
                "invalid or unordered kernel export lifecycle: {record}"
            ));
        }
        if !exports
            .iter()
            .any(|export| export["name"].as_str() == Some(name))
        {
            return Err(format!(
                "scheduled kernel export {name:?} is missing from kernel Wasm"
            ));
        }
        let in_required = required.iter().any(|value| value.as_str() == Some(name));
        let in_optional = optional.iter().any(|value| value.as_str() == Some(name));
        if in_required != (abi >= from) || in_optional != (abi < from) {
            return Err(format!(
                "kernel export {name:?} does not match its ABI {from} promotion deadline"
            ));
        }
        previous = name;
    }
    Ok(())
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
    if let Some(copy_out_length) = desc.copy_out_length {
        m.insert(
            "copyOutLength".into(),
            syscall_arg_copy_out_length_json(copy_out_length),
        );
    }
    Value::Object(m.into_iter().collect())
}

fn syscall_arg_copy_out_length_json(
    length: shared::host_abi::SyscallArgCopyOutLength,
) -> Value {
    use shared::host_abi::SyscallArgCopyOutLength;

    let mut m: JsonMap = BTreeMap::new();
    match length {
        SyscallArgCopyOutLength::U32Field { arg_index, offset } => {
            m.insert("type".into(), json!("u32-field"));
            m.insert("argIndex".into(), json!(arg_index));
            m.insert("offset".into(), json!(offset));
        }
        SyscallArgCopyOutLength::ReturnValue {
            multiplier,
            max_value,
        } => {
            m.insert("type".into(), json!("return-value"));
            m.insert("multiplier".into(), json!(multiplier));
            m.insert("maxValue".into(), json!(max_value));
        }
    }
    Value::Object(m.into_iter().collect())
}

fn syscall_arg_size_json(size: shared::host_abi::SyscallArgSize) -> Value {
    use shared::host_abi::SyscallArgSize;

    let mut m: JsonMap = BTreeMap::new();
    match size {
        SyscallArgSize::CString {
            max_bytes,
            too_long_errno,
        } => {
            m.insert("type".into(), json!("cstring"));
            m.insert("maxBytes".into(), json!(max_bytes));
            m.insert("tooLongErrno".into(), json!(too_long_errno));
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
        SyscallArgSize::KernelDereferenced => {
            m.insert("type".into(), json!("kernel-dereferenced"));
        }
        SyscallArgSize::ProcessLayout {
            wasm32_size,
            wasm64_size,
        } => {
            m.insert("type".into(), json!("process-layout"));
            m.insert("wasm32Size".into(), json!(wasm32_size));
            m.insert("wasm64Size".into(), json!(wasm64_size));
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
        (Teardown, "Teardown"),
    ] {
        let mut m: JsonMap = BTreeMap::new();
        m.insert("number".into(), json!(n as u32));
        m.insert("name".into(), json!(name));
        list.push(Value::Object(m.into_iter().collect()));
    }
    Value::Array(list)
}

fn custom_sections() -> Value {
    let mut sections = vec![
        shared::abi::ABI_CUSTOM_SECTION,
        shared::abi::WPK_FORK_CAPABILITIES_SECTION,
        shared::abi::WPK_FORK_EXCEPTION_CODEC_SECTION,
        shared::abi::WPK_FORK_GC_CODEC_SECTION,
        shared::abi::WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
        shared::abi::WPK_FORK_IMPORTED_GLOBALS_SECTION,
        shared::abi::WPK_FORK_IMPORTED_TABLES_SECTION,
        shared::abi::WPK_FORK_MODULE_STATE_FORMAT_SECTION,
        shared::abi::WPK_FORK_STATIC_ROOT_CATALOG_SECTION,
        shared::abi::WPK_FORK_UNWIND_TRANSPORT_SECTION,
    ];
    sections.sort();
    Value::Array(sections.into_iter().map(Value::from).collect())
}

fn host_env_imports() -> Value {
    let mut list: Vec<&shared::abi::HostEnvImport> = shared::abi::HOST_ENV_IMPORTS.iter().collect();
    list.sort_by_key(|i| i.name);
    Value::Array(
        list.into_iter()
            .map(|i| {
                let mut m = serde_json::Map::new();
                m.insert("kind".into(), Value::from(i.kind.as_str()));
                m.insert("link_time".into(), Value::from(i.link_time));
                m.insert("name".into(), Value::from(i.name));
                Value::Object(m)
            })
            .collect(),
    )
}

/// The link-time allowance: one symbol per line, sorted. Every executable link
/// passes it to wasm-ld with `--allow-undefined-file`, so a program can leave a
/// symbol undefined only if the host supplies it (see
/// `shared::abi::HOST_ENV_IMPORTS`).
fn render_host_imports_file() -> String {
    let mut names: Vec<&str> = shared::abi::HOST_ENV_IMPORTS
        .iter()
        .filter(|i| i.link_time)
        .map(|i| i.name)
        .collect();
    names.sort();
    let mut out = names.join("\n");
    out.push('\n');
    out
}

fn process_expected_globals() -> Value {
    let mut list: Vec<&str> = shared::abi::PROCESS_EXPECTED_GLOBALS.to_vec();
    list.sort();
    Value::Array(list.into_iter().map(Value::from).collect())
}

fn program_artifact() -> Value {
    use shared::abi::{
        ProgramArtifactValueType, WPK_FORK_ACTIVATION_CONTINUATION_ENTRY_KNOWN_FLAGS,
        WPK_FORK_ACTIVATION_CONTINUATION_ENTRY_SIZE, WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE,
        WPK_FORK_ACTIVATION_CONTINUATIONS_KNOWN_FLAGS, WPK_FORK_ACTIVATION_CONTINUATIONS_MAGIC,
        WPK_FORK_ACTIVATION_CONTINUATIONS_OWNER, WPK_FORK_ACTIVATION_CONTINUATIONS_VERSION,
        WPK_FORK_CAP_ACTIVATION_STATE_SAFE, WPK_FORK_CAP_DYLINK_MAIN, WPK_FORK_CAP_KNOWN_MASK,
        WPK_FORK_CAP_REQUIRED_FLAGS, WPK_FORK_CAP_SIDE_ENTRY, WPK_FORK_CAPABILITIES_SECTION,
        WPK_FORK_CAPABILITIES_VERSION, WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE,
        WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE, WPK_FORK_EXCEPTION_CODEC_SECTION,
        WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE, WPK_FORK_EXCEPTION_CODEC_VERSION,
        WPK_FORK_EXCEPTION_IMPORT_ACTIVATION, WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE,
        WPK_FORK_GC_CODEC_HEADER_SIZE, WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE,
        WPK_FORK_GC_CODEC_MAGIC, WPK_FORK_GC_CODEC_SECTION, WPK_FORK_GC_CODEC_VERSION,
        WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL,
        WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT, WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT,
        WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER,
        WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE,
        WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE,
        WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE,
        WPK_FORK_IMPORTED_GLOBAL_BINDINGS_KNOWN_FLAGS, WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC,
        WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER, WPK_FORK_IMPORTED_GLOBAL_BINDINGS_VERSION,
        WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE, WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED,
        WPK_FORK_IMPORTED_GLOBAL_KNOWN_FLAGS, WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE,
        WPK_FORK_IMPORTED_GLOBALS_MAGIC, WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE,
        WPK_FORK_IMPORTED_GLOBALS_SECTION, WPK_FORK_IMPORTED_GLOBALS_VERSION,
        WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE,
        WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT, WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE,
        WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE, WPK_FORK_IMPORTED_TABLE_BINDINGS_KNOWN_FLAGS,
        WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC, WPK_FORK_IMPORTED_TABLE_BINDINGS_OWNER,
        WPK_FORK_IMPORTED_TABLE_BINDINGS_VERSION, WPK_FORK_IMPORTED_TABLE_FLAG_TABLE64,
        WPK_FORK_IMPORTED_TABLE_KNOWN_FLAGS, WPK_FORK_IMPORTED_TABLES_HEADER_SIZE,
        WPK_FORK_IMPORTED_TABLES_MAGIC, WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE,
        WPK_FORK_IMPORTED_TABLES_SECTION, WPK_FORK_IMPORTED_TABLES_VERSION,
        WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE, WPK_FORK_LINKED_FRAME_FLAG_ABORT_UNWINDING,
        WPK_FORK_LINKED_FRAME_FLAG_TRANSACTIONAL_NODES, WPK_FORK_LINKED_FRAME_FORMAT_MAGIC,
        WPK_FORK_LINKED_FRAME_FORMAT_SECTION, WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
        WPK_FORK_LINKED_FRAME_POINTER_WIDTHS, WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
        WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS, WPK_FORK_MODULE_STATE_ARENA_VERSION,
        WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT, WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED,
        WPK_FORK_MODULE_STATE_CHUNK_KNOWN_FLAGS, WPK_FORK_MODULE_STATE_CHUNK_MAGIC,
        WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE, WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE,
        WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE,
        WPK_FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS, WPK_FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER,
        WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES, WPK_FORK_MODULE_STATE_FORMAT_MAGIC,
        WPK_FORK_MODULE_STATE_FORMAT_SECTION, WPK_FORK_MODULE_STATE_FORMAT_VERSION,
        WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
        WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
        WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64,
        WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
        WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64, WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128,
        WPK_FORK_MODULE_STATE_KNOWN_FLAGS, WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT,
        WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT,
        WPK_FORK_MODULE_STATE_MODULE_RECORD_KNOWN_FLAGS,
        WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE,
        WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE, WPK_FORK_MODULE_STATE_POINTER_WIDTHS,
        WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT, WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE,
        WPK_FORK_MODULE_STATE_RECORD_KINDS, WPK_FORK_MODULE_STATE_RECORD_MAGIC,
        WPK_FORK_MODULE_STATE_RECORD_VERSION, WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_CAPACITY,
        WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_HEADER_SIZE,
        WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_KNOWN_FLAGS,
        WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_VERSION,
        WPK_FORK_MODULE_STATE_REPLAY_EVENT_SIZE, WPK_FORK_MODULE_STATE_REPLAY_EVENTS_HEADER_SIZE,
        WPK_FORK_MODULE_STATE_REPLAY_EVENTS_KNOWN_FLAGS, WPK_FORK_MODULE_STATE_REPLAY_EVENTS_MAGIC,
        WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER, WPK_FORK_MODULE_STATE_REPLAY_EVENTS_VERSION,
        WPK_FORK_MODULE_STATE_REQUIRED_FLAGS, WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET,
        WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE,
        WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE,
        WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES, WPK_FORK_MODULE_STATE_TABLE_KNOWN_FLAGS,
        WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE, WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT,
        WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE, WPK_FORK_REFERENCE_NODE_RECORD_SIZE,
        WPK_FORK_REFERENCE_SECTION_EDGES, WPK_FORK_REFERENCE_SECTION_NODES,
        WPK_FORK_REFERENCE_SECTION_SCALARS, WPK_FORK_REFERENCE_SECTION_VECTOR_ENTRIES,
        WPK_FORK_REFERENCE_SECTION_VECTOR_INDEX, WPK_FORK_REFERENCE_SEGMENT_HEADER_SIZE,
        WPK_FORK_REFERENCE_SEGMENT_KNOWN_FLAGS, WPK_FORK_REFERENCE_SEGMENT_MAGIC,
        WPK_FORK_REFERENCE_TRANSACTION_FLAG_SEALED, WPK_FORK_REFERENCE_TRANSACTION_KNOWN_FLAGS,
        WPK_FORK_REFERENCE_TRANSACTION_MAGIC, WPK_FORK_REFERENCE_TRANSACTION_MANIFEST_SIZE,
        WPK_FORK_REFERENCE_TRANSACTION_OWNER, WPK_FORK_REFERENCE_TRANSACTION_VERSION,
        WPK_FORK_REFERENCE_VECTOR_INDEX_SIZE, WPK_FORK_PROCESS_IMPORT, WPK_FORK_REQUIRED_EXPORTS,
        WPK_FORK_REQUIRED_IMPORTS, WPK_FORK_REQUIRED_TABLE_IMPORTS, WPK_FORK_STATIC_ROOT_CATALOG_EXPORT,
        WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE, WPK_FORK_STATIC_ROOT_CATALOG_MAGIC,
        WPK_FORK_STATIC_ROOT_CATALOG_SECTION, WPK_FORK_STATIC_ROOT_CATALOG_VERSION,
        WPK_FORK_STATIC_ROOT_HARVEST_EXPORT, WPK_FORK_UNWIND_TAG_IMPORT_MODULE,
        WPK_FORK_UNWIND_TAG_IMPORT_NAME, WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY,
        WPK_FORK_UNWIND_TRANSPORT_SECTION, WPK_FORK_UNWIND_TRANSPORT_VERSION,
        wpk_fork_linked_chunk_header_size, wpk_fork_linked_node_header_size,
        wpk_fork_module_state_chunk_header_size,
    };

    let value_types = |values: &[ProgramArtifactValueType]| {
        Value::Array(
            values
                .iter()
                .map(|value| {
                    Value::from(match value {
                        ProgramArtifactValueType::Pointer => "ptr",
                        ProgramArtifactValueType::I32 => "i32",
                        ProgramArtifactValueType::I64 => "i64",
                        ProgramArtifactValueType::FuncRef => "funcref",
                        ProgramArtifactValueType::ExternRef => "externref",
                        ProgramArtifactValueType::ExnRef => "exnref",
                        ProgramArtifactValueType::AnyRef => "anyref",
                    })
                })
                .collect(),
        )
    };

    let mut imports: Vec<Value> = WPK_FORK_REQUIRED_IMPORTS
        .iter()
        .map(|requirement| {
            let mut item: JsonMap = BTreeMap::new();
            item.insert("kind".into(), json!("func"));
            item.insert("module".into(), json!(requirement.module));
            item.insert("name".into(), json!(requirement.name));
            item.insert("params".into(), value_types(requirement.params));
            item.insert("results".into(), value_types(requirement.results));
            Value::Object(item.into_iter().collect())
        })
        .collect();
    imports.extend(WPK_FORK_REQUIRED_TABLE_IMPORTS.iter().map(|requirement| {
        let mut item: JsonMap = BTreeMap::new();
        item.insert("kind".into(), json!("table"));
        item.insert("module".into(), json!(requirement.module));
        item.insert("name".into(), json!(requirement.name));
        item.insert("table64".into(), json!(requirement.table64));
        item.insert(
            "element".into(),
            Value::from(match requirement.element {
                ProgramArtifactValueType::FuncRef => "funcref",
                ProgramArtifactValueType::ExternRef => "externref",
                ProgramArtifactValueType::ExnRef => "exnref",
                ProgramArtifactValueType::AnyRef => "anyref",
                other => panic!("table element requirement is not a reference: {other:?}"),
            }),
        );
        item.insert("minimum".into(), json!(requirement.minimum));
        item.insert("maximum".into(), json!(requirement.maximum));
        Value::Object(item.into_iter().collect())
    }));

    let exports = WPK_FORK_REQUIRED_EXPORTS
        .iter()
        .map(|requirement| {
            let mut item: JsonMap = BTreeMap::new();
            item.insert("kind".into(), json!("func"));
            item.insert("name".into(), json!(requirement.name));
            item.insert("params".into(), value_types(requirement.params));
            item.insert("results".into(), value_types(requirement.results));
            Value::Object(item.into_iter().collect())
        })
        .collect();

    let mut process_import: JsonMap = BTreeMap::new();
    process_import.insert("kind".into(), json!("func"));
    process_import.insert("module".into(), json!(WPK_FORK_PROCESS_IMPORT.module));
    process_import.insert("name".into(), json!(WPK_FORK_PROCESS_IMPORT.name));
    process_import.insert(
        "params".into(),
        value_types(WPK_FORK_PROCESS_IMPORT.params),
    );
    process_import.insert(
        "results".into(),
        value_types(WPK_FORK_PROCESS_IMPORT.results),
    );

    let pointer_widths = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS
        .iter()
        .map(|pointer_width| {
            let mut item: JsonMap = BTreeMap::new();
            item.insert("bytes".into(), json!(pointer_width));
            item.insert(
                "chunk_header_size".into(),
                json!(
                    wpk_fork_linked_chunk_header_size(*pointer_width)
                        .expect("supported pointer width must have a chunk header")
                ),
            );
            item.insert(
                "node_header_size".into(),
                json!(
                    wpk_fork_linked_node_header_size(*pointer_width)
                        .expect("supported pointer width must have a node header")
                ),
            );
            Value::Object(item.into_iter().collect())
        })
        .collect();

    let mut descriptor: JsonMap = BTreeMap::new();
    descriptor.insert(
        "alignment".into(),
        json!(WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT),
    );
    descriptor.insert(
        "descriptor_size".into(),
        json!(WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE),
    );
    descriptor.insert(
        "flags".into(),
        json!([
            {
                "bit": WPK_FORK_LINKED_FRAME_FLAG_ABORT_UNWINDING,
                "name": "abort_unwinding"
            },
            {
                "bit": WPK_FORK_LINKED_FRAME_FLAG_TRANSACTIONAL_NODES,
                "name": "transactional_nodes"
            }
        ]),
    );
    descriptor.insert(
        "magic_bytes".into(),
        json!(WPK_FORK_LINKED_FRAME_FORMAT_MAGIC),
    );
    descriptor.insert("pointer_widths".into(), Value::Array(pointer_widths));
    descriptor.insert(
        "required_flags".into(),
        json!(WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS),
    );
    descriptor.insert(
        "section".into(),
        json!(WPK_FORK_LINKED_FRAME_FORMAT_SECTION),
    );
    descriptor.insert(
        "version".into(),
        json!(WPK_FORK_LINKED_FRAME_FORMAT_VERSION),
    );

    let module_state_pointer_widths = WPK_FORK_MODULE_STATE_POINTER_WIDTHS
        .iter()
        .map(|pointer_width| {
            let mut item: JsonMap = BTreeMap::new();
            item.insert("bytes".into(), json!(pointer_width));
            item.insert(
                "chunk_header_size".into(),
                json!(
                    wpk_fork_module_state_chunk_header_size(*pointer_width)
                        .expect("supported pointer width must have a module-state chunk header")
                ),
            );
            Value::Object(item.into_iter().collect())
        })
        .collect();
    let module_state_record_kinds = WPK_FORK_MODULE_STATE_RECORD_KINDS
        .iter()
        .map(|kind| {
            let mut item: JsonMap = BTreeMap::new();
            item.insert("name".into(), json!(kind.name));
            item.insert("number".into(), json!(kind.number));
            Value::Object(item.into_iter().collect())
        })
        .collect();

    let mut module_state_descriptor: JsonMap = BTreeMap::new();
    module_state_descriptor.insert(
        "alignment".into(),
        json!(WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT),
    );
    module_state_descriptor.insert(
        "descriptor_size".into(),
        json!(WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE),
    );
    module_state_descriptor.insert(
        "flags".into(),
        json!([
            {
                "bit": WPK_FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER,
                "name": "root_prefix_pointer"
            },
            {
                "bit": WPK_FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS,
                "name": "explicit_owners"
            },
            {
                "bit": WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES,
                "name": "sparse_tables"
            }
        ]),
    );
    module_state_descriptor.insert(
        "known_flags".into(),
        json!(WPK_FORK_MODULE_STATE_KNOWN_FLAGS),
    );
    module_state_descriptor.insert(
        "magic_bytes".into(),
        json!(WPK_FORK_MODULE_STATE_FORMAT_MAGIC),
    );
    module_state_descriptor.insert(
        "required_flags".into(),
        json!(WPK_FORK_MODULE_STATE_REQUIRED_FLAGS),
    );
    module_state_descriptor.insert(
        "root_pointer_word_offset".into(),
        json!(WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET),
    );
    module_state_descriptor.insert(
        "section".into(),
        json!(WPK_FORK_MODULE_STATE_FORMAT_SECTION),
    );
    module_state_descriptor.insert(
        "version".into(),
        json!(WPK_FORK_MODULE_STATE_FORMAT_VERSION),
    );

    let mut module_state_record: JsonMap = BTreeMap::new();
    module_state_record.insert(
        "alignment".into(),
        json!(WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT),
    );
    module_state_record.insert(
        "header_size".into(),
        json!(WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE),
    );
    module_state_record.insert("kinds".into(), Value::Array(module_state_record_kinds));
    module_state_record.insert(
        "magic_bytes".into(),
        json!(WPK_FORK_MODULE_STATE_RECORD_MAGIC),
    );
    module_state_record.insert(
        "version".into(),
        json!(WPK_FORK_MODULE_STATE_RECORD_VERSION),
    );

    let mut module_state_arena: JsonMap = BTreeMap::new();
    module_state_arena.insert(
        "chunk_flags".into(),
        json!([
            {"bit": WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT, "name": "root"},
            {"bit": WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED, "name": "sealed"}
        ]),
    );
    module_state_arena.insert(
        "chunk_magic_bytes".into(),
        json!(WPK_FORK_MODULE_STATE_CHUNK_MAGIC),
    );
    module_state_arena.insert(
        "known_chunk_flags".into(),
        json!(WPK_FORK_MODULE_STATE_CHUNK_KNOWN_FLAGS),
    );
    module_state_arena.insert(
        "pointer_widths".into(),
        Value::Array(module_state_pointer_widths),
    );
    module_state_arena.insert(
        "record".into(),
        Value::Object(module_state_record.into_iter().collect()),
    );
    module_state_arena.insert("version".into(), json!(WPK_FORK_MODULE_STATE_ARENA_VERSION));

    let mut module_payload: JsonMap = BTreeMap::new();
    module_payload.insert(
        "known_flags".into(),
        json!(WPK_FORK_MODULE_STATE_MODULE_RECORD_KNOWN_FLAGS),
    );
    module_payload.insert(
        "payload_size".into(),
        json!(WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE),
    );
    module_payload.insert(
        "template_id_size".into(),
        json!(WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE),
    );

    let mut mutable_global_payload: JsonMap = BTreeMap::new();
    mutable_global_payload.insert(
        "header_size".into(),
        json!(WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE),
    );
    mutable_global_payload.insert(
        "value_types".into(),
        json!([
            {"number": WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32, "name": "i32", "bytes": 4},
            {"number": WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64, "name": "i64", "bytes": 8},
            {"number": WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32, "name": "f32", "bytes": 4},
            {"number": WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64, "name": "f64", "bytes": 8},
            {"number": WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128, "name": "v128", "bytes": 16},
            {"number": WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF, "name": "funcref_recipe", "bytes": 4},
            {"number": WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF, "name": "externref_recipe", "bytes": 4},
            {"number": WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF, "name": "exnref_recipe", "bytes": 4},
            {"number": WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF, "name": "anyref_recipe", "bytes": 4}
        ]),
    );

    let mut table_payload: JsonMap = BTreeMap::new();
    table_payload.insert(
        "baseline_fingerprint_size".into(),
        json!(WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE),
    );
    table_payload.insert(
        "descriptor_payload_size".into(),
        json!(WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE),
    );
    table_payload.insert(
        "flags".into(),
        json!([
            {
                "bit": WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES,
                "name": "sparse_overrides"
            }
        ]),
    );
    table_payload.insert(
        "known_flags".into(),
        json!(WPK_FORK_MODULE_STATE_TABLE_KNOWN_FLAGS),
    );
    table_payload.insert(
        "max_page_shift".into(),
        json!(WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT),
    );
    table_payload.insert(
        "min_page_shift".into(),
        json!(WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT),
    );
    table_payload.insert(
        "page_shift".into(),
        json!(WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT),
    );
    table_payload.insert(
        "page_header_size".into(),
        json!(WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE),
    );
    table_payload.insert(
        "run_header_size".into(),
        json!(WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE),
    );

    let mut element_segments_payload: JsonMap = BTreeMap::new();
    element_segments_payload.insert(
        "header_size".into(),
        json!(WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE),
    );

    let mut data_segments_payload: JsonMap = BTreeMap::new();
    data_segments_payload.insert(
        "header_size".into(),
        json!(WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE),
    );

    let mut replay_events_payload: JsonMap = BTreeMap::new();
    replay_events_payload.insert(
        "entry_size".into(),
        json!(WPK_FORK_MODULE_STATE_REPLAY_EVENT_SIZE),
    );
    replay_events_payload.insert(
        "magic".into(),
        json!(WPK_FORK_MODULE_STATE_REPLAY_EVENTS_MAGIC),
    );
    replay_events_payload.insert(
        "header_size".into(),
        json!(WPK_FORK_MODULE_STATE_REPLAY_EVENTS_HEADER_SIZE),
    );
    replay_events_payload.insert(
        "known_flags".into(),
        json!(WPK_FORK_MODULE_STATE_REPLAY_EVENTS_KNOWN_FLAGS),
    );
    replay_events_payload.insert(
        "owner".into(),
        json!(WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER),
    );
    replay_events_payload.insert(
        "version".into(),
        json!(WPK_FORK_MODULE_STATE_REPLAY_EVENTS_VERSION),
    );
    replay_events_payload.insert(
        "segment_capacity".into(),
        json!(WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_CAPACITY),
    );
    replay_events_payload.insert(
        "segment_header_size".into(),
        json!(WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_HEADER_SIZE),
    );
    replay_events_payload.insert(
        "segment_known_flags".into(),
        json!(WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_KNOWN_FLAGS),
    );
    replay_events_payload.insert(
        "segment_version".into(),
        json!(WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_VERSION),
    );

    let mut reference_transaction_payload: JsonMap = BTreeMap::new();
    reference_transaction_payload.insert(
        "known_flags".into(),
        json!(WPK_FORK_REFERENCE_TRANSACTION_KNOWN_FLAGS),
    );
    reference_transaction_payload
        .insert("magic".into(), json!(WPK_FORK_REFERENCE_TRANSACTION_MAGIC));
    reference_transaction_payload.insert(
        "manifest_size".into(),
        json!(WPK_FORK_REFERENCE_TRANSACTION_MANIFEST_SIZE),
    );
    reference_transaction_payload.insert(
        "node_record_size".into(),
        json!(WPK_FORK_REFERENCE_NODE_RECORD_SIZE),
    );
    reference_transaction_payload
        .insert("owner".into(), json!(WPK_FORK_REFERENCE_TRANSACTION_OWNER));
    reference_transaction_payload.insert(
        "sealed_flag".into(),
        json!(WPK_FORK_REFERENCE_TRANSACTION_FLAG_SEALED),
    );
    reference_transaction_payload.insert(
        "sections".into(),
        json!([
            {"number": WPK_FORK_REFERENCE_SECTION_NODES, "name": "nodes"},
            {"number": WPK_FORK_REFERENCE_SECTION_EDGES, "name": "edges"},
            {"number": WPK_FORK_REFERENCE_SECTION_SCALARS, "name": "scalars"},
            {"number": WPK_FORK_REFERENCE_SECTION_VECTOR_INDEX, "name": "vector_index"},
            {"number": WPK_FORK_REFERENCE_SECTION_VECTOR_ENTRIES, "name": "vector_entries"}
        ]),
    );
    reference_transaction_payload.insert(
        "segment_header_size".into(),
        json!(WPK_FORK_REFERENCE_SEGMENT_HEADER_SIZE),
    );
    reference_transaction_payload.insert(
        "segment_known_flags".into(),
        json!(WPK_FORK_REFERENCE_SEGMENT_KNOWN_FLAGS),
    );
    reference_transaction_payload.insert(
        "segment_magic".into(),
        json!(WPK_FORK_REFERENCE_SEGMENT_MAGIC),
    );
    reference_transaction_payload.insert(
        "vector_index_size".into(),
        json!(WPK_FORK_REFERENCE_VECTOR_INDEX_SIZE),
    );
    reference_transaction_payload.insert(
        "version".into(),
        json!(WPK_FORK_REFERENCE_TRANSACTION_VERSION),
    );

    let mut imported_global_bindings_payload: JsonMap = BTreeMap::new();
    imported_global_bindings_payload.insert(
        "binding_kinds".into(),
        json!([
            {"number": WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER, "name": "raw_number"},
            {"number": WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT, "name": "raw_bigint"},
            {"number": WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE, "name": "raw_reference"},
            {"number": WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL, "name": "activation_global"},
            {"number": WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT, "name": "base_import"}
        ]),
    );
    imported_global_bindings_payload.insert(
        "entry_fields".into(),
        json!([
            {"name": "consumer_activation", "offset": 0, "size": 4},
            {"name": "consumer_owner", "offset": 4, "size": 4},
            {"name": "source_activation", "offset": 8, "size": 4},
            {"name": "source_owner", "offset": 12, "size": 4},
            {"name": "reserved", "offset": 16, "size": 4},
            {"name": "recipe_id", "offset": 20, "size": 4},
            {"name": "raw_bits", "offset": 24, "size": 8},
            {"name": "binding_kind", "offset": 32, "size": 1},
            {"name": "import_flags", "offset": 33, "size": 1},
            {"name": "value_type", "offset": 34, "size": 1},
            {"name": "reserved", "offset": 35, "size": 5}
        ]),
    );
    imported_global_bindings_payload.insert(
        "entry_size".into(),
        json!(WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE),
    );
    imported_global_bindings_payload.insert(
        "header_size".into(),
        json!(WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE),
    );
    imported_global_bindings_payload.insert(
        "known_flags".into(),
        json!(WPK_FORK_IMPORTED_GLOBAL_BINDINGS_KNOWN_FLAGS),
    );
    imported_global_bindings_payload.insert(
        "magic_bytes".into(),
        json!(WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC),
    );
    imported_global_bindings_payload.insert(
        "owner".into(),
        json!(WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER),
    );
    imported_global_bindings_payload.insert(
        "version".into(),
        json!(WPK_FORK_IMPORTED_GLOBAL_BINDINGS_VERSION),
    );

    let mut activation_continuations_payload: JsonMap = BTreeMap::new();
    activation_continuations_payload.insert(
        "entry_fields".into(),
        json!([
            {"name": "activation_id", "offset": 0, "size": 4},
            {"name": "flags", "offset": 4, "size": 4},
            {"name": "root", "offset": 8, "size": 8}
        ]),
    );
    activation_continuations_payload.insert(
        "entry_known_flags".into(),
        json!(WPK_FORK_ACTIVATION_CONTINUATION_ENTRY_KNOWN_FLAGS),
    );
    activation_continuations_payload.insert(
        "entry_size".into(),
        json!(WPK_FORK_ACTIVATION_CONTINUATION_ENTRY_SIZE),
    );
    activation_continuations_payload.insert(
        "header_size".into(),
        json!(WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE),
    );
    activation_continuations_payload.insert(
        "known_flags".into(),
        json!(WPK_FORK_ACTIVATION_CONTINUATIONS_KNOWN_FLAGS),
    );
    activation_continuations_payload.insert(
        "magic_bytes".into(),
        json!(WPK_FORK_ACTIVATION_CONTINUATIONS_MAGIC),
    );
    activation_continuations_payload.insert(
        "owner".into(),
        json!(WPK_FORK_ACTIVATION_CONTINUATIONS_OWNER),
    );
    activation_continuations_payload.insert(
        "version".into(),
        json!(WPK_FORK_ACTIVATION_CONTINUATIONS_VERSION),
    );

    let mut imported_table_bindings_payload: JsonMap = BTreeMap::new();
    imported_table_bindings_payload.insert(
        "binding_kinds".into(),
        json!([
            {
                "number": WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE,
                "name": "activation_table"
            },
            {
                "number": WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT,
                "name": "base_import"
            }
        ]),
    );
    imported_table_bindings_payload.insert(
        "entry_fields".into(),
        json!([
            {"name": "consumer_activation", "offset": 0, "size": 4},
            {"name": "consumer_owner", "offset": 4, "size": 4},
            {"name": "source_activation", "offset": 8, "size": 4},
            {"name": "source_owner", "offset": 12, "size": 4},
            {"name": "reserved", "offset": 16, "size": 4},
            {"name": "binding_kind", "offset": 20, "size": 1},
            {"name": "reserved", "offset": 21, "size": 3}
        ]),
    );
    imported_table_bindings_payload.insert(
        "entry_size".into(),
        json!(WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE),
    );
    imported_table_bindings_payload.insert(
        "header_size".into(),
        json!(WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE),
    );
    imported_table_bindings_payload.insert(
        "known_flags".into(),
        json!(WPK_FORK_IMPORTED_TABLE_BINDINGS_KNOWN_FLAGS),
    );
    imported_table_bindings_payload.insert(
        "magic_bytes".into(),
        json!(WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC),
    );
    imported_table_bindings_payload.insert(
        "owner".into(),
        json!(WPK_FORK_IMPORTED_TABLE_BINDINGS_OWNER),
    );
    imported_table_bindings_payload.insert(
        "version".into(),
        json!(WPK_FORK_IMPORTED_TABLE_BINDINGS_VERSION),
    );

    let mut module_state_payloads: JsonMap = BTreeMap::new();
    module_state_payloads.insert(
        "activation_continuations".into(),
        Value::Object(activation_continuations_payload.into_iter().collect()),
    );
    module_state_payloads.insert(
        "data_segments".into(),
        Value::Object(data_segments_payload.into_iter().collect()),
    );
    module_state_payloads.insert(
        "element_segments".into(),
        Value::Object(element_segments_payload.into_iter().collect()),
    );
    module_state_payloads.insert(
        "imported_global_bindings".into(),
        Value::Object(imported_global_bindings_payload.into_iter().collect()),
    );
    module_state_payloads.insert(
        "imported_table_bindings".into(),
        Value::Object(imported_table_bindings_payload.into_iter().collect()),
    );
    module_state_payloads.insert(
        "module".into(),
        Value::Object(module_payload.into_iter().collect()),
    );
    module_state_payloads.insert(
        "mutable_global".into(),
        Value::Object(mutable_global_payload.into_iter().collect()),
    );
    module_state_payloads.insert(
        "replay_events".into(),
        Value::Object(replay_events_payload.into_iter().collect()),
    );
    module_state_payloads.insert(
        "reference_transaction".into(),
        Value::Object(reference_transaction_payload.into_iter().collect()),
    );
    module_state_payloads.insert(
        "table".into(),
        Value::Object(table_payload.into_iter().collect()),
    );

    let mut module_state: JsonMap = BTreeMap::new();
    module_state.insert(
        "arena".into(),
        Value::Object(module_state_arena.into_iter().collect()),
    );
    module_state.insert(
        "descriptor".into(),
        Value::Object(module_state_descriptor.into_iter().collect()),
    );
    module_state.insert(
        "record_payloads".into(),
        Value::Object(module_state_payloads.into_iter().collect()),
    );

    let mut imported_globals: JsonMap = BTreeMap::new();
    imported_globals.insert(
        "header_size".into(),
        json!(WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE),
    );
    imported_globals.insert(
        "known_flags".into(),
        json!(WPK_FORK_IMPORTED_GLOBAL_KNOWN_FLAGS),
    );
    imported_globals.insert("magic_bytes".into(), json!(WPK_FORK_IMPORTED_GLOBALS_MAGIC));
    imported_globals.insert(
        "mutable_flag".into(),
        json!(WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE),
    );
    imported_globals.insert(
        "shared_flag".into(),
        json!(WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED),
    );
    imported_globals.insert(
        "record_header_size".into(),
        json!(WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE),
    );
    imported_globals.insert(
        "record_fields".into(),
        json!([
            {"name": "record_size", "offset": 0, "size": 4},
            {"name": "owner", "offset": 4, "size": 4},
            {"name": "value_type", "offset": 8, "size": 1},
            {"name": "flags", "offset": 9, "size": 1},
            {"name": "reserved", "offset": 10, "size": 2},
            {"name": "module_name_length", "offset": 12, "size": 4},
            {"name": "field_name_length", "offset": 16, "size": 4},
            {"name": "reserved_zero", "offset": 20, "size": 4}
        ]),
    );
    imported_globals.insert("section".into(), json!(WPK_FORK_IMPORTED_GLOBALS_SECTION));
    imported_globals.insert("version".into(), json!(WPK_FORK_IMPORTED_GLOBALS_VERSION));

    let mut imported_tables: JsonMap = BTreeMap::new();
    imported_tables.insert(
        "header_size".into(),
        json!(WPK_FORK_IMPORTED_TABLES_HEADER_SIZE),
    );
    imported_tables.insert(
        "known_flags".into(),
        json!(WPK_FORK_IMPORTED_TABLE_KNOWN_FLAGS),
    );
    imported_tables.insert("magic_bytes".into(), json!(WPK_FORK_IMPORTED_TABLES_MAGIC));
    imported_tables.insert(
        "record_header_size".into(),
        json!(WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE),
    );
    imported_tables.insert(
        "record_fields".into(),
        json!([
            {"name": "record_size", "offset": 0, "size": 4},
            {"name": "owner", "offset": 4, "size": 4},
            {"name": "element_type", "offset": 8, "size": 1},
            {"name": "flags", "offset": 9, "size": 1},
            {"name": "reserved", "offset": 10, "size": 2},
            {"name": "module_name_length", "offset": 12, "size": 4},
            {"name": "field_name_length", "offset": 16, "size": 4},
            {"name": "reserved_zero", "offset": 20, "size": 4}
        ]),
    );
    imported_tables.insert("section".into(), json!(WPK_FORK_IMPORTED_TABLES_SECTION));
    imported_tables.insert(
        "table64_flag".into(),
        json!(WPK_FORK_IMPORTED_TABLE_FLAG_TABLE64),
    );
    imported_tables.insert("version".into(), json!(WPK_FORK_IMPORTED_TABLES_VERSION));

    let mut exception_codec: JsonMap = BTreeMap::new();
    exception_codec.insert(
        "activation_import".into(),
        json!({
            "module": WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            "name": WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
            "type": "i32",
            "mutable": false
        }),
    );
    exception_codec.insert(
        "header_size".into(),
        json!(WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE),
    );
    exception_codec.insert("section".into(), json!(WPK_FORK_EXCEPTION_CODEC_SECTION));
    exception_codec.insert(
        "tag_record_size".into(),
        json!(WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE),
    );
    exception_codec.insert("version".into(), json!(WPK_FORK_EXCEPTION_CODEC_VERSION));

    let mut gc_codec: JsonMap = BTreeMap::new();
    gc_codec.insert(
        "field_record".into(),
        json!({
            "size": WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE,
            "fields": [
                {"name": "storage", "offset": 0, "size": 1},
                {"name": "flags", "offset": 1, "size": 1},
                {"name": "reserved", "offset": 2, "size": 2},
                {"name": "scalar_offset_or_none", "offset": 4, "size": 4},
                {"name": "reference_ordinal_or_none", "offset": 8, "size": 4}
            ]
        }),
    );
    gc_codec.insert("header_size".into(), json!(WPK_FORK_GC_CODEC_HEADER_SIZE));
    gc_codec.insert(
        "layout_record".into(),
        json!({
            "size": WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE,
            "fields": [
                {"name": "layout_id", "offset": 0, "size": 4},
                {"name": "type_ordinal", "offset": 4, "size": 4},
                {"name": "kind", "offset": 8, "size": 1},
                {"name": "constructor", "offset": 9, "size": 1},
                {"name": "flags", "offset": 10, "size": 2},
                {"name": "snapshot_scalar_len_or_stride", "offset": 12, "size": 4},
                {"name": "field_start", "offset": 16, "size": 4},
                {"name": "field_count", "offset": 20, "size": 4},
                {"name": "super_type_ordinal_or_none", "offset": 24, "size": 4},
                {"name": "base_layout_id", "offset": 28, "size": 4},
                {"name": "auxiliary", "offset": 32, "size": 4},
                {"name": "provenance_scalar_len", "offset": 36, "size": 4},
                {"name": "provenance_ref_count", "offset": 40, "size": 4}
            ]
        }),
    );
    gc_codec.insert("magic_bytes".into(), json!(WPK_FORK_GC_CODEC_MAGIC));
    gc_codec.insert("section".into(), json!(WPK_FORK_GC_CODEC_SECTION));
    gc_codec.insert(
        "transit_table".into(),
        json!({
            "module": shared::abi::WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            "name": shared::abi::WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT,
            "table64": false,
            "element": "anyref",
            "minimum": 1,
            "maximum": null
        }),
    );
    gc_codec.insert("version".into(), json!(WPK_FORK_GC_CODEC_VERSION));

    let mut unwind_transport: JsonMap = BTreeMap::new();
    unwind_transport.insert(
        "import".into(),
        json!({
            "module": WPK_FORK_UNWIND_TAG_IMPORT_MODULE,
            "name": WPK_FORK_UNWIND_TAG_IMPORT_NAME,
            "kind": "tag"
        }),
    );
    unwind_transport.insert(
        "payload_arity".into(),
        json!(WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY),
    );
    unwind_transport.insert("section".into(), json!(WPK_FORK_UNWIND_TRANSPORT_SECTION));
    unwind_transport.insert("version".into(), json!(WPK_FORK_UNWIND_TRANSPORT_VERSION));

    let mut static_root_catalog: JsonMap = BTreeMap::new();
    static_root_catalog.insert("export".into(), json!(WPK_FORK_STATIC_ROOT_CATALOG_EXPORT));
    static_root_catalog.insert(
        "harvest_export".into(),
        json!(WPK_FORK_STATIC_ROOT_HARVEST_EXPORT),
    );
    static_root_catalog.insert(
        "header_size".into(),
        json!(WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE),
    );
    static_root_catalog.insert(
        "magic_bytes".into(),
        json!(WPK_FORK_STATIC_ROOT_CATALOG_MAGIC),
    );
    static_root_catalog.insert(
        "section".into(),
        json!(WPK_FORK_STATIC_ROOT_CATALOG_SECTION),
    );
    static_root_catalog.insert(
        "version".into(),
        json!(WPK_FORK_STATIC_ROOT_CATALOG_VERSION),
    );

    let mut capabilities: JsonMap = BTreeMap::new();
    capabilities.insert("section".into(), json!(WPK_FORK_CAPABILITIES_SECTION));
    capabilities.insert("version".into(), json!(WPK_FORK_CAPABILITIES_VERSION));
    capabilities.insert("known_mask".into(), json!(WPK_FORK_CAP_KNOWN_MASK));
    capabilities.insert("required_flags".into(), json!(WPK_FORK_CAP_REQUIRED_FLAGS));
    capabilities.insert(
        "flags".into(),
        json!([
            {"bit": WPK_FORK_CAP_SIDE_ENTRY, "name": "side_entry"},
            {"bit": WPK_FORK_CAP_DYLINK_MAIN, "name": "dylink_main"},
            {
                "bit": WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
                "name": "activation_state_safe"
            }
        ]),
    );

    let mut fork: JsonMap = BTreeMap::new();
    fork.insert(
        "capabilities".into(),
        Value::Object(capabilities.into_iter().collect()),
    );
    fork.insert(
        "exception_codec".into(),
        Value::Object(exception_codec.into_iter().collect()),
    );
    fork.insert(
        "gc_codec".into(),
        Value::Object(gc_codec.into_iter().collect()),
    );
    fork.insert(
        "static_root_catalog".into(),
        Value::Object(static_root_catalog.into_iter().collect()),
    );
    fork.insert(
        "unwind_transport".into(),
        Value::Object(unwind_transport.into_iter().collect()),
    );
    fork.insert(
        "linked_frame_descriptor".into(),
        Value::Object(descriptor.into_iter().collect()),
    );
    fork.insert(
        "imported_globals".into(),
        Value::Object(imported_globals.into_iter().collect()),
    );
    fork.insert(
        "imported_tables".into(),
        Value::Object(imported_tables.into_iter().collect()),
    );
    fork.insert(
        "module_state".into(),
        Value::Object(module_state.into_iter().collect()),
    );
    fork.insert(
        "process_import".into(),
        Value::Object(process_import.into_iter().collect()),
    );
    fork.insert(
        "process_modes".into(),
        json!({
            "fork": shared::fork_contract::MODE_FORK,
            "vfork": shared::fork_contract::MODE_VFORK,
        }),
    );
    fork.insert("required_exports".into(), Value::Array(exports));
    fork.insert("required_imports".into(), Value::Array(imports));

    let heap_safepoint = shared::abi::HEAP_SAFEPOINT_PROCESS_IMPORT;
    let mut heap_safepoint_import: JsonMap = BTreeMap::new();
    heap_safepoint_import.insert("kind".into(), json!("func"));
    heap_safepoint_import.insert("module".into(), json!(heap_safepoint.module));
    heap_safepoint_import.insert("name".into(), json!(heap_safepoint.name));
    heap_safepoint_import.insert("params".into(), value_types(heap_safepoint.params));
    heap_safepoint_import.insert("results".into(), value_types(heap_safepoint.results));

    let mut artifact: JsonMap = BTreeMap::new();
    artifact.insert(
        "fork_instrumentation".into(),
        Value::Object(fork.into_iter().collect()),
    );
    artifact.insert(
        "heap_safepoint_import".into(),
        Value::Object(heap_safepoint_import.into_iter().collect()),
    );
    Value::Object(artifact.into_iter().collect())
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

/// Record the module's *import* section: the contract every host must
/// satisfy to instantiate the kernel.
///
/// This is the mirror of `kernel_exports`, and the polarity of its
/// compatibility rule is inverted (see
/// `classify_removal_only_array_by_module_name`): an import is a
/// *requirement placed on the host*, so adding one is breaking and
/// removing one is compatible.
///
/// Recorded from the **built artifact**, not from the source-level
/// extern block. Those differ: a declared-but-uncalled import is
/// dead-code-eliminated by LLVM and never reaches the module, so the
/// host is not in fact required to supply it. The artifact is the
/// contract.
///
/// Known residual: the snapshot is built from the wasm32 kernel
/// (`scripts/check-abi-version.sh` builds
/// `target/wasm32-unknown-unknown/release/kandelo_kernel.wasm`), the only
/// kernel any script builds. An import declared with a pointer-width type
/// (`usize`, `isize`, or a raw pointer) renders as `i32` here and would
/// render as `i64` on a wasm64 kernel, so a drift that only a wasm64 kernel
/// would show is not covered. Count the pointer-width imports in the
/// `extern` block of `crates/kernel/src/wasm_api.rs` rather than trusting
/// a list here; such a list goes stale as imports are removed.
/// Explicitly-sized parameters (the `u32 -> u64` widening of
/// `host_proc_read_bytes` / `host_proc_write_bytes` that motivated this
/// section) are covered on wasm32.
fn kernel_imports(bytes: &[u8]) -> Result<Value, String> {
    use wasmparser::{CompositeInnerType, FuncType, Imports, Parser, Payload, TypeRef};

    let mut func_types: Vec<FuncType> = Vec::new();
    let mut imports: Vec<(String, String, TypeRef)> = Vec::new();

    for payload in Parser::new(0).parse_all(bytes) {
        let p = payload.map_err(|e| format!("parse wasm: {e}"))?;
        match p {
            Payload::TypeSection(r) => {
                for rec in r {
                    let rec = rec.map_err(|e| format!("type section: {e}"))?;
                    for st in rec.types() {
                        match &st.composite_type.inner {
                            CompositeInnerType::Func(f) => func_types.push(f.clone()),
                            // Keep index arithmetic correct for
                            // non-func composite types, exactly as
                            // `kernel_exports` does.
                            _ => func_types.push(FuncType::new([], [])),
                        }
                    }
                }
            }
            Payload::ImportSection(r) => {
                for group in r {
                    let group = group.map_err(|e| format!("import section: {e}"))?;
                    // Same three import-group encodings `kernel_exports`
                    // handles. Only `Single` appears in stock LLVM
                    // output; the compact-imports encodings are handled
                    // so a toolchain change cannot silently empty this
                    // section.
                    match group {
                        Imports::Single(_, imp) => {
                            imports.push((imp.module.to_string(), imp.name.to_string(), imp.ty));
                        }
                        Imports::Compact1 { module, items } => {
                            for item in items {
                                let item = item.map_err(|e| format!("import section: {e}"))?;
                                imports.push((module.to_string(), item.name.to_string(), item.ty));
                            }
                        }
                        Imports::Compact2 { module, ty, names } => {
                            for name in names {
                                let name = name.map_err(|e| format!("import section: {e}"))?;
                                imports.push((module.to_string(), name.to_string(), ty));
                            }
                        }
                    }
                }
            }
            // The import section precedes every section that could
            // affect it, so stop as soon as one that follows appears.
            Payload::FunctionSection(_) => break,
            _ => {}
        }
    }

    // Deterministic order, matching the export path. No filter: unlike
    // exports (where `export_is_tracked` drops LLVM's toolchain noise)
    // every import is by construction something a host must provide,
    // so completeness is the point.
    imports.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));

    let mut list = Vec::new();
    for (module, name, ty) in imports {
        let mut m: JsonMap = BTreeMap::new();
        m.insert("module".into(), json!(module));
        m.insert("name".into(), json!(name));
        match ty {
            TypeRef::Func(ti) | TypeRef::FuncExact(ti) => {
                m.insert("kind".into(), json!("func"));
                let sig = func_types
                    .get(ti as usize)
                    .map(format_func_type)
                    .unwrap_or_else(|| "<unknown>".into());
                m.insert("signature".into(), json!(sig));
            }
            TypeRef::Memory(mt) => {
                // Shared-ness and the limits are part of the channel
                // handshake: `crates/host-native/src/lib.rs` reads the
                // same three facts to size the guest memory. Recording
                // them here stops that from being an independent
                // second reading of one fact.
                m.insert("kind".into(), json!("memory"));
                m.insert("memory64".into(), json!(mt.memory64));
                m.insert("shared".into(), json!(mt.shared));
                m.insert("minimum_pages".into(), json!(mt.initial));
                m.insert("maximum_pages".into(), json!(mt.maximum));
            }
            TypeRef::Global(gt) => {
                m.insert("kind".into(), json!("global"));
                m.insert("type".into(), json!(val_type_name(&gt.content_type)));
                m.insert("mutable".into(), json!(gt.mutable));
            }
            TypeRef::Table(tt) => {
                m.insert("kind".into(), json!("table"));
                m.insert("table64".into(), json!(tt.table64));
                m.insert("minimum".into(), json!(tt.initial));
                m.insert("maximum".into(), json!(tt.maximum));
            }
            TypeRef::Tag(tag) => {
                m.insert("kind".into(), json!("tag"));
                let sig = func_types
                    .get(tag.func_type_idx as usize)
                    .map(format_func_type)
                    .unwrap_or_else(|| "<unknown>".into());
                m.insert("signature".into(), json!(sig));
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
    /// The top-level section of each `breaking` item, index for index.
    breaking_sections: Vec<String>,
}

impl CompatReport {
    /// Attribute the breaking items pushed since `before` to `section`.
    fn attribute(&mut self, section: &str, before: usize) {
        let added = self.breaking.len() - before;
        self.breaking_sections
            .extend(std::iter::repeat_n(section.to_owned(), added));
    }
}

/// Which version an incompatible snapshot change requires.
///
/// WHY two: programs carry `ABI_VERSION` (and the program digest), so bumping
/// it rebuilds every program. A breaking change confined to kernel-host
/// sections (`abi_surfaces.kernel_host`) bumps `HOST_ADAPTER_VERSION`, the
/// kernel-host version the host checks exactly at boot, instead. An
/// `ABI_VERSION` bump starts a new epoch for everything.
fn compat_verdict(old: &Value, new: &Value, report: &CompatReport) -> Result<(), String> {
    if old["abi_version"] != new["abi_version"] {
        return Ok(());
    }
    let kernel_host = |section: &str| {
        new[SURFACES_KEY]["kernel_host"]
            .as_array()
            .is_some_and(|names| names.iter().any(|name| name == section))
    };
    let (host_only, program): (Vec<_>, Vec<_>) = report
        .breaking
        .iter()
        .zip(&report.breaking_sections)
        .partition(|(_, section)| kernel_host(section));
    if !program.is_empty() {
        return Err("program-surface snapshot changes require an ABI_VERSION bump".to_string());
    }
    let host_version = |snapshot: &Value| snapshot["host_adapter"]["version"].clone();
    if !host_only.is_empty() && host_version(old) == host_version(new) {
        return Err(
            "kernel-host snapshot changes require a HOST_ADAPTER_VERSION bump \
             (the kernel-host version), not an ABI_VERSION bump"
                .to_string(),
        );
    }
    Ok(())
}

fn classify_compat_change(old: &Value, new: &Value) -> Result<CompatReport, String> {
    let old_obj = old
        .as_object()
        .ok_or("old ABI snapshot root must be a JSON object")?;
    let new_obj = new
        .as_object()
        .ok_or("new ABI snapshot root must be a JSON object")?;

    let mut report = CompatReport::default();

    if let Some(host) = new_obj.get("host_adapter") {
        validate_host_adapter_export_lifecycles(host, &new["kernel_exports"])?;
    }

    for key in old_obj.keys() {
        if !new_obj.contains_key(key) {
            let before = report.breaking.len();
            report
                .breaking
                .push(format!("removed top-level section {key:?}"));
            report.attribute(key, before);
        }
    }
    for key in new_obj.keys() {
        if !old_obj.contains_key(key) {
            let before = report.breaking.len();
            if additive_top_level_section(key) {
                report
                    .additive
                    .push(format!("added top-level section {key:?}"));
            } else {
                report
                    .breaking
                    .push(format!("added top-level section {key:?}"));
            }
            report.attribute(key, before);
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
        let before = report.breaking.len();
        match key.as_str() {
            "syscalls" | "host_intercepted_syscalls" => {
                classify_additive_array_by_number_name(key, old_value, new_value, &mut report)?
            }
            "kernel_exports" => {
                classify_additive_array_by_name(key, old_value, new_value, &mut report)?
            }
            // Imports invert the export polarity: see
            // `classify_removal_only_array_by_module_name`.
            "kernel_imports" => classify_removal_only_array_by_module_name(
                key, old_value, new_value, &mut report,
            )?,
            "host_adapter" => classify_host_adapter(old_value, new_value, &mut report)?,
            "marshalled_structs" => {
                classify_additive_object_by_key(key, old_value, new_value, &mut report)?
            }
            "syscall_arg_descriptors" => {
                classify_additive_object_by_key(key, old_value, new_value, &mut report)?
            }
            // A request number absent from the table resolved to "unknown"
            // before, so adding one cannot change how an older program
            // marshals any call it already made. Changing or removing an
            // entry would restage a different buffer size and stays breaking.
            "ioctl_request_contracts" => {
                classify_additive_object_by_key(key, old_value, new_value, &mut report)?
            }
            // A request number in an nr range absent before resolved to
            // "unknown" (ENOTTY), so adding a disjoint family cannot change
            // how an older program marshals a call it already made — the
            // same additive argument as ioctl_request_contracts above.
            // Changing or removing an existing family stays breaking.
            "ioctl_request_families" => classify_additive_array(
                key,
                old_value,
                new_value,
                &mut report,
                |entry| {
                    let field = |name: &str| {
                        entry
                            .get(name)
                            .and_then(Value::as_u64)
                            .ok_or_else(|| {
                                format!(
                                    "ioctl_request_families entry missing numeric {name}: {entry}"
                                )
                            })
                    };
                    Ok(format!(
                        "{}:{}:{}:{}",
                        field("dir")?,
                        field("magic")?,
                        field("nrFirst")?,
                        field("nrLast")?,
                    ))
                },
            )?,
            "vfs_metadata" => {
                classify_additive_object_by_key(key, old_value, new_value, &mut report)?
            }
            // A newly added section joins one surface list. Moving an existing
            // section between surfaces changes what programs bind to, so it is
            // a removal from one list and stays breaking.
            k if k == SURFACES_KEY => {
                for surface in ["program", "kernel_host"] {
                    classify_additive_array(
                        &format!("{SURFACES_KEY}.{surface}"),
                        &old_value[surface],
                        &new_value[surface],
                        &mut report,
                        |entry| {
                            entry.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                                format!("{SURFACES_KEY}.{surface} entry must be a string: {entry}")
                            })
                        },
                    )?;
                }
            }
            _ if old_value != new_value => {
                report
                    .breaking
                    .push(format!("changed top-level section {key:?}"));
            }
            _ => {}
        }
        report.attribute(key, before);
    }

    Ok(report)
}

/// Sections whose first appearance cannot affect an existing binary. Once
/// present, any change inside one of them is classified like every other
/// section: `clipboard_device_abi`, for one, describes a device no program
/// built before it could open, but changing its record layout later would
/// break the agents built against it.
fn additive_top_level_section(section: &str) -> bool {
    matches!(
        section,
        // `kernel_imports` is listed here for the one-time
        // introduction of the section itself, which is pure added
        // snapshot metadata. It does NOT make the section's *entries*
        // additive: those are classified by
        // `classify_removal_only_array_by_module_name`, under which an
        // added import is breaking.
        "clipboard_device_abi"
            | "host_adapter"
            | "io_multiplexing"
            | "ioctl_request_families"
            | "kernel_imports"
            | "syscall_arg_descriptors"
            | "vfs_metadata"
    )
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
        } else if key == "kernel_export_lifecycles" {
            classify_additive_array_by_name(
                "host_adapter.kernel_export_lifecycles",
                &old_obj[key],
                new_value,
                report,
            )?;
        } else if &old_obj[key] != new_value {
            report
                .breaking
                .push(format!("changed host_adapter field {key:?}"));
        }
    }

    for key in new_obj.keys() {
        if !old_obj.contains_key(key) {
            // This field schedules later requirements. Effective requirements
            // remain checked separately; the binary manifest layout is intact.
            if key == "kernel_export_lifecycles" {
                report
                    .additive
                    .push(format!("added host_adapter field {key:?}"));
            } else {
                report
                    .breaking
                    .push(format!("added host_adapter field {key:?}"));
            }
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

/// Classify a section whose entries are *requirements placed on the
/// host*, keyed by `module.name`.
///
/// This is the mirror image of `classify_additive_array`, and the
/// inversion is the point. For an **export**, the module offers
/// something and the host may or may not use it, so adding one is
/// additive and removing one is breaking. For an **import** the arrow
/// points the other way — the module *demands* something the host must
/// supply — so the polarity flips:
///
/// | change | classification | why |
/// |---|---|---|
/// | import added | **breaking** | a host built against the old contract has no such function; instantiation fails outright |
/// | import removed | additive | WebAssembly resolves imports by name, so a host that still offers an unused one is unaffected |
/// | signature changed | **breaking** | the host's implementation no longer matches what the module calls |
///
/// The practical consequence is that adding a host import fails
/// `scripts/check-abi-version.sh` by default. Growing the host surface
/// is a deliberate, gated act rather than something a reviewer has to
/// notice.
fn classify_removal_only_array_by_module_name(
    section: &str,
    old: &Value,
    new: &Value,
    report: &mut CompatReport,
) -> Result<(), String> {
    let key_for = |entry: &Value| -> Result<String, String> {
        let module = entry
            .get("module")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{section} entry missing string module: {entry}"))?;
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{section} entry missing string name: {entry}"))?;
        Ok(format!("{module}.{name}"))
    };
    let old_entries = keyed_array(section, old, &key_for)?;
    let new_entries = keyed_array(section, new, &key_for)?;

    for (key, old_value) in &old_entries {
        match new_entries.get(key) {
            Some(new_value) if new_value == old_value => {}
            // A changed signature is the case that motivated this
            // section: widening a pointer parameter changes how the
            // host must interpret a kernel-supplied address, and until
            // imports were recorded it produced no snapshot diff.
            Some(_) => report
                .breaking
                .push(format!("changed {section} entry {key:?}")),
            // Dropping a requirement cannot break a host that still
            // satisfies it.
            None => report
                .additive
                .push(format!("removed {section} entry {key:?}")),
        }
    }
    for key in new_entries.keys() {
        if !old_entries.contains_key(key) {
            report
                .breaking
                .push(format!("added {section} entry {key:?}"));
        }
    }

    Ok(())
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

    #[test]
    fn host_env_imports_generate_one_link_allowance() {
        let mut declared: Vec<&str> = shared::abi::HOST_ENV_IMPORTS
            .iter()
            .filter(|i| i.link_time)
            .map(|i| i.name)
            .collect();
        declared.sort();
        let rendered = super::render_host_imports_file();
        let lines: Vec<&str> = rendered.lines().collect();
        assert_eq!(
            lines, declared,
            "allowance file must list exactly the link-time imports, sorted"
        );
        for fake in ["_Znwm", "__cxa_thread_atexit", "__dynamic_cast", "re_search"] {
            assert!(
                !lines.contains(&fake),
                "{fake} is a library function, not a host service"
            );
        }
        for real in [
            "__channel_base",
            "__wasm_dlopen_main",
            "__wasm_dlsym",
            "__wasm_posix_vm_interrupt_after",
        ] {
            assert!(lines.contains(&real), "{real} must be allowed at link time");
        }
        assert!(
            !lines.iter().any(|l| l.starts_with("__wpk_fork_")),
            "fork imports are added by instrumentation after linking"
        );
        assert!(super::render_ts_module().contains("export const HOST_ENV_IMPORTS"));
    }
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
        assert!(rendered.contains("export const SCHED_AFFINITY_MASK_SIZE = 4 as const;"));
        assert!(rendered.contains("export const PROCESS_SNAPSHOT_COUNT_BYTES = 4 as const;"));
        assert!(rendered.contains("export const PROCESS_SNAPSHOT_RECORDS_OFFSET = 4 as const;"));
        assert!(rendered.contains("export const PROCESS_SNAPSHOT_HEADER_BYTES = 36 as const;"));
        assert!(rendered.contains("export const PROCESS_SNAPSHOT_VSIZE_OFFSET = 16 as const;"));
        assert!(
            rendered.contains("export const PROCESS_SNAPSHOT_CMDLINE_LEN_OFFSET = 32 as const;")
        );
        assert!(rendered.contains("export const WAKEUP_EVENT_RECORD_BYTES = 5 as const;"));
        assert!(rendered.contains("  processContinued: 32,"));
        assert!(rendered.contains("  advisoryLock: 64,"));
        assert!(
            rendered.contains("  wakeType: { offset: 4, size: 1, type: \"u8\" },")
        );
        assert!(rendered.contains("export const PR_SET_NAME = 15 as const;"));
        assert!(rendered.contains("export const PR_GET_NAME = 16 as const;"));
        assert!(rendered.contains("export const PRCTL_NAME_BYTES = 16 as const;"));
        assert!(rendered.contains("export const FCNTL_FLOCK_BYTES = 32 as const;"));
        assert!(rendered.contains("export const SIGNAL_MASK_BYTES = 8 as const;"));
        assert!(rendered.contains(
            "export const KERNEL_SCRATCH_SOCKADDR_STORAGE_BYTES = 128 as const;"
        ));
        assert!(rendered.contains(
            "export const KERNEL_SCRATCH_SOCKADDR_UNIX_BYTES = 110 as const;"
        ));
        assert!(rendered.contains(
            "export const KERNEL_SCRATCH_SOCKADDR_UNIX_PATH_OFFSET_BYTES = 2 as const;"
        ));
        assert!(rendered.contains(
            "export const KERNEL_SCRATCH_SOCKADDR_UNIX_PATH_BYTES = 108 as const;"
        ));
        assert!(rendered.contains("export const SELECT_FD_SETSIZE = 1024 as const;"));
        assert!(rendered.contains("export const SELECT_FD_SET_BYTES = 128 as const;"));
        assert!(rendered.contains("export const PROCESS_IOVEC_WASM32_SIZE = 8 as const;"));
        assert!(rendered.contains("export const PROCESS_IOVEC_WASM64_SIZE = 16 as const;"));
        assert!(rendered.contains("export const PROCESS_GROUP_REQ_WASM32_SIZE = 132 as const;"));
        assert!(rendered.contains(
            "export const PROCESS_GROUP_REQ_WASM32_GROUP_OFFSET = 4 as const;"
        ));
        assert!(rendered.contains(
            "export const PROCESS_GROUP_SOURCE_REQ_WASM32_SIZE = 260 as const;"
        ));
        assert!(rendered.contains(
            "export const PROCESS_GROUP_SOURCE_REQ_WASM32_SOURCE_OFFSET = 132 as const;"
        ));
        assert!(rendered.contains("export const PROCESS_GROUP_REQ_WASM64_SIZE = 136 as const;"));
        assert!(rendered.contains(
            "export const PROCESS_GROUP_REQ_WASM64_GROUP_OFFSET = 8 as const;"
        ));
        assert!(rendered.contains(
            "export const PROCESS_GROUP_SOURCE_REQ_WASM64_SIZE = 264 as const;"
        ));
        assert!(rendered.contains(
            "export const PROCESS_GROUP_SOURCE_REQ_WASM64_SOURCE_OFFSET = 136 as const;"
        ));
        assert!(rendered.contains("export const PROCESS_MSGHDR_WASM64_SIZE = 56 as const;"));
        assert!(rendered.contains("export const PROCESS_CMSGHDR_WASM64_ALIGN = 8 as const;"));
        assert!(rendered.contains("export const PROCESS_METADATA_KIND_ARGV = 0 as const;"));
        assert!(rendered.contains("export const PROCESS_METADATA_KIND_ENVIRONMENT = 1 as const;"));
        assert!(rendered.contains("export const SOCKET_MSG_TRUNC = 32 as const;"));
        assert!(rendered.contains("export const WASM_EPOLL_EVENT_EVENTS_OFFSET = 0 as const;"));
        assert!(rendered.contains("export const WASM_EPOLL_EVENT_PAD_OFFSET = 4 as const;"));
        assert!(rendered.contains("export const WASM_EPOLL_EVENT_DATA_OFFSET = 8 as const;"));
        assert!(rendered.contains("export const PATHCONF_NAMES = {"));
        assert!(rendered.contains("  PATH_MAX: 4,"));
        assert!(rendered.contains("  TIMESTAMP_RESOLUTION: 23,"));
        assert!(rendered.contains("export const PCM_FLAG_CONFIGURING = 1 as const;"));
        assert!(rendered.contains("export const PCM_FLAG_UNDERRUN_ACTIVE = 2 as const;"));
        assert!(rendered.contains("export const PCM_FLAG_FATAL_ERROR = 4 as const;"));
        assert!(rendered.contains(
            "{ argIndex: 2, direction: \"out\", size: { type: \"fixed\", size: 8 }, required: true }"
        ));

        let names = pathconf_names();
        assert_eq!(names["LINK_MAX"], json!(0));
        assert_eq!(names["TIMESTAMP_RESOLUTION"], json!(23));
        assert_eq!(names.as_object().unwrap().len(), 24);

        let pcm = pcm_transport_abi();
        assert_eq!(pcm["flag_configuring"], json!(1));
        assert_eq!(pcm["flag_underrun_active"], json!(2));
        assert_eq!(pcm["flag_fatal_error"], json!(4));
    }

    #[test]
    fn generated_soundcard_header_contains_canonical_source_aliases() {
        let rendered = render_soundcard_header();
        let aliases: BTreeMap<_, _> = oss_source_aliases().into_iter().collect();
        for (alias, target) in [
            ("SOUND_PCM_SUBDIVIDE", "SNDCTL_DSP_SUBDIVIDE"),
            ("SOUND_PCM_SETFRAGMENT", "SNDCTL_DSP_SETFRAGMENT"),
            ("SOUND_PCM_GETFMTS", "SNDCTL_DSP_GETFMTS"),
            ("SOUND_PCM_GETOSPACE", "SNDCTL_DSP_GETOSPACE"),
            ("SOUND_PCM_GETISPACE", "SNDCTL_DSP_GETISPACE"),
            ("SOUND_PCM_NONBLOCK", "SNDCTL_DSP_NONBLOCK"),
            ("SOUND_PCM_GETCAPS", "SNDCTL_DSP_GETCAPS"),
            ("SOUND_PCM_GETTRIGGER", "SNDCTL_DSP_GETTRIGGER"),
            ("SOUND_PCM_SETTRIGGER", "SNDCTL_DSP_SETTRIGGER"),
            ("SOUND_PCM_SETSYNCRO", "SNDCTL_DSP_SETSYNCRO"),
            ("SOUND_PCM_GETIPTR", "SNDCTL_DSP_GETIPTR"),
            ("SOUND_PCM_GETOPTR", "SNDCTL_DSP_GETOPTR"),
            ("SOUND_PCM_MAPINBUF", "SNDCTL_DSP_MAPINBUF"),
            ("SOUND_PCM_MAPOUTBUF", "SNDCTL_DSP_MAPOUTBUF"),
        ] {
            assert_eq!(
                aliases.get(alias),
                Some(&target),
                "missing canonical OSS PCM alias {alias}"
            );
        }
        for (alias, target) in oss_source_aliases()
            .into_iter()
            .chain(oss_format_aliases())
        {
            let definition = format!("#define {alias} {target}");
            assert!(
                rendered.contains(&definition),
                "missing generated alias: {definition}"
            );

            let assertion =
                format!("_Static_assert({alias} == {target}, \"{alias} source alias\");");
            assert!(
                rendered.contains(&assertion),
                "missing generated alias assertion: {assertion}"
            );
        }

        let snapshotted_ioctls = oss_source_abi()["ioctls"].as_object().unwrap().clone();
        for (alias, _) in oss_source_aliases() {
            assert!(
                !snapshotted_ioctls.contains_key(alias),
                "source alias {alias} must not duplicate its target in the ABI snapshot"
            );
        }
        let snapshotted_formats = oss_source_abi()["formats"].as_object().unwrap().clone();
        for (alias, _) in oss_format_aliases() {
            assert!(
                !snapshotted_formats.contains_key(alias),
                "format alias {alias} must not duplicate its target in the ABI snapshot"
            );
        }

        let trigger_values = &oss_source_abi()["trigger_values"];
        assert_eq!(trigger_values["PCM_ENABLE_INPUT"], json!(1));
        assert_eq!(trigger_values["PCM_ENABLE_OUTPUT"], json!(2));
    }

    #[test]
    fn generated_process_snapshot_wire_is_packed_and_complete() {
        let wire = process_snapshot_wire();
        assert_eq!(wire["count_offset"], json!(0));
        assert_eq!(wire["count_size"], json!(4));
        assert_eq!(wire["records_offset"], json!(4));
        assert_eq!(wire["header"]["size"], json!(36));
        assert_eq!(
            wire["header"]["fields"],
            json!([
                { "name": "pid", "offset": 0, "span": 4 },
                { "name": "ppid", "offset": 4, "span": 4 },
                { "name": "uid", "offset": 8, "span": 4 },
                { "name": "gid", "offset": 12, "span": 4 },
                { "name": "vsize", "offset": 16, "span": 8 },
                { "name": "state", "offset": 24, "span": 4 },
                { "name": "comm_len", "offset": 28, "span": 4 },
                { "name": "cmdline_len", "offset": 32, "span": 4 },
            ])
        );
    }

    #[test]
    fn generated_wakeup_event_wire_is_packed_and_complete() {
        let wire = wakeup_event_wire();
        assert_eq!(wire["record_size"], json!(5));
        assert_eq!(
            wire["fields"],
            json!([
                { "name": "idx", "offset": 0, "size": 4, "type": "u32" },
                { "name": "wakeType", "offset": 4, "size": 1, "type": "u8" },
            ])
        );
        assert_eq!(
            wire["types"],
            json!([
                { "name": "readable", "bit": 1 },
                { "name": "writable", "bit": 2 },
                { "name": "accept", "bit": 4 },
                { "name": "datagramWritable", "bit": 8 },
                { "name": "processStopped", "bit": 16 },
                { "name": "processContinued", "bit": 32 },
                { "name": "advisoryLock", "bit": 64 },
                { "name": "waitComplete", "bit": 128 },
            ])
        );
    }

    #[test]
    fn generated_wait_completion_wire_is_packed_and_complete() {
        let wire = wait_completion_wire();
        assert_eq!(wire["record_size"], json!(24));
        assert_eq!(wire["parked_errno"], json!(65536));
        assert_eq!(
            wire["fields"],
            json!([
                { "name": "generation", "offset": 0, "size": 8, "type": "u64" },
                { "name": "pid", "offset": 8, "size": 4, "type": "u32" },
                { "name": "tid", "offset": 12, "size": 4, "type": "u32" },
                { "name": "value", "offset": 16, "size": 4, "type": "i32" },
                { "name": "flags", "offset": 20, "size": 4, "type": "u32" },
            ])
        );
        let rendered = render_ts_wait_completion_wire();
        assert!(rendered.contains("export const WAIT_COMPLETION_RECORD_BYTES = 24 as const;"));
        assert!(rendered.contains("export const KERNEL_WAIT_PARKED_ERRNO = 65536 as const;"));
    }

    #[test]
    fn generated_io_multiplexing_metadata_is_complete() {
        assert_eq!(
            io_multiplexing(),
            json!({
                "poll_events": [
                    { "name": "POLLIN", "value": 1 },
                    { "name": "POLLPRI", "value": 2 },
                    { "name": "POLLOUT", "value": 4 },
                    { "name": "POLLERR", "value": 8 },
                    { "name": "POLLHUP", "value": 16 },
                    { "name": "POLLNVAL", "value": 32 },
                    { "name": "POLLRDNORM", "value": 64 },
                    { "name": "POLLRDBAND", "value": 128 },
                    { "name": "POLLWRNORM", "value": 256 },
                    { "name": "POLLWRBAND", "value": 512 },
                    { "name": "POLLRDHUP", "value": 8192 },
                ],
                "epoll_events": [
                    { "name": "EPOLLIN", "value": 1 },
                    { "name": "EPOLLOUT", "value": 4 },
                    { "name": "EPOLLERR", "value": 8 },
                    { "name": "EPOLLHUP", "value": 16 },
                    { "name": "EPOLLPRI", "value": 2 },
                    { "name": "EPOLLRDNORM", "value": 64 },
                    { "name": "EPOLLRDBAND", "value": 128 },
                    { "name": "EPOLLWRNORM", "value": 256 },
                    { "name": "EPOLLWRBAND", "value": 512 },
                    { "name": "EPOLLRDHUP", "value": 8192 },
                    { "name": "EPOLLEXCLUSIVE", "value": 268435456 },
                    { "name": "EPOLLWAKEUP", "value": 536870912 },
                    { "name": "EPOLLONESHOT", "value": 1073741824 },
                    { "name": "EPOLLET", "value": 2147483648_u32 },
                ],
                "select": {
                    "fd_setsize": 1024,
                    "fd_set_bytes": 128,
                },
                // The facts a host reports about a socket, from which the
                // kernel decides readiness. Added when socket readiness moved
                // out of the four host backends and into the kernel; this
                // assertion is what makes that metadata's completeness a gate
                // rather than a hope.
                "net_readiness": {
                    "facts": [
                        { "name": "RECV_READY", "value": 1 },
                        { "name": "RECV_EOF", "value": 2 },
                        { "name": "SEND_READY", "value": 4 },
                        { "name": "SEND_CLOSED", "value": 8 },
                        { "name": "HANGUP", "value": 16 },
                        { "name": "ERROR", "value": 32 },
                        { "name": "UNOBSERVABLE", "value": 64 },
                    ],
                    "flag_mask": 65535,
                    "errno_shift": 16,
                },
            }),
        );

        let rendered = render_ts_module();
        assert!(rendered.contains("export const POLL_EVENTS = {"));
        assert!(rendered.contains("  POLLNVAL: 32,"));
        assert!(rendered.contains("export const EPOLL_EVENTS = {"));
        assert!(rendered.contains("  EPOLLHUP: 16,"));
    }

    #[test]
    fn generated_vfs_metadata_is_complete() {
        let metadata = vfs_metadata();
        assert_eq!(metadata["open_flags"].as_array().unwrap().len(), 16);
        assert_eq!(metadata["at_flags"].as_array().unwrap().len(), 4);
        assert_eq!(metadata["fd_flags"].as_array().unwrap().len(), 2);
        assert_eq!(metadata["fcntl_commands"].as_array().unwrap().len(), 16);
        assert_eq!(metadata["access_modes"].as_array().unwrap().len(), 4);
        assert_eq!(metadata["statfs_flags"].as_array().unwrap().len(), 1);
        assert_eq!(metadata["file_modes"].as_array().unwrap().len(), 24);
        assert_eq!(metadata["dirent_types"].as_array().unwrap().len(), 8);
        assert_eq!(metadata["seek_whence"].as_array().unwrap().len(), 3);

        for (section, name, value) in [
            ("open_flags", "O_NOCTTY", json!(0o400)),
            ("open_flags", "O_ASYNC", json!(0o20000)),
            ("open_flags", "O_PATH", json!(0o10000000)),
            ("at_flags", "AT_FDCWD", json!(-100)),
            ("at_flags", "AT_EMPTY_PATH", json!(0x1000)),
            ("fd_flags", "FD_CLOFORK", json!(2)),
            ("fcntl_commands", "F_DUPFD_CLOFORK", json!(1028)),
            ("fcntl_commands", "F_DUPFD_QUERY", json!(1027)),
            ("access_modes", "X_OK", json!(1)),
            ("statfs_flags", "ST_NOSUID", json!(2)),
            ("file_modes", "S_IFREG", json!(0o100000)),
            ("file_modes", "S_MODE_BITS", json!(0o7777)),
            ("dirent_types", "DT_SOCK", json!(12)),
            ("seek_whence", "SEEK_END", json!(2)),
        ] {
            assert!(
                metadata[section]
                    .as_array()
                    .unwrap()
                    .contains(&json!({ "name": name, "value": value })),
                "missing {section}.{name}",
            );
        }

        let rendered = render_ts_module();
        for expected in [
            "export const OPEN_FLAGS = {",
            "  O_PATH: 2097152,",
            "export const AT_FLAGS = {",
            "  AT_FDCWD: -100,",
            "export const FD_FLAGS = {",
            "export const FCNTL_COMMANDS = {",
            "export const ACCESS_MODES = {",
            "export const STATFS_FLAGS = {",
            "  ST_NOSUID: 2,",
            "export const FILE_MODES = {",
            "  S_MODE_BITS: 4095,",
            "export const DIRENT_TYPES = {",
            "export const SEEK_WHENCE = {",
        ] {
            assert!(rendered.contains(expected), "missing generated TS: {expected}");
        }
    }

    #[test]
    fn generated_process_metadata_contract_keeps_kinds_together() {
        assert_eq!(
            process_metadata_contract(),
            json!({
                "kind_argv": 0,
                "kind_environment": 1,
            }),
        );
    }

    #[test]
    fn generated_channel_scalar_consumers_share_one_contract() {
        let typescript = render_ts_module();
        for expected in [
            "export const CHANNEL_SCALAR_DEFAULT_SLOT_KIND = \"i32\" as const;",
            "export const CHANNEL_RESULT_DEFAULT_KIND = \"i32\" as const;",
            "  5: { 1: \"split-i64-low-u32\", 2: \"split-i64-high-i32\", },",
            "  64: { 2: \"process-size\", 3: \"i64\", },",
            "  295: { 1: \"process-address\", 3: \"split-i64-low-u32\", 4: \"split-i64-high-i32\", },",
            "  5: \"i64\",",
            "  46: \"process-address\",",
        ] {
            assert!(
                typescript.contains(expected),
                "missing generated TypeScript scalar contract: {expected}",
            );
        }

        let header = render_channel_scalars_header();
        for contract in shared::channel_scalar::SYSCALLS {
            assert!(header.contains(&format!(
                "_Static_assert(__NR_{} == {}u,",
                contract.musl_name, contract.syscall_number,
            )));
        }

        let snapshot = channel_scalar_contract();
        assert_eq!(snapshot["default_argument_kind"], json!("i32"));
        assert_eq!(snapshot["default_result_kind"], json!("i32"));
        assert_eq!(
            snapshot["syscalls"].as_array().unwrap().len(),
            shared::channel_scalar::SYSCALLS.len(),
        );
    }

    #[test]
    fn generated_channel_contract_covers_status_layout_and_signal_wire() {
        let header = render_c_header();
        for expected in [
            "#define WASM_POSIX_CHANNEL_STATUS_IDLE 0u",
            "#define WASM_POSIX_CHANNEL_STATUS_PENDING 1u",
            "#define WASM_POSIX_CHANNEL_STATUS_COMPLETE 2u",
            "#define WASM_POSIX_CHANNEL_STATUS_ERROR 3u",
            "#define WASM_POSIX_CHANNEL_STATUS_TEARDOWN 4u",
            "#define WASM_POSIX_CHANNEL_STATUS_OFFSET 0u",
            "#define WASM_POSIX_CHANNEL_SYSCALL_OFFSET 4u",
            "#define WASM_POSIX_CHANNEL_ARGS_OFFSET 8u",
            "#define WASM_POSIX_CHANNEL_ARGS_COUNT 6u",
            "#define WASM_POSIX_CHANNEL_ARG_SIZE 8u",
            "#define WASM_POSIX_CHANNEL_RETURN_OFFSET 56u",
            "#define WASM_POSIX_CHANNEL_ERRNO_OFFSET 64u",
            "#define WASM_POSIX_CHANNEL_REQUEST_FLAGS_OFFSET 68u",
            "#define WASM_POSIX_CHANNEL_REQUEST_FLAGS_SIZE 4u",
            "#define WASM_POSIX_CHANNEL_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY 4u",
            "#define WASM_POSIX_CHANNEL_REQUEST_FLAG_CANCELLATION_POINT 1u",
            "#define WASM_POSIX_CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED 2u",
            "#define WASM_POSIX_CHANNEL_REQUEST_FLAG_OPAQUE_RECORD 8u",
            "#define WASM_POSIX_CHANNEL_REQUEST_FLAGS_KNOWN_MASK 15u",
            "#define WASM_POSIX_CHANNEL_DATA_OFFSET 72u",
            "#define WASM_POSIX_CHANNEL_DATA_SIZE 65536u",
            "#define WASM_POSIX_CHANNEL_HEADER_SIZE 72u",
            "#define WASM_POSIX_CHANNEL_MIN_SIZE 65608u",
            "#define WASM_POSIX_CHANNEL_SIG_AREA_SIZE 56u",
            "#define WASM_POSIX_CHANNEL_SIG_DELIVERY_SIZE 56u",
            "#define WASM_POSIX_CHANNEL_SIG_WORD_BYTES 4u",
            "#define WASM_POSIX_CHANNEL_SIG_SI_VALUE_BYTES 8u",
            "#define WASM_POSIX_CHANNEL_SIG_OLD_MASK_BYTES 8u",
            "#define WASM_POSIX_CHANNEL_SIG_ALT_SP_BYTES 8u",
            "#define WASM_POSIX_CHANNEL_SIG_ALT_SIZE_BYTES 8u",
            "#define WASM_POSIX_CHANNEL_SIG_BASE_OFFSET 65552u",
            "#define WASM_POSIX_CHANNEL_SIG_SIGNUM_OFFSET 65552u",
            "#define WASM_POSIX_CHANNEL_SIG_HANDLER_OFFSET 65556u",
            "#define WASM_POSIX_CHANNEL_SIG_FLAGS_OFFSET 65560u",
            "#define WASM_POSIX_CHANNEL_SIG_SI_VALUE_OFFSET 65564u",
            "#define WASM_POSIX_CHANNEL_SIG_OLD_MASK_OFFSET 65572u",
            "#define WASM_POSIX_CHANNEL_SIG_SI_CODE_OFFSET 65580u",
            "#define WASM_POSIX_CHANNEL_SIGINFO_WORD_1_OFFSET 65584u",
            "#define WASM_POSIX_CHANNEL_SIGINFO_WORD_2_OFFSET 65588u",
            "#define WASM_POSIX_CHANNEL_SIG_ALT_SP_OFFSET 65592u",
            "#define WASM_POSIX_CHANNEL_SIG_ALT_SIZE_OFFSET 65600u",
        ] {
            assert!(header.contains(expected), "missing generated C: {expected}");
        }

        let typescript = render_ts_module();
        for expected in [
            "export const CH_REQUEST_FLAGS = 68 as const;",
            "export const CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY = 4 as const;",
            "export const CHANNEL_REQUEST_FLAG_CANCELLATION_POINT = 1 as const;",
            "export const CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED = 2 as const;",
            "export const CHANNEL_REQUEST_FLAG_OPAQUE_RECORD = 8 as const;",
            "export const CHANNEL_REQUEST_FLAGS_KNOWN_MASK = 15 as const;",
            "export const CH_SIG_AREA_SIZE = 56 as const;",
            "export const CH_SIG_DELIVERY_SIZE = 56 as const;",
            "export const CH_SIG_SI_VALUE = 65564 as const;",
            "export const CH_SIG_SI_CODE = 65580 as const;",
            "export const CH_SIGINFO_WORD_1 = 65584 as const;",
            "export const CH_SIGINFO_WORD_2 = 65588 as const;",
            "export const CH_SIG_ALT_SP = 65592 as const;",
            "export const CH_SIG_ALT_SIZE = 65600 as const;",
        ] {
            assert!(
                typescript.contains(expected),
                "missing generated TypeScript: {expected}",
            );
        }

        let signal = channel_signal_area();
        assert_eq!(signal["area_size"], json!(56));
        assert_eq!(signal["delivery_size"], json!(56));
        assert_eq!(signal["reserved_tail_size"], json!(0));
        let slot_names: Vec<&str> = signal["slots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|slot| slot["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            slot_names,
            vec![
                "SIG_SIGNUM",
                "SIG_HANDLER",
                "SIG_FLAGS",
                "SIG_SI_VALUE",
                "SIG_OLD_MASK",
                "SIG_SI_CODE",
                "SIGINFO_WORD_1",
                "SIGINFO_WORD_2",
                "SIG_ALT_SP",
                "SIG_ALT_SIZE",
            ],
        );
    }

    #[test]
    fn snapshot_captures_generated_platform_and_spawn_contracts() {
        let limits = platform_limits();
        assert_eq!(
            limits,
            json!({
                "arg_max_bytes": shared::platform_limits::ARG_MAX_BYTES,
                "fd_set_bytes": shared::select::FD_SET_BYTES,
                "fd_setsize": shared::select::FD_SETSIZE,
                "iov_max": shared::platform_limits::IOV_MAX,
                "max_reportable_transfer_bytes":
                    shared::platform_limits::MAX_REPORTABLE_TRANSFER_BYTES,
                "max_transfer_allocation_bytes":
                    shared::platform_limits::MAX_TRANSFER_ALLOCATION_BYTES,
                "ngroups_max": shared::platform_limits::NGROUPS_MAX,
                "path_max_bytes": shared::platform_limits::PATH_MAX_BYTES,
                "process_startup_max_argv_count":
                    shared::platform_limits::PROCESS_STARTUP_MAX_ARGV_COUNT,
                "process_startup_max_envp_count":
                    shared::platform_limits::PROCESS_STARTUP_MAX_ENVP_COUNT,
                "sysv_msg_max_bytes": shared::platform_limits::SYSV_MSG_MAX_BYTES,
            }),
        );

        let spawn = spawn_contract();
        assert_eq!(
            spawn["header"]["bytes"],
            json!(shared::spawn_contract::WIRE_HEADER_BYTES),
        );
        assert_eq!(
            spawn["action_record"]["bytes"],
            json!(shared::spawn_contract::WIRE_ACTION_RECORD_BYTES),
        );
        assert_eq!(
            spawn["count_caps"],
            json!({
                "actions": shared::spawn_contract::MAX_ACTION_COUNT,
                "argv": shared::spawn_contract::MAX_ARGV_COUNT,
                "envp": shared::spawn_contract::MAX_ENVP_COUNT,
            }),
        );
        assert_eq!(
            spawn["platform_aliases"],
            json!({
                "arg_max_bytes": shared::platform_limits::ARG_MAX_BYTES,
                "path_max_bytes": shared::platform_limits::PATH_MAX_BYTES,
            }),
        );
        assert_eq!(
            spawn["wire_max_bytes"],
            json!(
                shared::spawn_contract::POSIX_ARG_MAX_BYTES
                    + shared::spawn_contract::WIRE_HEADER_BYTES
                    + shared::spawn_contract::MAX_ACTION_COUNT
                        * (shared::spawn_contract::WIRE_ACTION_RECORD_BYTES
                            + shared::spawn_contract::POSIX_PATH_MAX_BYTES)
            ),
        );
    }

    #[test]
    fn generated_native_process_layout_contract_matches_both_musl_targets() {
        let layouts = process_native_layouts();
        assert_eq!(
            layouts["iovec"],
            json!({
                "wasm32": {"base_offset": 0, "len_offset": 4, "size": 8},
                "wasm64": {"base_offset": 0, "len_offset": 8, "size": 16},
            }),
        );
        assert_eq!(
            layouts["multicast_group_request"],
            json!({
                "wasm32": {
                    "group_req_size": 132,
                    "group_offset": 4,
                    "group_source_req_size": 260,
                    "source_offset": 132,
                },
                "wasm64": {
                    "group_req_size": 136,
                    "group_offset": 8,
                    "group_source_req_size": 264,
                    "source_offset": 136,
                },
            }),
        );
        assert_eq!(
            layouts["msghdr"]["wasm64"],
            json!({
                "control_offset": 32,
                "controllen_offset": 40,
                "flags_offset": 48,
                "iov_offset": 16,
                "iovlen_offset": 24,
                "name_offset": 0,
                "namelen_offset": 8,
                "size": 56,
            }),
        );
        assert_eq!(
            layouts["cmsghdr"]["wasm64"],
            json!({
                "align": 8,
                "data_offset": 16,
                "len_offset": 0,
                "level_offset": 8,
                "size": 16,
                "type_offset": 12,
            }),
        );
        assert_eq!(
            layouts["socket_message_flags"],
            json!({"trunc": shared::socket::MSG_TRUNC}),
        );
        assert_eq!(
            layouts["siginfo"],
            json!({
                "signo_offset": 0,
                "errno_offset": 4,
                "code_offset": 8,
                "wasm32": {
                    "size": 128,
                    "pid_offset": 12,
                    "uid_offset": 16,
                    "value_offset": 20,
                    "value_size": 4,
                },
                "wasm64": {
                    "size": 128,
                    "pid_offset": 16,
                    "uid_offset": 20,
                    "value_offset": 24,
                    "value_size": 8,
                },
            }),
        );
        assert_eq!(
            layouts["sigevent"],
            json!({
                "wasm32": {
                    "size": 64,
                    "value_offset": 0,
                    "value_size": 4,
                    "signo_offset": 4,
                    "notify_offset": 8,
                    "payload_offset": 12,
                },
                "wasm64": {
                    "size": 64,
                    "value_offset": 0,
                    "value_size": 8,
                    "signo_offset": 8,
                    "notify_offset": 12,
                    "payload_offset": 16,
                },
            }),
        );

        let header = render_process_layouts_header();
        assert!(header.contains("#define KANDELO_PROCESS_CMSGHDR_WASM32_SIZE 12u"));
        assert!(header.contains("#define KANDELO_PROCESS_CMSGHDR_WASM64_SIZE 16u"));
        assert!(header.contains("#define KANDELO_PROCESS_GROUP_REQ_WASM32_SIZE 132u"));
        assert!(header.contains(
            "#define KANDELO_PROCESS_GROUP_REQ_WASM32_GROUP_OFFSET 4u"
        ));
        assert!(header.contains(
            "#define KANDELO_PROCESS_GROUP_SOURCE_REQ_WASM32_SIZE 260u"
        ));
        assert!(header.contains(
            "#define KANDELO_PROCESS_GROUP_SOURCE_REQ_WASM32_SOURCE_OFFSET 132u"
        ));
        assert!(header.contains("#define KANDELO_PROCESS_GROUP_REQ_WASM64_SIZE 136u"));
        assert!(header.contains(
            "#define KANDELO_PROCESS_GROUP_REQ_WASM64_GROUP_OFFSET 8u"
        ));
        assert!(header.contains(
            "#define KANDELO_PROCESS_GROUP_SOURCE_REQ_WASM64_SIZE 264u"
        ));
        assert!(header.contains(
            "#define KANDELO_PROCESS_GROUP_SOURCE_REQ_WASM64_SOURCE_OFFSET 136u"
        ));
        assert!(header.contains("#define KANDELO_PROCESS_SIGINFO_SIGNO_OFFSET 0u"));
        assert!(header.contains("#define KANDELO_PROCESS_SIGINFO_WASM32_PID_OFFSET 12u"));
        assert!(header.contains("#define KANDELO_PROCESS_SIGINFO_WASM64_PID_OFFSET 16u"));
        assert!(header.contains("#define KANDELO_PROCESS_SIGINFO_WASM64_VALUE_SIZE 8u"));
        assert!(header.contains("#define KANDELO_PROCESS_SIGEVENT_WASM32_SIZE 64u"));
        assert!(header.contains("#define KANDELO_PROCESS_SIGEVENT_WASM64_VALUE_SIZE 8u"));
        assert!(header.contains("#define KANDELO_SOCKET_MSG_TRUNC 32u"));
        assert!(header.contains("#define KANDELO_SOCKADDR_STORAGE_BYTES 128u"));
        assert!(header.contains("#define KANDELO_SOCKADDR_UNIX_BYTES 110u"));
        assert!(header.contains("#define KANDELO_SOCKADDR_UNIX_PATH_OFFSET_BYTES 2u"));
        assert!(header.contains("#define KANDELO_SOCKADDR_UNIX_PATH_BYTES 108u"));
        assert!(header.contains("#define KANDELO_SELECT_FD_SET_BYTES 128u"));

    }

    #[test]
    fn program_artifact_snapshot_captures_complete_abi43_fork_contract() {
        let artifact = program_artifact();
        let fork = &artifact["fork_instrumentation"];
        assert_eq!(
            fork["process_import"],
            json!({
                "kind": "func",
                "module": "kernel",
                "name": "kernel_fork",
                "params": ["i32"],
                "results": ["i32"]
            })
        );
        assert_eq!(fork["process_modes"], json!({"fork": 0, "vfork": 1}));
        assert_eq!(
            artifact["heap_safepoint_import"],
            json!({
                "kind": "func",
                "module": "kernel",
                "name": "kernel_heap_safepoint",
                "params": [],
                "results": ["i64"]
            })
        );
        let descriptor = &fork["linked_frame_descriptor"];
        assert_eq!(
            descriptor["section"],
            json!("kandelo.wpk_fork.linked_frames")
        );
        assert_eq!(descriptor["magic_bytes"], json!([75, 76, 67, 70]));
        assert_eq!(descriptor["version"], json!(1));
        assert_eq!(descriptor["descriptor_size"], json!(24));
        assert_eq!(descriptor["required_flags"], json!(3));
        assert_eq!(
            fork["capabilities"],
            json!({
                "section": "kandelo.wpk_fork.capabilities",
                "version": 1,
                "known_mask": 7,
                "required_flags": 4,
                "flags": [
                    {"bit": 1, "name": "side_entry"},
                    {"bit": 2, "name": "dylink_main"},
                    {"bit": 4, "name": "activation_state_safe"}
                ]
            })
        );
        assert_eq!(
            fork["exception_codec"],
            json!({
                "activation_import": {
                    "module": "env",
                    "name": "__wpk_fork_module_activation",
                    "type": "i32",
                    "mutable": false
                },
                "header_size": 8,
                "section": "kandelo.wpk_fork.exception_codec",
                "tag_record_size": 16,
                "version": 1
            })
        );
        assert_eq!(fork["imported_globals"]["record_header_size"], json!(24));
        assert_eq!(fork["imported_globals"]["known_flags"], json!(3));
        assert_eq!(fork["imported_globals"]["shared_flag"], json!(2));
        assert_eq!(
            descriptor["pointer_widths"],
            json!([
                {"bytes": 4, "chunk_header_size": 32, "node_header_size": 24},
                {"bytes": 8, "chunk_header_size": 56, "node_header_size": 32}
            ])
        );
        assert_eq!(
            fork["module_state"]["descriptor"]["section"],
            json!("kandelo.wpk_fork.module_state")
        );
        let record_kinds = fork["module_state"]["arena"]["record"]["kinds"]
            .as_array()
            .unwrap();
        assert_eq!(record_kinds.len(), 13);
        assert_eq!(
            record_kinds[11],
            json!({"name": "reference_recipe_segment", "number": 12})
        );
        assert_eq!(
            record_kinds[12],
            json!({"name": "replay_event_segment", "number": 13})
        );
        assert_eq!(
            fork["module_state"]["record_payloads"]["mutable_global"]["header_size"],
            json!(8)
        );
        assert_eq!(
            fork["module_state"]["record_payloads"]["replay_events"]["owner"],
            json!(1)
        );
        assert_eq!(
            fork["module_state"]["record_payloads"]["imported_global_bindings"]["entry_size"],
            json!(40)
        );
        assert_eq!(
            fork["module_state"]["record_payloads"]["imported_global_bindings"]["binding_kinds"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
        assert_eq!(
            fork["module_state"]["record_payloads"]["activation_continuations"]["entry_size"],
            json!(16)
        );
        assert_eq!(
            fork["module_state"]["record_payloads"]["imported_table_bindings"]["entry_size"],
            json!(24)
        );
        assert_eq!(fork["imported_tables"]["record_header_size"], json!(24));
        assert_eq!(fork["gc_codec"]["magic_bytes"], json!([75, 70, 71, 67]));
        assert_eq!(fork["gc_codec"]["layout_record"]["size"], json!(44));
        assert_eq!(fork["gc_codec"]["field_record"]["size"], json!(12));
        assert_eq!(
            fork["gc_codec"]["transit_table"]["element"],
            json!("anyref")
        );

        let imports = fork["required_imports"].as_array().unwrap();
        assert_eq!(imports.len(), 47);
        assert_eq!(
            imports[0],
            json!({
                "kind": "func",
                "module": "env",
                "name": "__wpk_fork_frame_commit",
                "params": ["ptr"],
                "results": []
            })
        );
        assert!(imports.iter().any(|entry| {
            entry["name"] == json!("__wpk_fork_module_state_record_reserve")
                && entry["params"] == json!(["i32", "i32", "i32", "ptr"])
                && entry["results"] == json!(["ptr"])
        }));
        assert!(!imports.iter().any(|entry| {
            entry["name"] == json!("__wpk_fork_ref_encode_anyref")
                || entry["name"] == json!("__wpk_fork_ref_decode_anyref")
        }));
        assert!(imports.iter().any(|entry| {
            entry["name"] == json!("__wpk_fork_ref_exn_define")
                && entry["params"]
                    == json!(["i32", "i32", "i32", "i32", "ptr", "i32", "ptr", "i32"])
                && entry["results"] == json!([])
        }));
        assert!(imports.iter().any(|entry| {
            entry["name"] == json!("__wpk_fork_ref_gc_define")
                && entry["params"]
                    == json!(["i32", "i32", "i32", "i32", "i32", "ptr", "i32", "i32"])
                && entry["results"] == json!([])
        }));
        assert!(imports.iter().any(|entry| {
            entry["kind"] == json!("table")
                && entry["name"] == json!("__wpk_fork_ref_gc_transit")
                && entry["element"] == json!("anyref")
        }));
        assert!(imports.iter().any(|entry| {
            entry["name"] == json!("__wpk_fork_ref_gc_provenance_begin")
                && entry["params"] == json!(["i32", "i32", "i32", "i32", "i64", "i64", "i32"])
                && entry["results"] == json!(["i32"])
        }));
        assert!(imports.iter().any(|entry| {
            entry["name"] == json!("__wpk_fork_ref_gc_provenance_ref")
                && entry["params"] == json!(["i32", "i32", "i32"])
                && entry["results"] == json!([])
        }));
        assert!(imports.iter().any(|entry| {
            entry["name"] == json!("__wpk_fork_ref_gc_provenance_end")
                && entry["params"] == json!(["i32"])
                && entry["results"] == json!([])
        }));

        let exports = fork["required_exports"].as_array().unwrap();
        assert_eq!(exports.len(), 28);
        assert!(exports.iter().any(|entry| {
            entry["name"] == json!("__wpk_fork_exception_materialize")
                && entry["params"] == json!(["i32"])
                && entry["results"] == json!([])
        }));
        assert!(exports.iter().any(|entry| {
            entry["name"] == json!("__wpk_fork_ref_decode_exnref")
                && entry["params"] == json!(["i32"])
                && entry["results"] == json!(["exnref"])
        }));
        assert!(exports.iter().any(|entry| {
            entry["name"] == json!("__wpk_fork_ref_gc_probe")
                && entry["params"] == json!(["i32"])
                && entry["results"] == json!(["i64"])
        }));
        assert!(exports.iter().any(|entry| {
            entry["name"] == json!("__wpk_fork_ref_gc_publish_externref")
                && entry["params"] == json!(["i32", "externref"])
                && entry["results"] == json!([])
        }));
        assert!(exports.iter().any(|entry| {
            entry["name"] == json!("__wpk_fork_static_root_harvest")
                && entry["params"] == json!([])
                && entry["results"] == json!([])
        }));
        assert!(exports.iter().any(|entry| {
            entry["name"] == json!("wpk_fork_abort_begin")
                && entry["params"] == json!(["ptr"])
                && entry["results"] == json!([])
        }));
        assert!(exports.iter().any(|entry| {
            entry["name"] == json!("wpk_fork_state")
                && entry["params"] == json!([])
                && entry["results"] == json!(["i32"])
        }));
        assert!(exports.iter().any(|entry| {
            entry["name"] == json!("wpk_fork_module_state_finish_restore")
                && entry["params"] == json!(["i32"])
                && entry["results"] == json!([])
        }));
        assert!(exports.iter().any(|entry| {
            entry["name"] == json!("wpk_fork_module_state_restore")
                && entry["params"] == json!(["i32"])
                && entry["results"] == json!([])
        }));

        assert_eq!(
            custom_sections(),
            json!([
                "kandelo.wpk_fork.capabilities",
                "kandelo.wpk_fork.exception_codec",
                "kandelo.wpk_fork.gc_codec",
                "kandelo.wpk_fork.imported_globals",
                "kandelo.wpk_fork.imported_tables",
                "kandelo.wpk_fork.linked_frames",
                "kandelo.wpk_fork.module_state",
                "kandelo.wpk_fork.static_root_catalog",
                "kandelo.wpk_fork.unwind_transport",
                "wasm-posix-abi"
            ])
        );
        let rendered = render_ts_module();
        for expected in [
            "export const WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE = 24 as const;",
            "export const WPK_FORK_MODULE_STATE_FORMAT_SECTION = \"kandelo.wpk_fork.module_state\" as const;",
            "export const WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE = 5 as const;",
            "export const WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE = 56 as const;",
            "export const WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE = \"wpk_fork_module_state_finish_restore\" as const;",
            "export const WPK_FORK_CAP_ACTIVATION_STATE_SAFE = 4 as const;",
            "export const WPK_FORK_EXCEPTION_CODEC_SECTION = \"kandelo.wpk_fork.exception_codec\" as const;",
            "export const WPK_FORK_GC_CODEC_SECTION = \"kandelo.wpk_fork.gc_codec\" as const;",
            "export const WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE = 44 as const;",
            "export const WPK_FORK_FRAME_IMPORT_COMMIT = \"__wpk_fork_frame_commit\" as const;",
            "export const WPK_FORK_EXPORT_RESUME_START = \"wpk_fork_resume_start\" as const;",
            "name: \"__wpk_fork_frame_reserve\", params: [\"ptr\"], results: [\"ptr\"]",
            "name: \"wpk_fork_abort_end\", params: [], results: []",
        ] {
            assert!(
                rendered.contains(expected),
                "missing generated TS: {expected}"
            );
        }
    }

    #[test]
    fn generated_wait_abi_metadata_matches_shared_layouts() {
        let rendered = render_ts_module();
        for expected in [
            "export const STRUCT_SIZE_WPK_DRM_MODE_MODEINFO = 68 as const;",
            "export const STRUCT_SIZE_WASM_RUSAGE_WIRE = 144 as const;",
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
            "\"kernel_process_secure_exec\"",
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
        assert_eq!(structs["AudioBufInfo"]["size"], json!(16));
        assert_eq!(structs["AudioBufInfo"]["align"], json!(4));
        assert_eq!(
            structs["AudioBufInfo"]["fields"][3],
            json!({"name": "bytes", "offset": 12, "span": 4, "type": "i32"})
        );
        assert_eq!(structs["CountInfo"]["size"], json!(12));
        assert_eq!(structs["PcmSharedControl"]["size"], json!(128));
        assert_eq!(structs["PcmSharedControl"]["align"], json!(4));

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
            "io_multiplexing": io_multiplexing(),
            "platform_limits": platform_limits(),
            "process_native_layouts": process_native_layouts(),
            "spawn_contract": spawn_contract(),
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
                {"name": "kernel_existing_helper", "kind": "func", "signature": "(i32) -> ()"}
            ],
            "kernel_imports": [
                {
                    "module": "env", "name": "host_proc_read_bytes",
                    "kind": "func", "signature": "(i32,i32,i32,i32) -> (i32)"
                },
                {
                    "module": "env", "name": "host_write",
                    "kind": "func", "signature": "(i64,i32,i32) -> (i32)"
                },
                {
                    "module": "env", "name": "memory", "kind": "memory",
                    "memory64": false, "shared": true,
                    "minimum_pages": 18, "maximum_pages": 16384
                }
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
            },
            "vfs_metadata": vfs_metadata()
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

    fn with_surfaces(mut snapshot: Value) -> Value {
        snapshot[SURFACES_KEY] = json!({
            "program": ["host_intercepted_syscalls", "syscalls"],
            "kernel_host": ["host_adapter", "kernel_exports", "kernel_imports"],
        });
        snapshot
    }

    fn bump_kernel_host_version(snapshot: &mut Value) {
        snapshot["host_adapter"]["version"] = json!(2);
        snapshot["host_adapter"]["manifest"]["required_host_adapter_version"] = json!(2);
    }

    /// An incompatible change only the kernel and host see -- a changed kernel
    /// export, a new kernel host import -- needs the kernel-host version, not
    /// ABI_VERSION, so programs stay valid.
    #[test]
    fn kernel_host_breaks_need_the_kernel_host_version_not_abi_version() {
        let old = with_surfaces(base_snapshot());
        let mut new = old.clone();
        new["kernel_exports"][1]["signature"] = json!("(i32,i32) -> ()");
        new["kernel_imports"].as_array_mut().unwrap().push(json!({
            "module": "env", "name": "host_new_import",
            "kind": "func", "signature": "() -> (i32)"
        }));
        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(report.breaking.len(), 2, "{report:?}");
        let error = compat_verdict(&old, &new, &report).unwrap_err();
        assert!(error.contains("HOST_ADAPTER_VERSION"), "{error}");

        bump_kernel_host_version(&mut new);
        let report = classify_compat_change(&old, &new).unwrap();
        compat_verdict(&old, &new, &report).unwrap();
        assert_eq!(new["abi_version"], old["abi_version"]);
    }

    #[test]
    fn program_breaks_still_need_abi_version() {
        let old = with_surfaces(base_snapshot());
        let mut new = old.clone();
        new["host_intercepted_syscalls"][0]["number"] = json!(299);
        bump_kernel_host_version(&mut new);
        let report = classify_compat_change(&old, &new).unwrap();
        let error = compat_verdict(&old, &new, &report).unwrap_err();
        assert!(error.contains("ABI_VERSION bump"), "{error}");

        new["abi_version"] = json!(11);
        let report = classify_compat_change(&old, &new).unwrap();
        compat_verdict(&old, &new, &report).unwrap();
    }

    #[test]
    fn surface_lists_grow_compatibly_but_a_move_is_breaking() {
        let mut old = base_snapshot();
        old[SURFACES_KEY] = json!({"program": ["syscalls"], "kernel_host": ["kernel_exports"]});
        let mut grown = old.clone();
        grown[SURFACES_KEY]["program"] = json!(["syscalls", "vfs_metadata"]);
        let report = classify_compat_change(&old, &grown).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");

        let mut moved = old.clone();
        moved[SURFACES_KEY] = json!({"program": [], "kernel_host": ["kernel_exports", "syscalls"]});
        let report = classify_compat_change(&old, &moved).unwrap();
        assert!(!report.breaking.is_empty(), "{report:?}");
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
    fn adding_the_clipboard_device_section_is_compatible() {
        let mut new = base_snapshot();
        new.as_object_mut()
            .unwrap()
            .insert("clipboard_device_abi".into(), clipboard_device_abi());
        let report = classify_compat_change(&base_snapshot(), &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            vec!["added top-level section \"clipboard_device_abi\""]
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

    fn snapshot_with_one_ioctl_contract() -> Value {
        let mut snapshot = base_snapshot();
        snapshot.as_object_mut().unwrap().insert(
            "ioctl_request_contracts".into(),
            json!({
                "1074021776": {
                    "argKind": "scalar-i32",
                    "direction": "none",
                    "wasm32Size": 0,
                    "wasm64Size": 0
                }
            }),
        );
        snapshot
    }

    #[test]
    fn adding_an_ioctl_request_contract_entry_is_compatible() {
        let old = snapshot_with_one_ioctl_contract();
        let mut new = snapshot_with_one_ioctl_contract();
        new["ioctl_request_contracts"]["2147763457"] = json!({
            "argKind": "pointer",
            "direction": "out",
            "wasm32Size": 4,
            "wasm64Size": 4
        });

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            vec!["added ioctl_request_contracts entry \"2147763457\""]
        );
    }

    #[test]
    fn changing_or_removing_an_ioctl_request_contract_entry_is_breaking() {
        let old = snapshot_with_one_ioctl_contract();
        let mut resized = snapshot_with_one_ioctl_contract();
        resized["ioctl_request_contracts"]["1074021776"]["wasm32Size"] = json!(4);

        let report = classify_compat_change(&old, &resized).unwrap();
        assert_eq!(
            report.breaking,
            vec!["changed ioctl_request_contracts entry \"1074021776\""]
        );

        let mut dropped = snapshot_with_one_ioctl_contract();
        dropped["ioctl_request_contracts"]
            .as_object_mut()
            .unwrap()
            .remove("1074021776");

        let report = classify_compat_change(&old, &dropped).unwrap();
        assert_eq!(
            report.breaking,
            vec!["removed ioctl_request_contracts entry \"1074021776\""]
        );
    }

    #[test]
    fn adding_the_ioctl_request_families_section_is_compatible() {
        let old = base_snapshot();
        let mut new = base_snapshot();
        new.as_object_mut().unwrap().insert(
            "ioctl_request_families".into(),
            json!([{
                "dir": 2,
                "magic": 69,
                "nrFirst": 64,
                "nrLast": 127,
                "direction": "out",
                "fixedSize": 24,
                "maxCallerSize": null
            }]),
        );

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            vec!["added top-level section \"ioctl_request_families\""]
        );
    }

    #[test]
    fn narrowing_an_existing_ioctl_request_family_is_breaking() {
        // Families are keyed by (dir, magic, nrFirst, nrLast), so narrowing
        // the range changes the key: the old range disappears (breaking —
        // request numbers it used to handle now resolve to unknown) and the
        // narrowed range shows up as a new (additive) entry.
        let family = |nr_last: u32| {
            json!([{
                "dir": 2,
                "magic": 69,
                "nrFirst": 64,
                "nrLast": nr_last,
                "direction": "out",
                "fixedSize": 24,
                "maxCallerSize": null
            }])
        };
        let mut old = base_snapshot();
        old.as_object_mut()
            .unwrap()
            .insert("ioctl_request_families".into(), family(127));
        let mut new = base_snapshot();
        new.as_object_mut()
            .unwrap()
            .insert("ioctl_request_families".into(), family(96));

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            vec!["removed ioctl_request_families entry \"2:69:64:127\""]
        );
    }

    #[test]
    fn adding_a_disjoint_ioctl_request_family_entry_is_compatible() {
        // The EVIOCGKEY/GLED/GSW case: a new single-nr family whose range
        // was previously unknown is a backward-compatible addition.
        let base_family = json!([{
            "dir": 2,
            "magic": 69,
            "nrFirst": 64,
            "nrLast": 127,
            "direction": "out",
            "fixedSize": 24,
            "maxCallerSize": null
        }]);
        let mut old = base_snapshot();
        old.as_object_mut()
            .unwrap()
            .insert("ioctl_request_families".into(), base_family.clone());
        let mut new = base_snapshot();
        let mut families = base_family.as_array().unwrap().clone();
        families.push(json!({
            "dir": 2,
            "magic": 69,
            "nrFirst": 24,
            "nrLast": 24,
            "direction": "out",
            "fixedSize": null,
            "maxCallerSize": 256
        }));
        new.as_object_mut()
            .unwrap()
            .insert("ioctl_request_families".into(), Value::Array(families));

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            vec!["added ioctl_request_families entry \"2:69:24:24\""]
        );
    }

    #[test]
    fn adding_io_multiplexing_section_is_compatible() {
        let mut old = base_snapshot();
        old.as_object_mut().unwrap().remove("io_multiplexing");
        let new = base_snapshot();

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            vec!["added top-level section \"io_multiplexing\""]
        );
    }

    #[test]
    fn adding_vfs_metadata_section_is_compatible() {
        let mut old = base_snapshot();
        old.as_object_mut().unwrap().remove("vfs_metadata");
        let new = base_snapshot();

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            vec!["added top-level section \"vfs_metadata\""]
        );
    }

    #[test]
    fn adding_vfs_metadata_entry_is_compatible() {
        let mut old = base_snapshot();
        old["vfs_metadata"]
            .as_object_mut()
            .unwrap()
            .remove("statfs_flags");
        let new = base_snapshot();

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            vec!["added vfs_metadata entry \"statfs_flags\""]
        );
    }

    #[test]
    fn adding_wakeup_event_wire_section_requires_an_abi_bump() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["wakeup_event_wire"] = wakeup_event_wire();

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            vec!["added top-level section \"wakeup_event_wire\""]
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
    fn adding_platform_or_spawn_contract_section_is_breaking() {
        let mut old = base_snapshot();
        old.as_object_mut().unwrap().remove("platform_limits");
        old.as_object_mut().unwrap().remove("spawn_contract");
        let new = base_snapshot();

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            vec![
                "added top-level section \"platform_limits\"",
                "added top-level section \"spawn_contract\"",
            ],
        );
    }

    #[test]
    fn changing_platform_limit_is_breaking() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["platform_limits"]["arg_max_bytes"] = json!(8 * 1024 * 1024);

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            vec!["changed top-level section \"platform_limits\""],
        );
    }

    #[test]
    fn changing_spawn_contract_is_breaking() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["spawn_contract"]["header"]["bytes"] = json!(44);

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            vec!["changed top-level section \"spawn_contract\""],
        );
    }

    #[test]
    fn adding_optional_host_adapter_export_is_compatible() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["host_adapter"]["optional_kernel_exports"] = json!(["kernel_get_process_exit_signal",]);

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

    fn snapshot_with_scheduled_kernel_export() -> Value {
        let mut snapshot = base_snapshot();
        snapshot["host_adapter"]["optional_kernel_exports"] = json!(["kernel_existing_helper"]);
        snapshot["host_adapter"]["kernel_export_lifecycles"] = json!([{
            "name": "kernel_existing_helper", "optional_since_abi": 10, "required_from_abi": 11,
        }]);
        snapshot
    }

    #[test]
    fn scheduling_a_future_kernel_export_requirement_is_additive() {
        let mut old = base_snapshot();
        old["host_adapter"]["optional_kernel_exports"] = json!(["kernel_existing_helper"]);
        let new = snapshot_with_scheduled_kernel_export();
        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            ["added host_adapter field \"kernel_export_lifecycles\""]
        );
    }

    #[test]
    fn scheduled_promotion_is_enforced_and_remains_an_abi_change() {
        let old = snapshot_with_scheduled_kernel_export();
        let mut next = old.clone();
        next["abi_version"] = json!(11);
        next["host_adapter"]["manifest"]["abi_version"] = json!(11);
        // A bumped ABI cannot retain the old optional list past its deadline.
        assert!(
            classify_compat_change(&old, &next)
                .unwrap_err()
                .contains("promotion deadline")
        );
        next["host_adapter"]["required_kernel_exports"] =
            json!(["__abi_version", "kernel_existing_helper"]);
        next["host_adapter"]["optional_kernel_exports"] = json!([]);
        let report = classify_compat_change(&old, &next).unwrap();
        assert!(
            report
                .breaking
                .contains(&"changed host_adapter field \"required_kernel_exports\"".into())
        );
        assert!(
            report
                .breaking
                .contains(&"changed top-level section \"abi_version\"".into())
        );
        // An early promotion under the original ABI is equally invalid.
        next["abi_version"] = json!(10);
        next["host_adapter"]["manifest"]["abi_version"] = json!(10);
        assert!(
            classify_compat_change(&old, &next)
                .unwrap_err()
                .contains("promotion deadline")
        );
    }

    #[test]
    fn scheduled_deadlines_cannot_be_silently_postponed_or_removed() {
        let old = snapshot_with_scheduled_kernel_export();
        let mut new = old.clone();
        new["host_adapter"]["kernel_export_lifecycles"][0]["required_from_abi"] = json!(12);
        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            ["changed host_adapter.kernel_export_lifecycles entry \"kernel_existing_helper\""]
        );
        new["host_adapter"]["kernel_export_lifecycles"] = json!([]);
        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            ["removed host_adapter.kernel_export_lifecycles entry \"kernel_existing_helper\""]
        );
    }

    #[test]
    fn scheduled_lifecycles_require_real_exports_and_valid_dates() {
        let old = base_snapshot();
        let mut new = snapshot_with_scheduled_kernel_export();
        new["kernel_exports"] = json!([]);
        assert!(
            classify_compat_change(&old, &new)
                .unwrap_err()
                .contains("missing from kernel Wasm")
        );
        for (since, from) in [(0, 11), (11, 12), (10, 10)] {
            let mut new = snapshot_with_scheduled_kernel_export();
            new["host_adapter"]["kernel_export_lifecycles"][0]["optional_since_abi"] = json!(since);
            new["host_adapter"]["kernel_export_lifecycles"][0]["required_from_abi"] = json!(from);
            assert!(
                classify_compat_change(&old, &new)
                    .unwrap_err()
                    .contains("invalid or unordered")
            );
        }
    }

    #[test]
    fn changed_existing_export_is_breaking() {
        let old = base_snapshot();
        let mut new = old.clone();
        new["kernel_exports"][1]["signature"] = json!("(i64) -> ()");

        let report = classify_compat_change(&old, &new).unwrap();
        assert_eq!(
            report.breaking,
            vec!["changed kernel_exports entry \"kernel_existing_helper\""]
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

    // -- kernel_imports: the polarity of the host contract --------------
    //
    // These four tests exist because the section they cover is a gate,
    // and a gate that cannot fail is not a gate. Each one asserts a
    // classification that would have been WRONG under the export rule.

    #[test]
    fn changing_a_kernel_import_signature_is_breaking() {
        // The K2 case, verbatim: widening a kernel-supplied address
        // from 32 to 64 bits changes how the host must interpret the
        // pointer. Before imports were recorded this produced no
        // snapshot diff at all.
        let old = base_snapshot();
        let mut new = base_snapshot();
        for entry in new["kernel_imports"].as_array_mut().unwrap() {
            if entry["name"] == json!("host_proc_read_bytes") {
                entry["signature"] = json!("(i32,i64,i32,i32) -> (i32)");
            }
        }

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.additive.is_empty(), "{report:?}");
        assert_eq!(
            report.breaking,
            vec!["changed kernel_imports entry \"env.host_proc_read_bytes\""]
        );
    }

    #[test]
    fn adding_a_kernel_import_is_breaking() {
        // Inverse of the export rule. A host built against the old
        // contract cannot supply this function, so instantiation fails.
        // This is the check that makes growing the host surface a
        // deliberate, gated act.
        let old = base_snapshot();
        let mut new = base_snapshot();
        new["kernel_imports"].as_array_mut().unwrap().push(json!({
            "module": "env",
            "name": "host_brand_new_capability",
            "kind": "func",
            "signature": "(i32) -> (i32)"
        }));

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.additive.is_empty(), "{report:?}");
        assert_eq!(
            report.breaking,
            vec!["added kernel_imports entry \"env.host_brand_new_capability\""]
        );
    }

    #[test]
    fn removing_a_kernel_import_is_compatible() {
        // Also the inverse of the export rule. WebAssembly resolves
        // imports by name, so a host that still offers one the module
        // no longer asks for is unaffected. This is what lets the
        // campaign shrink the host surface without an ABI bump.
        let mut old = base_snapshot();
        old["kernel_imports"].as_array_mut().unwrap().push(json!({
            "module": "env",
            "name": "host_retired_capability",
            "kind": "func",
            "signature": "(i32) -> (i32)"
        }));
        let new = base_snapshot();

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            vec!["removed kernel_imports entry \"env.host_retired_capability\""]
        );
    }

    #[test]
    fn changing_the_imported_memory_shape_is_breaking() {
        // Shared-ness and the limits are part of the channel handshake,
        // not incidental module metadata.
        let old = base_snapshot();
        let mut new = base_snapshot();
        for entry in new["kernel_imports"].as_array_mut().unwrap() {
            if entry["kind"] == json!("memory") {
                entry["shared"] = json!(false);
            }
        }

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.additive.is_empty(), "{report:?}");
        assert_eq!(
            report.breaking,
            vec!["changed kernel_imports entry \"env.memory\""]
        );
    }

    #[test]
    fn adding_the_kernel_imports_section_is_compatible() {
        // The one-time introduction of the section itself. Without
        // `kernel_imports` in `additive_top_level_section` the ABI gate
        // fails on the very commit that adds the section, and the
        // tempting wrong fix is a spurious ABI_VERSION bump.
        let mut old = base_snapshot();
        old.as_object_mut().unwrap().remove("kernel_imports");
        let new = base_snapshot();

        let report = classify_compat_change(&old, &new).unwrap();
        assert!(report.breaking.is_empty(), "{report:?}");
        assert_eq!(
            report.additive,
            vec!["added top-level section \"kernel_imports\""]
        );
    }

    #[test]
    fn kernel_imports_records_the_whole_import_section_of_a_module() {
        // Round-trip the generator against a hand-built module so the
        // parse is checked independently of whatever the current kernel
        // artifact happens to contain.
        let wat = r#"
            (module
              (import "env" "memory" (memory 18 16384 shared))
              (import "env" "host_write" (func (param i64 i32 i32) (result i32)))
              (import "env" "host_proc_read_bytes"
                (func (param i32 i64 i32 i32) (result i32)))
              (import "env" "host_epoch_millis" (func (result f64)))
            )
        "#;
        let bytes = wat::parse_str(wat).expect("assemble fixture module");
        let value = kernel_imports(&bytes).expect("record imports");
        let entries = value.as_array().unwrap();

        // Every import, in deterministic (module, name) order, with no
        // filtering: completeness is the contract.
        assert_eq!(
            entries
                .iter()
                .map(|e| e["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "host_epoch_millis",
                "host_proc_read_bytes",
                "host_write",
                "memory",
            ]
        );
        assert_eq!(
            entries[1],
            json!({
                "module": "env",
                "name": "host_proc_read_bytes",
                "kind": "func",
                "signature": "(i32,i64,i32,i32) -> (i32)"
            })
        );
        assert_eq!(
            entries[3],
            json!({
                "module": "env",
                "name": "memory",
                "kind": "memory",
                "memory64": false,
                "shared": true,
                "minimum_pages": 18,
                "maximum_pages": 16384
            })
        );
    }
}
