//! The Rust half of the one-bounds-rule contract.
//!
//! See `tests/host-memory-ranges.json` for why the corpus exists and which
//! half of it the TypeScript host can present.

use serde_json::Value;
use wasm_posix_shared::host_memory::{checked_range, RangeError};

const PAGE: u64 = 65_536;

#[test]
fn every_corpus_range_is_judged_the_way_the_rule_says() {
    let corpus: Value = serde_json::from_str(include_str!("host-memory-ranges.json"))
        .expect("range corpus is valid JSON");
    let cases = corpus["cases"].as_array().expect("cases is an array");
    assert!(!cases.is_empty(), "the corpus judged nothing at all");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let addr = case["addr"].as_u64().expect("addr is a number");
        let len = case["len"].as_u64().expect("len is a number");
        let limit = case["limitPages"].as_u64().expect("limitPages is a number") * PAGE;
        let allow_address_zero = case["allowAddressZero"].as_bool().unwrap_or(false);
        let verdict = case["verdict"].as_str().expect("verdict is a string");

        let actual = match checked_range(addr, len, limit, allow_address_zero) {
            Ok(offset) => {
                assert_eq!(offset, addr, "{name}: an admitted range reports its own address");
                "ok"
            }
            Err(RangeError::NullPointer) => "null-pointer",
            Err(RangeError::EndOverflows) => "end-overflows",
            Err(RangeError::OutOfBounds { .. }) => "out-of-bounds",
        };
        assert_eq!(actual, verdict, "{name}");
    }
}

/// The corpus must keep presenting the case the TypeScript half cannot, and
/// must keep presenting cases it can — a corpus that quietly became all
/// `rustOnly` would leave the TypeScript half checking nothing while still
/// reporting a pass.
#[test]
fn the_corpus_still_has_something_for_each_host() {
    let corpus: Value = serde_json::from_str(include_str!("host-memory-ranges.json"))
        .expect("range corpus is valid JSON");
    let cases = corpus["cases"].as_array().expect("cases is an array");
    let shared = cases
        .iter()
        .filter(|case| !case["rustOnly"].as_bool().unwrap_or(false))
        .count();
    assert!(shared >= 8, "only {shared} cases are presentable to both hosts");
    assert!(
        cases.iter().any(|case| case["rustOnly"].as_bool().unwrap_or(false)),
        "the memory64 overflow case is gone; if that is deliberate, say so here",
    );
}

/// The TypeScript half must still be reading this corpus.
///
/// "One corpus, both hosts" is a claim about two files, and nothing here
/// could see it stop being true. If `host/test/kernel-scratch-range.test.ts`
/// stopped reading `host-memory-ranges.json` -- or were deleted, which is the
/// direction this campaign actually pushes, since its whole purpose is
/// removing TypeScript -- this file would go on passing and the corpus would
/// quietly be checked in one host while still describing itself as shared.
///
/// This does not forbid that deletion. It makes it deliberate: whoever takes
/// the TypeScript half out has to come here and say so, in the same change.
#[test]
fn the_typescript_half_still_reads_this_corpus() {
    let consumer = concat!("../../host/test/kernel-", "scratch-range.test.ts");
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
    assert!(
        source.contains("host-memory-ranges.json"),
        "{} no longer reads this corpus, so 'one corpus, both hosts' is false \
         while everything is green. Say so here and in the corpus header, or \
         restore the read.",
        path.display(),
    );
}
