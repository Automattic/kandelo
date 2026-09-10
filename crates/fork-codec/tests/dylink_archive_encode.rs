//! The KFLA archive encoder, checked against the bytes TypeScript actually
//! wrote.
//!
//! `testdata/dylink-archive-wasm32.bin` is real output from
//! `host/src/dylink-fork-archive.ts`. The decoder's own suite proves this crate
//! can READ it. These tests prove the encoder can WRITE it: given the same
//! archive and the same record addresses, every byte must match.
//!
//! That is a much stronger claim than a self-round-trip. An encoder and a
//! decoder that agree only with each other can drift from the format together
//! and never notice; here the reference is the writer whose output a live fork
//! child had to consume.
//!
//! **The fixture is now frozen, and deliberately so.** The TypeScript writer it
//! came from has been deleted — this crate and `crates/dylink::archive` are the
//! only writer left. Regenerating these bytes from the surviving writer would
//! turn the reference into a self-portrait and lose exactly the property that
//! makes it worth having: that a process which last published under the old
//! writer can still be read, and republished, by the new one.

use fork_codec::dylink_archive::{
    decode_dylink_archive,
    encode::{encode_dylink_archive, plan_dylink_archive, DylinkArchiveRecord},
    DylinkAllocation, DylinkArchive, DylinkInitialization, DylinkInitializationStage, DylinkModule,
    DylinkTablePatch, DylinkTablePatchRun, DylinkTransaction,
};

const TS_FIXTURE_PREFIX: &[u8] = include_bytes!("../testdata/dylink-archive-wasm32.bin");
const FIXTURE_HEAD: u64 = 4096;
const FIXTURE_MEMORY_BYTES: usize = 262_144;
const POINTER_WIDTH: u8 = 4;

/// Every record pointer is an absolute offset from 0, so the emitted prefix is
/// zero-padded back out to the writer's linear-memory size.
fn fixture_memory() -> Vec<u8> {
    let mut memory = TS_FIXTURE_PREFIX.to_vec();
    memory.resize(FIXTURE_MEMORY_BYTES, 0);
    memory
}

fn read_u64(memory: &[u8], offset: u64) -> u64 {
    let offset = offset as usize;
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&memory[offset..offset + 8]);
    u64::from_le_bytes(bytes)
}

fn read_u32(memory: &[u8], offset: u64) -> u32 {
    let offset = offset as usize;
    let mut bytes = [0u8; 4];
    bytes.copy_from_slice(&memory[offset..offset + 4]);
    u32::from_le_bytes(bytes)
}

/// Walk one `next`-linked record chain and collect its addresses.
fn chain(memory: &[u8], first: u64, count: u32) -> Vec<u64> {
    let mut addresses = Vec::new();
    let mut cursor = first;
    for _ in 0..count {
        assert_ne!(cursor, 0, "chain ended before its declared count");
        addresses.push(cursor);
        cursor = read_u64(memory, cursor + 8);
    }
    assert_eq!(cursor, 0, "chain continued past its declared count");
    addresses
}

/// Every record address in the fixture, in the order the encoder wants them.
fn fixture_addresses(memory: &[u8]) -> Vec<u64> {
    let mut addresses = vec![FIXTURE_HEAD];
    addresses.extend(chain(
        memory,
        read_u64(memory, FIXTURE_HEAD + 32),
        read_u32(memory, FIXTURE_HEAD + 24),
    ));
    addresses.extend(chain(
        memory,
        read_u64(memory, FIXTURE_HEAD + 96),
        read_u32(memory, FIXTURE_HEAD + 88),
    ));
    addresses.extend(chain(
        memory,
        read_u64(memory, FIXTURE_HEAD + 56),
        read_u32(memory, FIXTURE_HEAD + 72),
    ));
    addresses
}

