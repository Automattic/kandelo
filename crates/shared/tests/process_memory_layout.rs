//! The Rust half of the one-layout contract.
//!
//! `tests/process-memory-layouts.json` carries expectations derived by hand
//! from `compute_layout`'s documented rule, and this test checks the Rust
//! implementation against them.
//!
//! Checking BOTH hosts against one corpus is what would make "one process
//! memory layout" a fact a test can fail on — two hosts each asserting their
//! own numbers pass for as long as they happen to agree, which is exactly how
//! they came to disagree about `__heap_base`. The TypeScript half
//! (`host/test/process-memory-layout.test.ts`, reaching the same function
//! through a `wa_process_memory_layout` export) checks every case this one
//! does except those the corpus marks `programBytesOnly`, where an imported
//! memory's minimum needs a real binary to present.
//!
//! **The refusals are still this test's alone.** The TypeScript half writes
//! two of them out by hand instead of reading them from the corpus, so the
//! three it does not restate — both saturating refusals and the exact-fit
//! boundary — are checked in one host only.

use serde_json::Value;
use wasm_posix_shared::process_memory::{compute_layout, LayoutError, LayoutRequest};

fn corpus() -> Value {
    let text = include_str!("process-memory-layouts.json");
    serde_json::from_str(text).expect("layout corpus is valid JSON")
}

fn u32_at(value: &Value, key: &str) -> u32 {
    u32::try_from(value[key].as_u64().unwrap_or_else(|| panic!("{key} is a number")))
        .unwrap_or_else(|_| panic!("{key} fits a u32"))
}

fn u64_at(value: &Value, key: &str) -> u64 {
    value[key]
        .as_u64()
        .unwrap_or_else(|| panic!("{key} is a number"))
}

fn request_of(case: &Value) -> LayoutRequest {
    let request = &case["request"];
    LayoutRequest {
        maximum_pages: u32_at(request, "maximumPages"),
        imported_minimum_pages: u32_at(request, "importedMinimumPages"),
        requested_minimum_pages: u32_at(request, "requestedMinimumPages"),
        heap_base: request["heapBase"].as_u64(),
        thread_slot_count: u32_at(request, "threadSlotCount"),
    }
}

/// The message shape each host renders, so the corpus can pin refusals as the
/// words a caller actually sees rather than as an enum variant only Rust has.
fn describe(error: LayoutError) -> String {
    match error {
        LayoutError::MaximumPagesTooSmall { maximum_pages } => {
            format!("invalid process maximum pages: {maximum_pages}")
        }
        LayoutError::InitialPagesExceedMaximum {
            initial_pages,
            maximum_pages,
        } => format!("initial pages {initial_pages} exceed process maximum {maximum_pages}"),
    }
}

#[test]
fn every_corpus_layout_is_placed_where_the_rule_says() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().expect("cases is an array");
    assert!(!cases.is_empty(), "the corpus placed no layouts at all");
    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let layout = compute_layout(request_of(case))
            .unwrap_or_else(|error| panic!("{name}: refused with {}", describe(error)));
        let expected = &case["layout"];
        assert_eq!(layout.initial_pages, u32_at(expected, "initialPages"), "{name}: initial_pages");
        assert_eq!(layout.maximum_pages, u32_at(expected, "maximumPages"), "{name}: maximum_pages");
        assert_eq!(layout.control_base, u64_at(expected, "controlBase"), "{name}: control_base");
        assert_eq!(layout.control_end, u64_at(expected, "controlEnd"), "{name}: control_end");
        assert_eq!(
            layout.channel_offset,
            u64_at(expected, "channelOffset"),
            "{name}: channel_offset",
        );
        assert_eq!(layout.channel_page, u32_at(expected, "channelPage"), "{name}: channel_page");
        assert_eq!(layout.brk_base, u64_at(expected, "brkBase"), "{name}: brk_base");
        assert_eq!(layout.mmap_base, u64_at(expected, "mmapBase"), "{name}: mmap_base");
        assert_eq!(layout.brk_limit, u64_at(expected, "brkLimit"), "{name}: brk_limit");
        assert_eq!(layout.max_addr, u64_at(expected, "maxAddr"), "{name}: max_addr");
        assert_eq!(
            layout.thread_slot_count,
            u32_at(expected, "threadSlotCount"),
            "{name}: thread_slot_count",
        );
    }
}

#[test]
fn every_corpus_refusal_is_refused_with_the_message_the_corpus_names() {
    let corpus = corpus();
    let refusals = corpus["refusals"].as_array().expect("refusals is an array");
    assert!(!refusals.is_empty(), "the corpus refused nothing at all");
    for case in refusals {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let expected = case["message"].as_str().expect("refusal names its message");
        match compute_layout(request_of(case)) {
            Ok(layout) => panic!("{name}: placed {layout:?} instead of refusing"),
            Err(error) => assert_eq!(describe(error), expected, "{name}"),
        }
    }
}

/// The pthread rule, stated as the three answers a program can get.
///
/// A binary predating the declaration and one that explicitly defers both take
/// the host default; zero is honoured as zero, because a program that asks for
/// no threads should get EAGAIN rather than whatever the host had spare.
#[test]
fn a_thread_slot_declaration_resolves_to_what_the_program_asked_for() {
    use wasm_posix_shared::process_memory::resolve_thread_slot_count;
    assert_eq!(resolve_thread_slot_count(None, 1024), Ok(1024));
    assert_eq!(resolve_thread_slot_count(Some(-1), 1024), Ok(1024));
    assert_eq!(resolve_thread_slot_count(Some(0), 1024), Ok(0));
    assert_eq!(resolve_thread_slot_count(Some(7), 1024), Ok(7));
    assert_eq!(resolve_thread_slot_count(Some(-2), 1024), Err(-2));
}

/// The TypeScript half must still be reading this corpus.
///
/// "One corpus, both hosts" is a claim about two files, and nothing here
/// could see it stop being true. If `host/test/process-memory-layout.test.ts`
/// stopped reading `process-memory-layouts.json` -- or were deleted, which is the
/// direction this campaign actually pushes, since its whole purpose is
/// removing TypeScript -- this file would go on passing and the corpus would
/// quietly be checked in one host while still describing itself as shared.
///
/// This does not forbid that deletion. It makes it deliberate: whoever takes
/// the TypeScript half out has to come here and say so, in the same change.
#[test]
fn the_typescript_half_still_reads_this_corpus() {
    let consumer = concat!("../../host/test/process-memory-", "layout.test.ts");
    // CARGO_MANIFEST_DIR is `crates/shared`, so the repo root is two up.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(consumer);
    let source = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "the TypeScript half of this corpus is unreadable at {}: {error}. \
             If it was deleted on purpose, this corpus is single-host now and \
             both this test and the corpus header must say so.",
            path.display(),
        )
    });
    // The READ, not a mention. The first version of this asserted the
    // filename appeared somewhere in the file -- which a doc comment
    // satisfies, so a half that stopped reading the corpus but kept its
    // header would have passed. `cargo xtask perturb` found that by keeping
    // a mutant alive.
    let read = concat!("../../crates/shared/tests/", "process-memory-layouts.json");
    assert!(
        source.contains(read),
        "{} no longer reads this corpus, so 'one corpus, both hosts' is false \
         while everything is green. Say so here and in the corpus header, or \
         restore the read.",
        path.display(),
    );
}
