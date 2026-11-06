#[path = "support/snapshot.rs"]
mod snapshot;
use facts::storage::{FactsStore, StorageLimits};
use fork_instrument::{facts, streaming::scan};
use wasm_encoder::{CustomSection, Encode};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Sites {
    MissingFacts,
    Untyped,
    Typed,
    UnknownOnly,
    Mixed,
}

impl Sites {
    fn for_caller(self, index: u32) -> Self {
        if self != Self::Mixed {
            return self;
        }
        match index % 3 {
            0 => Self::MissingFacts,
            1 => Self::UnknownOnly,
            _ => Self::Typed,
        }
    }
    fn expected(self, targets: u32, caller: u32) -> Vec<u32> {
        let sites = self.for_caller(caller);
        (0..targets)
            .filter(|i| {
                if sites == Self::Typed {
                    *i != 1
                } else if sites == Self::UnknownOnly {
                    *i >= 2
                } else {
                    true
                }
            })
            .collect()
    }
}

fn fixture(targets: u32, callers: u32, sites: Sites) -> Vec<u8> {
    let mut wasm = format!(
        "(module (type $sig (func (param i32) (result i32))) \
         (table {targets} funcref) (elem (i32.const 0)"
    );
    for i in 0..targets {
        wasm.push_str(&format!(" $t{i}"));
    }
    wasm.push(')');
    for i in 0..targets {
        wasm.push_str(&format!("(func $t{i} (type $sig) local.get 0)"));
    }
    let mut text = String::from("#kandelo-calltypes\t5\nM\tgroups.c\n");
    if matches!(sites, Sites::Typed | Sites::UnknownOnly | Sites::Mixed) {
        text.push_str("F\tt0\t1\nT\tt0\tKnown\nD\tt0\t0\t0\n");
        text.push_str("F\tt1\t1\nT\tt1\tOther\nD\tt1\t0\t0\n");
    }
    for i in 0..callers {
        wasm.push_str(&format!(
            "(func $c{i} (type $sig) local.get 0 local.get 0 call_indirect (type $sig))"
        ));
        let caller_sites = sites.for_caller(i);
        if caller_sites != Sites::MissingFacts {
            let kind = if caller_sites == Sites::Untyped {
                "untyped"
            } else if caller_sites == Sites::UnknownOnly {
                "icall\tUnmatched"
            } else {
                "icall\tKnown"
            };
            text.push_str(&format!(
                "F\tc{i}\t1\nS\tc{i}\t0\ti32->i32\t{kind}\nD\tc{i}\t1\t1\n"
            ));
        }
    }
    wasm.push(')');
    let mut bytes = wat::parse_str(&wasm).unwrap();
    let hash = facts::code_sha256(&bytes).unwrap();
    for (name, data) in [
        (facts::SECTION, text.as_bytes()),
        (facts::CODE_HASH_SECTION, hash.as_slice()),
    ] {
        bytes.push(0);
        CustomSection {
            name: name.into(),
            data: data.into(),
        }
        .encode(&mut bytes);
    }
    bytes
}

#[test]
fn shared_signature_fallbacks_fit_without_a_caller_by_target_matrix() {
    for sites in [
        Sites::MissingFacts,
        Sites::Untyped,
        Sites::Typed,
        Sites::UnknownOnly,
    ] {
        let input = fixture(1200, 600, sites);
        let scan = scan(&input).unwrap();
        let store = FactsStore::from_scan(
            &scan,
            StorageLimits {
                disk_bytes: 4 * 1024 * 1024,
                ..Default::default()
            },
        )
        .unwrap();
        store.resolve_calls(&scan, Default::default()).unwrap();
        for caller in 1200..1800 {
            assert_eq!(
                store.targets_for(caller, "i32->i32").unwrap(),
                Some(sites.expected(1200, caller - 1200))
            );
        }
        assert!(store.targets_for(0, "i32->i32").unwrap().is_none());
        assert!(store.report().unwrap().database_bytes < 4 * 1024 * 1024);
    }
}

