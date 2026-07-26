use fork_instrument::contract_inventory::{
    ArtifactAbiVersion, ForkContractInventory, artifact_identity, fork_capability_section_hex,
    fork_contract_inventory, linked_frame_descriptor_section_hex,
};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn contract_wat(pointer: &str, memory: &str) -> String {
    format!(
        r#"
        (module
          (@custom "kandelo.wpk_fork.linked_frames" "descriptor")
          (@custom "kandelo.wpk_fork.capabilities" "\01\04")
          ;; Keep non-function GC and exception types ahead of ABI function
          ;; types. Type indices must be resolved structurally, not by assuming
          ;; every type-section entry is a function.
          (type $cell (struct (field (mut i32))))
          (type $exception (func (param i32)))
          (tag $exception_tag (type $exception))
          (import "kernel" "kernel_fork" (func $kernel_fork))
          (import "env" "__wpk_fork_frame_reserve"
            (func $frame_reserve (param {pointer}) (result {pointer})))
          (import "env" "__wpk_fork_frame_commit"
            (func $frame_commit (param {pointer})))
          (import "env" "__wpk_fork_frame_next"
            (func $frame_next (param {pointer}) (result {pointer})))
          {memory}
          (func (export "wpk_fork_abort_begin") (param {pointer}))
          (func (export "wpk_fork_abort_end"))
          (func (export "wpk_fork_rewind_begin") (param {pointer}))
          (func (export "wpk_fork_rewind_end"))
          (func (export "wpk_fork_state") (result i32)
            i32.const 0)
          (func (export "wpk_fork_unwind_begin") (param {pointer}))
          (func (export "wpk_fork_unwind_end")))
        "#
    )
}

fn parse_contract(pointer: &str, memory: &str) -> ForkContractInventory {
    let bytes = wat::parse_str(contract_wat(pointer, memory)).expect("compile contract WAT");
    fork_contract_inventory(&bytes).expect("inventory contract")
}

#[test]
fn inventories_gc_and_exception_modules_without_decoding_code_bodies() {
    let inventory = parse_contract("i32", "(memory 1)");
    assert_eq!(
        inventory.to_string(),
        "0\t1\t1\t1\t1\t1\t1\t1\t1\t1\t1\t1\t1\t1\t1\t0\t0\t0\t0"
    );
}

#[test]
fn imported_memory64_selects_i64_pointer_signatures() {
    let inventory = parse_contract("i64", r#"(import "env" "memory" (memory i64 1))"#);
    assert_eq!(inventory.memory_count, 1);
    assert_eq!(inventory.memory64_count, 1);
    assert_eq!(inventory.signature_mismatch, 0);
}

#[test]
fn reports_each_signature_that_disagrees_with_memory_width() {
    let bytes = wat::parse_str(
        contract_wat("i64", "(memory 1)")
            .replace(
                r#"(func (export "wpk_fork_state") (result i32)"#,
                r#"(func (export "wpk_fork_state") (result i64)"#,
            )
            .replace("i32.const 0", "i64.const 0"),
    )
    .expect("compile mismatched contract WAT");
    let inventory = fork_contract_inventory(&bytes).expect("inventory contract");

    // Six pointer-bearing imports/exports use i64 in a memory32 module, and
    // wpk_fork_state independently has the wrong result type.
    assert_eq!(inventory.signature_mismatch, 7);
}

#[test]
fn counts_duplicate_contract_sections_and_function_exports() {
    let bytes = wat::parse_str(
        contract_wat("i32", "(memory 1)")
            .replace(
                r#"(@custom "kandelo.wpk_fork.capabilities" "\01\04")"#,
                r#"(@custom "kandelo.wpk_fork.capabilities" "\01\04")
                   (@custom "kandelo.wpk_fork.capabilities" "\01\04")"#,
            )
            .replace(
                r#"(func (export "wpk_fork_abort_end"))"#,
                r#"(func (export "wpk_fork_abort_end")
                         (export "wpk_fork_abort_end"))"#,
            ),
    )
    .expect("compile duplicate contract WAT");
    let inventory = fork_contract_inventory(&bytes).expect("inventory contract");

    assert_eq!(inventory.fork_capability, 2);
    assert_eq!(inventory.abort_end, 2);
    assert_eq!(inventory.signature_mismatch, 0);
}

#[test]
fn artifact_identity_reads_abi_thunks_without_decoding_modern_helpers_as_text() {
    let bytes = wat::parse_str(
        r#"
        (module
          (type $cell (struct (field (mut i32))))
          (memory i64 1)
          (func $modern_helper (result (ref null $cell))
            ref.null $cell)
          (func $ctors)
          (func $abi_actual (result i32)
            i32.const 43)
          (func (export "__abi_version") (result i32)
            call $ctors
            call $abi_actual))
        "#,
    )
    .expect("compile artifact identity WAT");
    let identity = artifact_identity(&bytes).expect("inspect artifact identity");

    assert_eq!(identity.relocatable, 0);
    assert_eq!(identity.memory_count, 1);
    assert_eq!(identity.memory64_count, 1);
    assert_eq!(identity.abi_version, ArtifactAbiVersion::Present(43));
    assert_eq!(identity.imports_kernel_fork, 0);
    assert_eq!(identity.has_fork_exports, 0);
    assert_eq!(identity.to_string(), "0\t1\t1\tpresent\t43\t0\t0");
}