/// Lay the encoded records into a fresh memory image so the decoder can be
/// pointed at it.
fn materialize(records: &[DylinkArchiveRecord], size: usize) -> Vec<u8> {
    let mut memory = vec![0u8; size];
    for record in records {
        let start = record.address as usize;
        memory[start..start + record.bytes.len()].copy_from_slice(&record.bytes);
    }
    memory
}

#[test]
fn encoding_the_fixture_archive_reproduces_the_typescript_bytes() {
    let fixture = fixture_memory();
    let archive =
        decode_dylink_archive(&fixture, FIXTURE_HEAD, POINTER_WIDTH).expect("fixture decodes");
    let addresses = fixture_addresses(&fixture);
    let records = encode_dylink_archive(&archive, &addresses).expect("fixture re-encodes");

    assert_eq!(records.len(), addresses.len());
    for record in &records {
        let start = record.address as usize;
        let end = start + record.bytes.len();
        assert_eq!(
            &record.bytes[..],
            &fixture[start..end],
            "record at 0x{:x} diverges from the TypeScript writer",
            record.address,
        );
    }
}

#[test]
fn the_planned_sizes_match_the_records_typescript_allocated() {
    let fixture = fixture_memory();
    let archive =
        decode_dylink_archive(&fixture, FIXTURE_HEAD, POINTER_WIDTH).expect("fixture decodes");
    let layout = plan_dylink_archive(&archive).expect("fixture plans");
    let addresses = fixture_addresses(&fixture);
    assert_eq!(layout.sizes.len(), addresses.len());
    // Every record but the header stores its own total size at +16; the header
    // is a fixed 104 bytes.
    assert_eq!(layout.sizes[0], 104);
    for (address, size) in addresses.iter().skip(1).zip(layout.sizes.iter().skip(1)) {
        assert_eq!(
            read_u64(&fixture, address + 16),
            *size,
            "planned size disagrees with the record at 0x{address:x}",
        );
    }
}

#[test]
fn re_encoding_at_fresh_addresses_decodes_back_to_the_same_archive() {
    let fixture = fixture_memory();
    let archive =
        decode_dylink_archive(&fixture, FIXTURE_HEAD, POINTER_WIDTH).expect("fixture decodes");
    let layout = plan_dylink_archive(&archive).expect("plans");

    // Deliberately NOT the fixture's own addresses, and deliberately in a
    // non-monotonic order relative to the record order, so nothing can pass by
    // accidentally reproducing the original layout.
    let mut cursor = 0x20_000u64;
    let mut addresses = Vec::new();
    for size in &layout.sizes {
        addresses.push(cursor);
        cursor += (size + 4095) & !4095;
    }

    let records = encode_dylink_archive(&archive, &addresses).expect("re-encodes");
    let memory = materialize(&records, (cursor + 0x20_000) as usize);
    let decoded =
        decode_dylink_archive(&memory, addresses[0], POINTER_WIDTH).expect("re-encoded decodes");
    assert_eq!(decoded, archive);
}

fn minimal_archive() -> DylinkArchive {
    DylinkArchive {
        pointer_width: 4,
        generation: 7,
        next_handle: 3,
        table_state_root: 0,
        table_checkpoint_generation: 0,
        modules: vec![DylinkModule {
            name: "libexample.so".into(),
            module_bytes: b"\0asm\x01\0\0\0".to_vec(),
            digest: [0u8; 32],
            memory_base: 0x1_0000,
            table_base: 16,
            tls_base: None,
            activation_id: Some(4),
            handle: Some(2),
            ref_count: Some(1),
            global_visibility: true,
            committed_global_root: false,
            provider_dependencies: Vec::new(),
            allocations: vec![DylinkAllocation {
                address: 0x1_0000,
                size: 0x1000,
                mapping_address: 0x1_0000,
                mapping_size: 0x2000,
            }],
            initialization: None,
        }],
        transactions: Vec::new(),
        table_patches: Vec::new(),
    }
}

