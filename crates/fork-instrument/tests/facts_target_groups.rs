use facts::storage::{FactsStore, StorageLimits};
use fork_instrument::{facts, streaming::scan};
use wasm_encoder::{CustomSection, Encode};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Sites {
    MissingFacts,
    Untyped,
    Typed,
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
    if sites == Sites::Typed {
        text.push_str("F\tt0\t1\nT\tt0\tKnown\nD\tt0\t0\t0\n");
        text.push_str("F\tt1\t1\nT\tt1\tOther\nD\tt1\t0\t0\n");
    }
    for i in 0..callers {
        wasm.push_str(&format!(
            "(func $c{i} (type $sig) local.get 0 local.get 0 call_indirect (type $sig))"
        ));
        if sites != Sites::MissingFacts {
            let kind = if sites == Sites::Untyped {
                "untyped"
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
    for sites in [Sites::MissingFacts, Sites::Untyped, Sites::Typed] {
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
        let expected: Vec<_> = (0..1200)
            .filter(|i| sites != Sites::Typed || *i != 1)
            .collect();
        for caller in 1200..1800 {
            assert_eq!(
                store.targets_for(caller, "i32->i32").unwrap(),
                Some(expected.clone())
            );
        }
        assert!(store.targets_for(0, "i32->i32").unwrap().is_none());
        assert!(store.report().unwrap().database_bytes < 4 * 1024 * 1024);
    }
}

#[test]
fn shared_fallback_projection_matches_the_unchanged_oracle() {
    for sites in [Sites::MissingFacts, Sites::Untyped, Sites::Typed] {
        let input = fixture(12, 8, sites);
        let scan = scan(&input).unwrap();
        let store = FactsStore::from_scan(&scan, Default::default()).unwrap();
        let report = store.resolve_calls(&scan, Default::default()).unwrap();
        let native = store.collect_call_facts().unwrap();
        let module = walrus::ModuleConfig::new().parse(&input).unwrap();
        let (oracle, old_report) = facts::call_facts(
            &module,
            scan.custom_data(facts::SECTION).next().unwrap(),
            Default::default(),
        )
        .unwrap();
        assert_eq!(native.itargets, oracle.itargets);
        assert_eq!(native.cleanup, oracle.cleanup);
        assert_eq!(native.jmp, oracle.jmp);
        assert_eq!(report, old_report);
    }
}
