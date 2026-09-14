//! Drive the module's exports the way the JavaScript driver does.
//!
//! These run natively against the `rlib` face, so they exercise the request
//! decoding, the library call and the answer encoding — everything except the
//! engine boundary itself. That boundary is covered separately by
//! `host/test/wasm-binary-parse.test.ts`, which drives the built wasm.
//!
//! WHY this pairing rather than only the TypeScript suite: a wire defect that
//! makes both sides agree on the *wrong* layout is invisible to a round trip
//! through one codec. Here the expected bytes are written out by hand at the
//! point it matters, so the format is pinned by something other than its own
//! encoder.

use wasm_artifact_module::wire::{Reader, Writer, WIRE_VERSION};
use wasm_artifact_module::{
    wa_custom_section, wa_detect_pointer_width, wa_fork_contract, wa_input_reserve,
    wa_is_wasm_module, wa_output_len, wa_output_ptr, wa_policy, wa_process_memory_layout,
    wa_read_facts, wa_wire_version, WA_ERROR, WA_OK,
};

/// Copy `parts` into the module's input buffer, as the driver does.
fn write_input(parts: &[&[u8]]) {
    let total: usize = parts.iter().map(|p| p.len()).sum();
    let address = wa_input_reserve(total as u32);
    let mut offset = 0usize;
    for part in parts {
        // SAFETY: `wa_input_reserve` just sized the buffer to exactly `total`
        // bytes and returned its address; this writes within that range only.
        unsafe {
            core::ptr::copy_nonoverlapping(
                part.as_ptr(),
                (address as *mut u8).add(offset),
                part.len(),
            );
        }
        offset += part.len();
    }
}

/// A fresh copy of the module's answer bytes.
fn read_output() -> Vec<u8> {
    let address = wa_output_ptr() as *const u8;
    let length = wa_output_len() as usize;
    // SAFETY: the module published exactly `length` bytes at `address` and has
    // not been called since.
    unsafe { core::slice::from_raw_parts(address, length) }.to_vec()
}

fn output_text() -> String {
    String::from_utf8(read_output()).expect("module messages are UTF-8")
}

/// Encode a policy request, matching `host/src/wasm-artifact-driver.ts`.
fn policy_request(
    expected_abi: Option<u32>,
    digest: Option<&[u8]>,
    required: &[&str],
    forbidden: &[&str],
    require_fork: u8,
    forbid_fork: bool,
) -> Vec<u8> {
    let mut writer = Writer::versioned();
    writer.bool(expected_abi.is_some());
    writer.u32(expected_abi.unwrap_or(0));
    writer.bool(digest.is_some());
    writer.bytes(digest.unwrap_or(&[]));
    writer.u32(required.len() as u32);
    for name in required {
        writer.string(name);
    }
    writer.u32(forbidden.len() as u32);
    for name in forbidden {
        writer.string(name);
    }
    writer.u8(require_fork);
    writer.bool(forbid_fork);
    writer.into_bytes()
}

/// Decode a `{ failures, warnings }` report.
fn decode_report(bytes: &[u8]) -> (Vec<String>, Vec<String>) {
    let mut reader = Reader::versioned(bytes).expect("report carries the current wire version");
    let failures = reader
        .strings()
        .expect("report has a failures list")
        .into_iter()
        .map(str::to_string)
        .collect();
    let warnings = reader
        .strings()
        .expect("report has a warnings list")
        .into_iter()
        .map(str::to_string)
        .collect();
    (failures, warnings)
}

fn empty_module() -> Vec<u8> {
    vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
}

#[test]
fn wire_version_is_reported_and_matches_the_constant() {
    assert_eq!(wa_wire_version(), WIRE_VERSION);
}

#[test]
fn the_preamble_question_answers_without_a_walkable_container() {
    // A shell script is a legitimate, expected answer here -- `exec` asks this
    // before it decides whether it is looking at a script or a program.
    let script = b"#!/bin/sh\necho hi\n";
    write_input(&[script]);
    assert_eq!(wa_is_wasm_module(script.len() as u32), 0);

    let module = empty_module();
    write_input(&[&module]);
    assert_eq!(wa_is_wasm_module(module.len() as u32), 1);

    // Truncated bytes are not a module, and must not read past the buffer.
    write_input(&[&module[..4]]);
    assert_eq!(wa_is_wasm_module(4), 0);
}

