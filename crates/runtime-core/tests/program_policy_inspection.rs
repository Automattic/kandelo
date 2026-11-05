use kandelo_program_policy::Inspection;
use runtime_core::program_preparation::{InitialPreparation, initial_preparation};
use runtime_core::program_preparation::{PreparationLimits, PreparationPlan, PreparationProfile};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, Ordering};
use wasm_artifact::policy_surface::PolicyReadLimits;

static DENY: AtomicBool = AtomicBool::new(false);
struct Allocator;
#[global_allocator]
static ALLOCATOR: Allocator = Allocator;

unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if DENY.load(Ordering::Relaxed) {
            core::ptr::null_mut()
        } else {
            unsafe { System.alloc(layout) }
        }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe {
            System.dealloc(pointer, layout);
        }
    }
}

fn leb(output: &mut Vec<u8>, mut value: usize) {
    loop {
        let byte = (value & 127) as u8;
        value >>= 7;
        output.push(byte | if value == 0 { 0 } else { 128 });
        if value == 0 {
            break;
        }
    }
}

#[test]
fn trusted_inspections_validate_plans_originals_and_outputs_without_parser_allocations() {
    let source = include_bytes!("../../../abi/program-fixtures/v55/raw-fork.wasm");
    let read_limits = PolicyReadLimits {
        metadata_bytes: 1024 * 1024,
        work_items: 1_000_000,
    };
    let inspected = Inspection::read(source, read_limits).unwrap();
    let profile = PreparationProfile {
        preparer_sha256: [1; 32],
        optimizer_sha256: None,
        options_sha256: [2; 32],
        dependency_closure_sha256: [3; 32],
        program_contract_sha256: inspected.contract().unwrap(),
        program_abi: 55,
    };
    let limits = PreparationLimits {
        source_bytes: 1024 * 1024,
        original_bytes: 1024 * 1024,
        output_bytes: 1024 * 1024,
        metadata_bytes: read_limits.metadata_bytes,
        metadata_work_items: read_limits.work_items,
    };
    let expected = PreparationPlan::from_source(source, profile, limits).unwrap();
    let mut payload = Vec::new();
    let name = wasm_artifact::original_program::ORIGINAL_REFERENCE_SECTION.as_bytes();
    leb(&mut payload, name.len());
    payload.extend_from_slice(name);
    payload.extend_from_slice(&inspected.source().encode());
    let mut output = source.to_vec();
    output.push(0);
    leb(&mut output, payload.len());
    output.extend_from_slice(&payload);
    let output_inspected = Inspection::read(&output, read_limits).unwrap();
    let expected_receipt = expected.verify_output(&output).unwrap();
    let encoded = expected_receipt.encode();
    let source_record = inspected.encode();
    let output_record = output_inspected.encode();
    let ready = include_bytes!("../../../abi/program-fixtures/v55/echo.wasm");
    let ready_inspected = Inspection::read(ready, read_limits).unwrap();
    let prepared_program =
        include_bytes!("../../../abi/program-fixtures/v55/environment-lifecycle.wasm");
    let prepared_inspected = Inspection::read(prepared_program, read_limits).unwrap();

    DENY.store(true, Ordering::Relaxed);
    let source_decoded = Inspection::decode(&source_record);
    let decision = initial_preparation(source, &inspected, profile, limits);
    let ready_decision = initial_preparation(ready, &ready_inspected, profile, limits);
    let prepared_decision =
        initial_preparation(prepared_program, &prepared_inspected, profile, limits);
    let output_decoded = Inspection::decode(&output_record);
    let planned = PreparationPlan::from_inspected_source(source, &inspected, profile, limits);
    let original = expected.verify_original_inspected(source, &inspected);
    let prepared = expected.verify_output_inspected(&output, &output_inspected);
    let cached = expected.verify_cached_output_inspected(&output, &encoded, &output_inspected);
    DENY.store(false, Ordering::Relaxed);

    assert_eq!(source_decoded, Ok(inspected));
    assert_eq!(decision, Ok(InitialPreparation::Required));
    assert_eq!(ready_decision, Ok(InitialPreparation::NotNeeded));
    assert_eq!(prepared_decision, Ok(InitialPreparation::NotNeeded));
    assert_eq!(output_decoded, Ok(output_inspected));
    assert_eq!(planned, Ok(expected));
    assert_eq!(original, Ok(()));
    assert_eq!(prepared, Ok(expected_receipt));
    assert_eq!(cached, Ok(expected_receipt));

    let mut changed = source.to_vec();
    changed[10] ^= 1;
    assert!(PreparationPlan::from_inspected_source(&changed, &inspected, profile, limits).is_err());
    assert!(
        expected
            .verify_output_inspected(&output, &inspected)
            .is_err()
    );
    let mut smaller = limits;
    smaller.metadata_work_items -= 1;
    assert!(PreparationPlan::from_inspected_source(source, &inspected, profile, smaller).is_err());
    let mut old_abi = inspected.encode();
    old_abi[60] = 54;
    assert!(
        PreparationPlan::from_inspected_source(
            source,
            &Inspection::decode(&old_abi).unwrap(),
            profile,
            limits
        )
        .is_err()
    );
}