#[test]
fn artifact_identity_distinguishes_missing_and_invalid_abi_exports() {
    let missing = wat::parse_str(r#"(module (memory 1))"#).expect("compile missing ABI WAT");
    assert_eq!(
        artifact_identity(&missing)
            .expect("inspect missing ABI")
            .abi_version,
        ArtifactAbiVersion::Missing,
    );

    let dynamic = wat::parse_str(
        r#"
        (module
          (memory 1)
          (global $version i32 (i32.const 43))
          (func (export "__abi_version") (result i32)
            global.get $version))
        "#,
    )
    .expect("compile dynamic ABI WAT");
    assert_eq!(
        artifact_identity(&dynamic)
            .expect("inspect invalid ABI")
            .abi_version,
        ArtifactAbiVersion::Invalid,
    );
}

#[test]
fn cli_contract_inventory_emits_only_the_stable_tsv_row() {
    let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let path: PathBuf = std::env::temp_dir().join(format!(
        "kandelo-contract-inventory-{}-{id}.wasm",
        std::process::id()
    ));
    fs::write(
        &path,
        wat::parse_str(contract_wat("i32", "(memory 1)")).expect("compile contract WAT"),
    )
    .expect("write contract module");

    let output = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg("--contract-inventory")
        .arg(&path)
        .output()
        .expect("run contract inventory CLI");

    assert!(
        output.status.success(),
        "inventory CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).expect("UTF-8 inventory"),
        "0\t1\t1\t1\t1\t1\t1\t1\t1\t1\t1\t1\t1\t1\t1\t0\t0\t0\t0\n"
    );
    assert!(output.stderr.is_empty());

    let capability = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg("--fork-capability-hex")
        .arg(&path)
        .output()
        .expect("run capability inventory CLI");
    assert!(
        capability.status.success(),
        "capability CLI failed: {}",
        String::from_utf8_lossy(&capability.stderr)
    );
    assert_eq!(
        String::from_utf8(capability.stdout).expect("UTF-8 capability"),
        "1d6b616e64656c6f2e77706b5f666f726b2e6361706162696c69746965730104\n"
    );

    let identity = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg("--artifact-identity")
        .arg(&path)
        .output()
        .expect("run artifact identity CLI");
    assert!(
        identity.status.success(),
        "artifact identity CLI failed: {}",
        String::from_utf8_lossy(&identity.stderr)
    );
    assert_eq!(
        String::from_utf8(identity.stdout).expect("UTF-8 artifact identity"),
        "0\t1\t0\tmissing\t-\t1\t1\n"
    );

    let descriptor = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg("--linked-frame-descriptor-hex")
        .arg(&path)
        .output()
        .expect("run descriptor inventory CLI");
    let _ = fs::remove_file(path);
    assert!(
        descriptor.status.success(),
        "descriptor CLI failed: {}",
        String::from_utf8_lossy(&descriptor.stderr)
    );
    assert_eq!(
        String::from_utf8(descriptor.stdout).expect("UTF-8 descriptor"),
        concat!(
            "1e6b616e64656c6f2e77706b5f666f726b2e6c696e6b65645f6672616d6573",
            "64657363726970746f72\n",
        )
    );
}

#[test]
fn inventories_the_reentrant_legacy_loader_import() {
    let bytes = wat::parse_str(
        contract_wat("i32", "(memory 1)").replace(
            r#"(import "kernel" "kernel_fork" (func $kernel_fork))"#,
            r#"(import "kernel" "kernel_fork" (func $kernel_fork))
               (import "env" "__wasm_dlopen"
                 (func (param i32 i32 i32 i32 i32) (result i32)))"#,
        ),
    )
    .expect("compile legacy loader inventory WAT");
    let inventory = fork_contract_inventory(&bytes).expect("inventory legacy loader");
    assert_eq!(inventory.legacy_dlopen, 1);
}

#[test]
fn inventories_a_native_start_section() {
    let bytes = wat::parse_str(
        contract_wat("i32", "(memory 1)").replace(
            r#"(func (export "wpk_fork_abort_end"))"#,
            r#"(func $native_start (export "wpk_fork_abort_end"))
               (start $native_start)"#,
        ),
    )
    .expect("compile native-start inventory WAT");
    let inventory = fork_contract_inventory(&bytes).expect("inventory native start");
    assert_eq!(inventory.native_start, 1);
}

#[test]
fn custom_section_modes_require_one_exact_section() {
    let complete = wat::parse_str(contract_wat("i32", "(memory 1)")).expect("compile contract WAT");
    assert_eq!(
        fork_capability_section_hex(&complete).expect("capability hex"),
        "1d6b616e64656c6f2e77706b5f666f726b2e6361706162696c69746965730104"
    );
    assert_eq!(
        linked_frame_descriptor_section_hex(&complete).expect("descriptor hex"),
        concat!(
            "1e6b616e64656c6f2e77706b5f666f726b2e6c696e6b65645f6672616d6573",
            "64657363726970746f72",
        )
    );

    let duplicate = wat::parse_str(contract_wat("i32", "(memory 1)").replace(
        r#"(@custom "kandelo.wpk_fork.capabilities" "\01\04")"#,
        r#"(@custom "kandelo.wpk_fork.capabilities" "\01\04")
           (@custom "kandelo.wpk_fork.capabilities" "\01\04")"#,
    ))
    .expect("compile duplicate capability WAT");
    assert!(fork_capability_section_hex(&duplicate).is_err());

    let missing = wat::parse_str(r#"(module (memory 1))"#).expect("compile missing sections WAT");
    assert!(fork_capability_section_hex(&missing).is_err());
    assert!(linked_frame_descriptor_section_hex(&missing).is_err());
}
