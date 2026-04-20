//! Regenerate `abi/snapshot.json` from authoritative sources.
//!
//! Sources (all compiled into this binary via the `wasm_posix_shared` crate):
//!
//!   * [`wasm_posix_shared::ABI_VERSION`] — the integer version number
//!   * [`wasm_posix_shared::Syscall`] — named syscall number table
//!   * [`wasm_posix_shared::channel`] — channel header byte layout
//!   * Marshalled repr(C) structs — offsets via `core::mem::offset_of!`
//!   * [`wasm_posix_shared::abi`] — asyncify save slots, global names,
//!     custom-section name
//!
//! Kernel export signatures (parsed from the built wasm) are not yet
//! included in this snapshot; that is planned as a follow-up change
//! once the structural foundation in this PR is in place.

use std::collections::BTreeMap;
use std::mem::{offset_of, size_of};
use std::path::PathBuf;

use serde_json::{json, Value};
use wasm_posix_shared as shared;

use crate::{repo_root, JsonMap};

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut out_path: Option<PathBuf> = None;
    let mut check = false;

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--out" => out_path = Some(it.next().ok_or("--out requires a path")?.into()),
            "--check" => check = true,
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    let snapshot = build_snapshot()?;
    let rendered = render_deterministic(&snapshot);

    let out = out_path.unwrap_or_else(|| repo_root().join("abi/snapshot.json"));

    if check {
        let existing = std::fs::read_to_string(&out)
            .map_err(|e| format!("read {}: {e}", out.display()))?;
        if existing != rendered {
            eprintln!(
                "ABI snapshot at {} is out of date.\n\
                 Run `bash scripts/check-abi-version.sh --update` to regenerate,\n\
                 and bump `ABI_VERSION` in crates/shared/src/lib.rs if the\n\
                 contract actually changed.",
                out.display()
            );
            return Err("snapshot drift".into());
        }
        println!("abi snapshot up-to-date: {}", out.display());
        return Ok(());
    }

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&out, &rendered)
        .map_err(|e| format!("write {}: {e}", out.display()))?;
    println!("wrote {}", out.display());
    Ok(())
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

fn build_snapshot() -> Result<JsonMap, String> {
    let mut root: JsonMap = BTreeMap::new();

    root.insert("abi_version".into(), json!(shared::ABI_VERSION));

    root.insert("channel_header".into(), channel_header());
    root.insert("channel_signal_area".into(), channel_signal_area());
    root.insert("channel_buffers".into(), channel_buffers());

    root.insert("marshalled_structs".into(), marshalled_structs());
    root.insert("syscalls".into(), syscalls());
    root.insert("channel_status_codes".into(), channel_status_codes());
    root.insert("asyncify_save_slots".into(), asyncify_save_slots());
    root.insert("custom_sections".into(), custom_sections());
    root.insert("process_expected_globals".into(), process_expected_globals());

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

fn channel_signal_area() -> Value {
    use shared::channel::*;
    let entries = [
        ("SIG_SIGNUM", SIG_SIGNUM, 4u32, "u32, signal number (0=none)"),
        ("SIG_HANDLER", SIG_HANDLER, 4, "u32, handler table index"),
        ("SIG_FLAGS", SIG_FLAGS, 4, "u32, sa_flags"),
        ("SIG_OLD_MASK", SIG_OLD_MASK, 8, "u64 (LE), saved blocked mask"),
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
    use shared::{WasmDirent, WasmFlock, WasmPollFd, WasmStat, WasmStatfs, WasmTimespec};

    let mut structs: JsonMap = BTreeMap::new();
    structs.insert(
        "WasmStat".into(),
        struct_layout!(WasmStat {
            st_dev, st_ino, st_mode, st_nlink, st_uid, st_gid, st_size,
            st_atime_sec, st_atime_nsec,
            st_mtime_sec, st_mtime_nsec,
            st_ctime_sec, st_ctime_nsec,
            _pad,
        }),
    );
    structs.insert(
        "WasmDirent".into(),
        struct_layout!(WasmDirent { d_ino, d_type, d_namlen }),
    );
    structs.insert(
        "WasmFlock".into(),
        struct_layout!(WasmFlock { l_type, l_whence, _pad1, l_start, l_len, l_pid, _pad2 }),
    );
    structs.insert(
        "WasmTimespec".into(),
        struct_layout!(WasmTimespec { tv_sec, tv_nsec }),
    );
    structs.insert(
        "WasmPollFd".into(),
        struct_layout!(WasmPollFd { fd, events, revents }),
    );
    structs.insert(
        "WasmStatfs".into(),
        struct_layout!(WasmStatfs {
            f_type, f_bsize, f_blocks, f_bfree, f_bavail, f_files, f_ffree,
            f_fsid, f_namelen, f_frsize, f_flags, _pad,
        }),
    );

    Value::Object(structs.into_iter().collect())
}

fn syscalls() -> Value {
    // Walk 0..1024 and collect every number the Syscall enum names.
    // Gaps (numbers handled in wasm_api.rs dispatch but not named in the
    // enum) are intentionally NOT in scope for this snapshot — they are
    // tracked by a follow-up change that moves all syscall numbers into
    // the enum as the single source of truth.
    let mut list = Vec::new();
    for n in 0u32..1024 {
        if let Some(s) = shared::Syscall::from_u32(n) {
            let mut m: JsonMap = BTreeMap::new();
            m.insert("number".into(), json!(n));
            m.insert("name".into(), json!(format!("{s:?}")));
            list.push(Value::Object(m.into_iter().collect()));
        }
    }
    Value::Array(list)
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

fn asyncify_save_slots() -> Value {
    let mut list = Vec::new();
    for slot in shared::abi::ASYNCIFY_SAVE_SLOTS {
        let mut m: JsonMap = BTreeMap::new();
        m.insert("name".into(), json!(slot.name));
        m.insert("meaning".into(), json!(slot.meaning));
        m.insert("offset_wasm32".into(), json!(slot.offset_wasm32));
        m.insert("offset_wasm64".into(), json!(slot.offset_wasm64));
        m.insert("width_wasm32".into(), json!(slot.width_wasm32));
        m.insert("width_wasm64".into(), json!(slot.width_wasm64));
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

fn render_deterministic(root: &JsonMap) -> String {
    // Value::Object built from a BTreeMap serializes with BTreeMap's
    // alphabetical iteration, giving deterministic output.
    let value = Value::Object(root.clone().into_iter().collect());
    let mut s = serde_json::to_string_pretty(&value).expect("serialize");
    s.push('\n');
    s
}
