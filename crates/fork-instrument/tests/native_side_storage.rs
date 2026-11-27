use fork_instrument::{
    Options,
    artifact_io::SpoolStorage,
    contract_inventory::{ArtifactAbiVersion, artifact_identity},
    native, streaming,
};
use std::{
    fs::File,
    io,
    sync::atomic::{AtomicUsize, Ordering},
};
use wasm_encoder::{CustomSection, Encode};

struct Storage {
    calls: AtomicUsize,
    fail_at: Option<usize>,
}
impl Storage {
    fn new(fail_at: Option<usize>) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            fail_at,
        }
    }
}
// SAFETY: fresh tempfile transfers its only handle and has no public Unix path.
unsafe impl SpoolStorage for Storage {
    fn create(&self) -> io::Result<File> {
        let call = self.calls.fetch_add(1, Ordering::Relaxed);
        if self.fail_at == Some(call) {
            return Err(io::Error::other(format!(
                "injected private spool failure {call}"
            )));
        }
        tempfile::tempfile()
    }
}

fn side_module() -> Vec<u8> {
    // Include both code and data, plus a dynamic import requiring the original
    // side-entry closure. This exercises real section spools and metadata.
    let plain = wat::parse_str(
        r#"(module
        (import "env" "foreign" (func $foreign (param i32) (result i32)))
        (memory (import "env" "memory") 1)
        (data (i32.const 0) "side data")
        (func (export "probe") (param i32) (result i32)
            local.get 0 call $foreign))"#,
    )
    .unwrap();
    let mut bytes = plain[..8].to_vec();
    bytes.push(0);
    CustomSection {
        name: "dylink.0".into(),
        data: (&[1, 4, 0, 0, 0, 0][..]).into(),
    }
    .encode(&mut bytes);
    bytes.extend_from_slice(&plain[8..]);
    bytes
}

#[test]
fn injected_storage_preserves_original_side_transform_and_result_lifetime() {
    let input = side_module();
    let expected = native::instrument(
        &input,
        &Options {
            entry_import: "env.fork".into(),
            ..Default::default()
        },
        Default::default(),
    )
    .unwrap();
    let output = {
        let storage = Storage::new(None);
        let output =
            native::instrument_side_module_with_storage(&input, Default::default(), &storage)
                .unwrap();
        assert!(
            storage.calls.load(Ordering::Relaxed) >= 4,
            "raw, code, data and final artifact must all use the injected owner"
        );
        output
    };
    assert_eq!(output.bytes.bytes(), expected.bytes.bytes());
    assert_eq!(
        artifact_identity(output.bytes.bytes()).unwrap().abi_version,
        ArtifactAbiVersion::Present(wasm_posix_program_abi::ABI_VERSION)
    );
    assert!(output.decision.side_module && output.decision.participates);
    assert!(output.decision.facts.is_none());
    assert!(output.emission.is_some());
    assert!(output.source_map.is_none());
    let scan = streaming::scan(output.bytes.bytes()).unwrap();
    assert!(
        scan.custom_data(wasm_posix_program_abi::abi::WPK_FORK_CAPABILITIES_SECTION)
            .next()
            .is_some()
    );
    native::validate(output.bytes.bytes()).unwrap();
}

#[test]
fn every_spool_failure_propagates_without_falling_back_to_tempfiles() {
    let input = side_module();
    let successful = Storage::new(None);
    native::instrument_side_module_with_storage(&input, Default::default(), &successful).unwrap();
    let calls = successful.calls.load(Ordering::Relaxed);
    for fail_at in 0..calls {
        let storage = Storage::new(Some(fail_at));
        let error =
            native::instrument_side_module_with_storage(&input, Default::default(), &storage)
                .err()
                .expect("must fail");
        assert!(
            format!("{error:#}").contains(&format!("injected private spool failure {fail_at}"))
        );
        assert_eq!(storage.calls.load(Ordering::Relaxed), fail_at + 1);
    }
    // No shared failed-preparation state or changed process environment is
    // needed for the next independent invocation to succeed.
    native::instrument_side_module_with_storage(&input, Default::default(), &successful).unwrap();
}

#[test]
fn main_modules_are_rejected_before_allocating_private_storage() {
    let input = wat::parse_str("(module (func (export \"main\")))").unwrap();
    let storage = Storage::new(None);
    let error = native::instrument_side_module_with_storage(&input, Default::default(), &storage)
        .err()
        .expect("requires side role");
    assert!(error.to_string().contains("requires dylink.0"));
    assert_eq!(storage.calls.load(Ordering::Relaxed), 0);
}

#[test]
fn side_storage_keeps_existing_output_and_section_limits() {
    let input = side_module();
    for section_limit in [false, true] {
        let mut limits = native::Limits::default();
        if section_limit {
            limits.pipeline.emission.max_spooled_section_bytes = 1;
        } else {
            limits.output_bytes = 1;
        }
        let storage = Storage::new(None);
        let error = native::instrument_side_module_with_storage(&input, limits, &storage)
            .err()
            .expect("byte limit must be enforced");
        assert!(format!("{error:#}").contains("budget"), "{error:#}");
    }
}

#[test]
fn concurrent_invocations_do_not_share_storage_selection() {
    let input = side_module();
    std::thread::scope(|scope| {
        let failing = scope.spawn(|| {
            let storage = Storage::new(Some(1));
            assert!(
                native::instrument_side_module_with_storage(&input, Default::default(), &storage)
                    .is_err()
            );
            assert_eq!(storage.calls.load(Ordering::Relaxed), 2);
        });
        let working = scope.spawn(|| {
            let storage = Storage::new(None);
            native::instrument_side_module_with_storage(&input, Default::default(), &storage)
                .unwrap()
        });
        failing.join().unwrap();
        native::validate(working.join().unwrap().bytes.bytes()).unwrap();
    });
}