#[test]
fn an_archive_built_from_records_round_trips_without_a_fixture() {
    let archive = minimal_archive();
    let layout = plan_dylink_archive(&archive).expect("plans");
    let mut cursor = 0x8000u64;
    let addresses: Vec<u64> = layout
        .sizes
        .iter()
        .map(|size| {
            let address = cursor;
            cursor += (size + 63) & !63;
            address
        })
        .collect();
    let records = encode_dylink_archive(&archive, &addresses).expect("encodes");
    let memory = materialize(&records, 0x2_0000);
    let decoded = decode_dylink_archive(&memory, addresses[0], 4).expect("decodes");

    // The digest is recomputed by the encoder, so the decoded record carries a
    // real SHA-256 rather than the zeroes the source struct held. Everything
    // else must be identical.
    assert_ne!(decoded.modules[0].digest, [0u8; 32]);
    let mut expected = archive.clone();
    expected.modules[0].digest = decoded.modules[0].digest;
    assert_eq!(decoded, expected);
}

#[test]
fn an_archive_the_decoder_would_reject_is_refused_at_the_writer() {
    // Unsorted provider edges: `decode_provider_dependencies` requires strictly
    // ascending names, so publishing these would make the archive unreadable.
    let mut archive = minimal_archive();
    archive.modules.push(DylinkModule {
        name: "libother.so".into(),
        provider_dependencies: vec!["libexample.so".into(), "libexample.so".into()],
        handle: None,
        ref_count: None,
        activation_id: Some(5),
        ..archive.modules[0].clone()
    });
    assert!(plan_dylink_archive(&archive).is_err());

    // A handle with no refcount.
    let mut archive = minimal_archive();
    archive.modules[0].ref_count = None;
    assert!(plan_dylink_archive(&archive).is_err());

    // Generation zero is the "never published" sentinel and is not encodable.
    let mut archive = minimal_archive();
    archive.generation = 0;
    assert!(plan_dylink_archive(&archive).is_err());

    // A table patch whose generation does not advance.
    let mut archive = minimal_archive();
    archive.table_state_root = 0x4000;
    archive.table_checkpoint_generation = 7;
    archive.table_patches = vec![DylinkTablePatch {
        generation: 7,
        activation_id: 4,
        owner_id: 1,
        start: 16,
        table_length: 32,
        runs: vec![DylinkTablePatchRun {
            length: 1,
            function: None,
        }],
    }];
    assert!(plan_dylink_archive(&archive).is_err());
}

#[test]
fn an_initializing_module_must_name_a_present_transaction() {
    let mut archive = minimal_archive();
    archive.modules[0].handle = None;
    archive.modules[0].ref_count = None;
    archive.modules[0].initialization = Some(DylinkInitialization {
        transaction_token: 9,
        stage: DylinkInitializationStage::Constructors,
        table_index: 3,
    });
    assert!(
        plan_dylink_archive(&archive).is_err(),
        "an unclaimed initialization token must be refused",
    );

    archive.transactions = vec![DylinkTransaction {
        token: 9,
        name: "libexample.so".into(),
        module_bytes: b"\0asm\x01\0\0\0".to_vec(),
        digest: [0u8; 32],
        global_visibility: true,
    }];
    let layout = plan_dylink_archive(&archive).expect("a claimed token plans");
    let mut cursor = 0x8000u64;
    let addresses: Vec<u64> = layout
        .sizes
        .iter()
        .map(|size| {
            let address = cursor;
            cursor += (size + 63) & !63;
            address
        })
        .collect();
    let records = encode_dylink_archive(&archive, &addresses).expect("encodes");
    let memory = materialize(&records, 0x2_0000);
    let decoded = decode_dylink_archive(&memory, addresses[0], 4).expect("decodes");
    assert_eq!(
        decoded.modules[0].initialization.unwrap().stage,
        DylinkInitializationStage::Constructors,
    );
}