#[test]
fn pointer_width_answers_for_both_data_models() {
    let wasm32 = wat::parse_str(r#"(module (memory 1))"#).expect("valid wat");
    write_input(&[&wasm32]);
    assert_eq!(wa_detect_pointer_width(wasm32.len() as u32), 4);

    let wasm64 = wat::parse_str(r#"(module (memory i64 1))"#).expect("valid wat");
    write_input(&[&wasm64]);
    assert_eq!(wa_detect_pointer_width(wasm64.len() as u32), 8);

    // The bootstrap floor must answer even for a module with no memory: that is
    // wasm32, because a memory-less module has no pointers to disagree about.
    let none = empty_module();
    write_input(&[&none]);
    assert_eq!(wa_detect_pointer_width(none.len() as u32), 4);
}

#[test]
fn a_length_beyond_what_was_written_is_refused_not_read() {
    let module = empty_module();
    write_input(&[&module]);
    // Claim more than the buffer holds. The module must refuse rather than
    // read whatever follows in its linear memory.
    assert_eq!(wa_read_facts(module.len() as u32 + 64), WA_ERROR);
    assert!(output_text().contains("exceeds the bytes written"));
}

#[test]
fn a_custom_section_is_found_absent_or_refused_distinguishably() {
    let module = wat::parse_str(
        r#"(module (@custom "kandelo.abi.contract" "\01\02\03"))"#,
    )
    .expect("valid wat");

    let name = b"kandelo.abi.contract";
    write_input(&[&module, name]);
    assert_eq!(
        wa_custom_section(module.len() as u32, name.len() as u32),
        1,
        "the stamped section is present"
    );
    assert_eq!(read_output(), vec![1, 2, 3]);

    // Absent is 0 with an empty payload -- a legacy artifact predating the
    // stamp is a rollout state the policy WARNS about, not a defect.
    let missing = b"kandelo.absent";
    write_input(&[&module, missing]);
    assert_eq!(
        wa_custom_section(module.len() as u32, missing.len() as u32),
        0
    );
    assert!(read_output().is_empty());

    // A malformed request is neither of those.
    write_input(&[&module]);
    assert_eq!(wa_custom_section(module.len() as u32, 32), WA_ERROR);
}

#[test]
fn facts_decode_at_the_layout_the_driver_expects() {
    let module = wat::parse_str(
        r#"(module
            (import "kernel" "kernel_fork" (func (param i32) (result i32)))
            (import "env" "memory" (memory 1))
            (func (export "_start"))
            (global (export "__heap_base") i32 (i32.const 1024))
        )"#,
    )
    .expect("valid wat");

    write_input(&[&module]);
    assert_eq!(wa_read_facts(module.len() as u32), WA_OK);
    let facts = read_output();

    let mut reader = Reader::versioned(&facts).expect("facts carry the current wire version");
    assert_eq!(reader.u8().expect("pointer width"), 4);

    // __abi_version: absent here.
    assert!(!reader.bool().expect("abi presence"));
    let _abi = reader.u32().expect("abi value is always written");

    // __heap_base: present, and read from the global's init expression.
    assert!(reader.bool().expect("heap-base presence"));
    let heap_base_lo = reader.u32().expect("heap base low word");
    let _heap_base_hi = reader.u32().expect("heap base high word");
    assert_eq!(heap_base_lo, 1024);

    assert!(!reader.bool().expect("thread-slot presence"));
    let _slots = reader.u32().expect("thread-slot value");

    assert!(!reader.bool().expect("legacy asyncify"));
    assert!(reader.bool().expect("imports kernel.kernel_fork"));
    assert!(!reader.bool().expect("relocatable side module"));
    assert!(!reader.bool().expect("relocatable object"));
    let _fork_surface = reader.bool().expect("fork surface");

    let _custom = reader.strings().expect("custom section names");

    // Import descriptors, in declaration order.
    assert_eq!(reader.u32().expect("import count"), 2);
    assert_eq!(reader.str().expect("module"), "kernel");
    assert_eq!(reader.str().expect("name"), "kernel_fork");
    assert_eq!(reader.u8().expect("kind"), 0, "a function import");
    assert_eq!(reader.str().expect("module"), "env");
    assert_eq!(reader.str().expect("name"), "memory");
    assert_eq!(reader.u8().expect("kind"), 2, "a memory import");
}

#[test]
fn a_policy_reports_failures_and_warnings_separately() {
    let module = empty_module();
    let request = policy_request(Some(44), None, &["_start"], &[], 2, false);
    write_input(&[&module, &request]);
    assert_eq!(
        wa_policy(module.len() as u32, request.len() as u32),
        WA_OK,
        "a refused artifact is still a successful CALL"
    );
    let (failures, warnings) = decode_report(&read_output());

    assert_eq!(failures, vec!["missing required exports: _start"]);
    assert_eq!(warnings.len(), 1, "the missing ABI marker warns");
    assert!(warnings[0].contains("__abi_version"));
}

#[test]
fn a_policy_request_at_an_unknown_wire_version_is_refused() {
    let module = empty_module();
    let mut request = policy_request(None, None, &[], &[], 2, false);
    request[0] = request[0].wrapping_add(7);
    write_input(&[&module, &request]);
    assert_eq!(wa_policy(module.len() as u32, request.len() as u32), WA_ERROR);
    assert!(output_text().contains("unrecognised wire version"));
}

#[test]
fn an_unreadable_artifact_still_names_the_epoch_in_its_contract_failure() {
    // The TypeScript this replaces turned a walk error into a contract failure
    // naming the epoch, so a caller that renders only failures still says
    // something true. Preserved deliberately.
    let junk = b"not a wasm module at all";
    write_input(&[junk]);
    assert_eq!(wa_fork_contract(junk.len() as u32), WA_OK);
    let output = read_output();
    let mut reader = Reader::versioned(&output).expect("versioned");
    let failures = reader.strings().expect("failures");
    assert_eq!(failures.len(), 1);
    assert!(failures[0].contains("fork-artifact contract"));
    assert!(
        failures[0].contains(&wasm_posix_shared::ABI_VERSION.to_string()),
        "the message names the epoch it was measured against: {}",
        failures[0]
    );
}

/// Encode a process-memory-layout request, matching
/// `readWasmProcessMemoryLayout` in `host/src/wasm-artifact-driver.ts`.
fn layout_request(
    maximum_pages: u32,
    requested_minimum_pages: u32,
    default_thread_slots: u32,
    thread_slots: Option<u32>,
    heap_base: Option<u64>,
) -> Vec<u8> {
    let mut writer = Writer::versioned();
    writer.u32(maximum_pages);
    writer.u32(requested_minimum_pages);
    writer.u32(default_thread_slots);
    writer.bool(thread_slots.is_some());
    writer.u32(thread_slots.unwrap_or(0));
    writer.bool(heap_base.is_some());
    writer.u64(heap_base.unwrap_or(0));
    writer.into_bytes()
}

/// The eleven fields the driver decodes, in order.
struct DecodedLayout {
    initial_pages: u32,
    maximum_pages: u32,
    control_base: u64,
    control_end: u64,
    channel_offset: u64,
    channel_page: u32,
    brk_base: u64,
    mmap_base: u64,
    brk_limit: u64,
    max_addr: u64,
    thread_slot_count: u32,
}

fn decode_layout(bytes: &[u8]) -> DecodedLayout {
    let mut reader = Reader::versioned(bytes).expect("answer carries the wire version");
    DecodedLayout {
        initial_pages: reader.u32().unwrap(),
        maximum_pages: reader.u32().unwrap(),
        control_base: reader.u64().unwrap(),
        control_end: reader.u64().unwrap(),
        channel_offset: reader.u64().unwrap(),
        channel_page: reader.u32().unwrap(),
        brk_base: reader.u64().unwrap(),
        mmap_base: reader.u64().unwrap(),
        brk_limit: reader.u64().unwrap(),
        max_addr: reader.u64().unwrap(),
        thread_slot_count: reader.u32().unwrap(),
    }
}

/// A program that exports `__heap_base` and imports `pages` of memory.
fn program_with(heap_base: u32, pages: u32) -> Vec<u8> {
    wat::parse_str(&format!(
        r#"(module
             (import "env" "memory" (memory {pages}))
             (global (export "__heap_base") i32 (i32.const {heap_base})))"#
    ))
    .expect("valid wat")
}