#[test]
fn shared_fallback_projection_preserves_expected_results() {
    for sites in [
        Sites::MissingFacts,
        Sites::Untyped,
        Sites::Typed,
        Sites::UnknownOnly,
        Sites::Mixed,
    ] {
        let input = fixture(12, 8, sites);
        let scan = scan(&input).unwrap();
        let store = FactsStore::from_scan(&scan, Default::default()).unwrap();
        let report = store.resolve_calls(&scan, Default::default()).unwrap();
        let native = store.collect_call_facts().unwrap();
        snapshot::check(&input, "fallback-targets", (native, report));
    }
}

#[test]
fn fallback_lookup_does_not_scan_functions_absent_from_the_table() {
    let input = fixture(1, 10_000, Sites::MissingFacts);
    let scan = scan(&input).unwrap();
    let complete = FactsStore::from_scan(&scan, Default::default()).unwrap();
    complete.resolve_calls(&scan, Default::default()).unwrap();
    let solved_work = complete.report().unwrap().estimated_work_steps;

    // Leave enough work for a small indexed group lookup, independent of the
    // many non-table functions sharing its signature. The result has one member.
    let limited = FactsStore::from_scan(
        &scan,
        StorageLimits {
            work_steps: solved_work + 20_000,
            ..Default::default()
        },
    )
    .unwrap();
    limited.resolve_calls(&scan, Default::default()).unwrap();
    assert_eq!(limited.targets_for(1, "i32->i32").unwrap(), Some(vec![0]));
}

#[test]
fn shared_cache_preserves_caller_modes_eviction_and_invalidation() {
    let input = fixture(16, 3, Sites::Mixed);
    let scan = scan(&input).unwrap();
    for cache_bytes in [0, 1, 256, 4 * 1024 * 1024] {
        let store = FactsStore::from_scan(
            &scan,
            StorageLimits {
                target_cache_bytes: cache_bytes,
                ..Default::default()
            },
        )
        .unwrap();
        store.resolve_calls(&scan, Default::default()).unwrap();
        for caller in [0, 1, 2, 0, 2, 1] {
            let mut targets = store.targets_for(16 + caller, "i32->i32").unwrap().unwrap();
            assert_eq!(targets, Sites::Mixed.expected(16, caller));
            targets.clear(); // Returned lists must not mutate cached memberships.
        }
        assert!(store.targets_for(0, "i32->i32").unwrap().is_none());
        store.solve_conversions(true, true).unwrap();
        assert!(store.targets_for(16, "i32->i32").is_err());
        store.resolve_calls(&scan, Default::default()).unwrap();
        assert_eq!(
            store.targets_for(16, "i32->i32").unwrap(),
            Some((0..16).collect())
        );
    }
}

#[test]
fn shared_cache_avoids_rereading_the_same_memberships_for_another_caller() {
    for sites in [Sites::MissingFacts, Sites::UnknownOnly] {
        let input = fixture(1200, 3, sites);
        let scan = scan(&input).unwrap();
        let complete = FactsStore::from_scan(&scan, Default::default()).unwrap();
        complete.resolve_calls(&scan, Default::default()).unwrap();
        complete.targets_for(1200, "i32->i32").unwrap().unwrap();
        let warm_work = complete.report().unwrap().estimated_work_steps;
        let limited = FactsStore::from_scan(
            &scan,
            StorageLimits {
                work_steps: warm_work + 20_000,
                ..Default::default()
            },
        )
        .unwrap();
        limited.resolve_calls(&scan, Default::default()).unwrap();
        limited
            .targets_for(1200, "i32->i32")
            .unwrap()
            .unwrap()
            .clear();
        assert_eq!(
            limited.targets_for(1201, "i32->i32").unwrap(),
            Some(sites.expected(1200, 1))
        );
        let uncached = FactsStore::from_scan(
            &scan,
            StorageLimits {
                target_cache_bytes: 0,
                work_steps: warm_work + 20_000,
                ..Default::default()
            },
        )
        .unwrap();
        uncached.resolve_calls(&scan, Default::default()).unwrap();
        uncached.targets_for(1200, "i32->i32").unwrap().unwrap();
        let error = uncached.targets_for(1201, "i32->i32").unwrap_err();
        let message = format!("{error:#}");
        assert!(
            message.contains("budget") || message.contains("interrupt"),
            "{message}"
        );
    }
}