/// The layout entry point reads the program's own facts, not the caller's.
///
/// The expected numbers are the ones
/// `crates/shared/tests/process-memory-layouts.json` derives by hand from the
/// documented rule — repeated here rather than imported, because this test is
/// about the WIRE: a request the module decodes differently from how the
/// driver encoded it would still produce a self-consistent answer, and only a
/// value pinned outside both codecs can see that.
#[test]
fn a_layout_request_round_trips_with_the_programs_own_heap_base() {
    // 2 MiB heap base is page 32, so the channel lands on page 33 and control
    // memory ends at page 35.
    let program = program_with(2 * 1024 * 1024, 1);
    let request = layout_request(16384, 0, 1024, None, None);
    write_input(&[&program, &request]);
    assert_eq!(
        wa_process_memory_layout(program.len() as u32, request.len() as u32),
        WA_OK,
        "{}",
        output_text(),
    );
    let layout = decode_layout(&read_output());
    assert_eq!(layout.initial_pages, 35);
    assert_eq!(layout.maximum_pages, 16384);
    assert_eq!(layout.control_base, 2_097_152);
    assert_eq!(layout.control_end, 2_293_760);
    assert_eq!(layout.channel_offset, 2_162_688);
    assert_eq!(layout.channel_page, 33);
    assert_eq!(layout.brk_base, 2_293_760);
    assert_eq!(layout.mmap_base, 2_293_760);
    assert_eq!(layout.brk_limit, 1_073_741_824);
    assert_eq!(layout.max_addr, 1_073_741_824);
    assert_eq!(layout.thread_slot_count, 1024);
}

/// An imported memory minimum above the heap base raises the floor, which is
/// the fact the TypeScript host used to read with its own LEB128 walk.
#[test]
fn a_layout_request_honours_the_imported_memory_minimum() {
    let program = program_with(1024, 600);
    let request = layout_request(16384, 0, 1024, None, None);
    write_input(&[&program, &request]);
    assert_eq!(
        wa_process_memory_layout(program.len() as u32, request.len() as u32),
        WA_OK,
        "{}",
        output_text(),
    );
    let layout = decode_layout(&read_output());
    assert_eq!(layout.initial_pages, 603);
    assert_eq!(layout.channel_page, 601);
    assert_eq!(layout.control_base, 39_321_600);
}

/// An explicit slot count bypasses the program's own declaration, and a
/// refusal comes back as text rather than as a plausible layout.
#[test]
fn a_layout_request_reports_an_impossible_ceiling_as_a_message() {
    let program = program_with(2 * 1024 * 1024, 1);

    let request = layout_request(16384, 0, 1024, Some(7), None);
    write_input(&[&program, &request]);
    assert_eq!(
        wa_process_memory_layout(program.len() as u32, request.len() as u32),
        WA_OK,
    );
    assert_eq!(decode_layout(&read_output()).thread_slot_count, 7);

    let request = layout_request(2, 0, 1024, None, None);
    write_input(&[&program, &request]);
    assert_eq!(
        wa_process_memory_layout(program.len() as u32, request.len() as u32),
        WA_ERROR,
    );
    assert_eq!(output_text(), "invalid process maximum pages: 2");
}

/// A truncated request is refused rather than decoded from whatever follows
/// it in the input buffer — which, since the program's bytes precede it, is
/// the program itself.
#[test]
fn a_truncated_layout_request_is_refused() {
    let program = program_with(2 * 1024 * 1024, 1);
    let mut request = layout_request(16384, 0, 1024, None, None);
    request.truncate(request.len() - 3);
    write_input(&[&program, &request]);
    assert_eq!(
        wa_process_memory_layout(program.len() as u32, request.len() as u32),
        WA_ERROR,
    );
    assert_eq!(output_text(), "layout request is truncated");
}

/// A caller may supply the heap base instead of letting the module read one.
///
/// `host/src/process-memory.ts` has always taken it from its caller — the
/// process lifecycle extracts it from the same bytes it passes, and a layout
/// placed with no program at all has nowhere else to get it. A request that
/// omits it falls back to the program's own `__heap_base`, which is what
/// `crates/host-native` relies on.
#[test]
fn a_caller_supplied_heap_base_overrides_the_programs_own() {
    let program = program_with(2 * 1024 * 1024, 1);

    // 0x00120000 is page 18, so the channel lands on page 19.
    let request = layout_request(16384, 0, 1024, None, Some(0x0012_0000));
    write_input(&[&program, &request]);
    assert_eq!(
        wa_process_memory_layout(program.len() as u32, request.len() as u32),
        WA_OK,
        "{}",
        output_text(),
    );
    let layout = decode_layout(&read_output());
    assert_eq!(layout.control_base, 0x0012_0000);
    assert_eq!(layout.channel_page, 19);

    // Omitted, the program's own 2 MiB heap base decides instead.
    let request = layout_request(16384, 0, 1024, None, None);
    write_input(&[&program, &request]);
    assert_eq!(
        wa_process_memory_layout(program.len() as u32, request.len() as u32),
        WA_OK,
    );
    assert_eq!(decode_layout(&read_output()).channel_page, 33);
}

/// A layout with no program at all is what a caller placing one from scratch
/// asks for, and the module must not refuse the bytes it cannot walk.
#[test]
fn a_layout_can_be_placed_with_no_program_at_all() {
    let request = layout_request(16384, 0, 1024, None, None);
    write_input(&[&request]);
    assert_eq!(wa_process_memory_layout(0, request.len() as u32), WA_OK, "{}", output_text());
    let layout = decode_layout(&read_output());
    // No heap base, no memory import, no declaration: the fixed fallback.
    assert_eq!(layout.control_base, 16_777_216);
    assert_eq!(layout.channel_page, 257);
    assert_eq!(layout.thread_slot_count, 1024);

    // And with a heap base but still no program — the shape six tests in
    // `host/test/process-memory.test.ts` use, and the one a reader that
    // insisted on `__heap_base` would have answered with the fallback while
    // still looking like an answer.
    let request = layout_request(16384, 18, 1024, Some(4), Some(0x0012_0000));
    write_input(&[&request]);
    assert_eq!(wa_process_memory_layout(0, request.len() as u32), WA_OK, "{}", output_text());
    let layout = decode_layout(&read_output());
    assert_eq!(layout.control_base, 0x0012_0000);
    assert_eq!(layout.channel_page, 19);
    assert_eq!(layout.thread_slot_count, 4);
}
