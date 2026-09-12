//! The resumable archive walk, driven against a real encoded image.
//!
//! The walker's whole job is to name byte ranges: the standalone planner module
//! cannot address guest memory, so it must ask its host for the archive one
//! range at a time. The claim these tests make is that the ranges it names are
//! exactly the ranges the decoder reads — no more (which would make the host
//! copy bytes nobody needs) and no less (which would make the decoder fail on a
//! perfectly valid archive).
//!
//! The image under test is produced by the REAL encoder, not by hand: a
//! hand-built image could easily agree with a wrong walker about where a record
//! ends. `plan_dylink_archive` + `encode_dylink_archive` are the same pair a
//! forking process uses to publish, so the record extents here are the extents
//! that exist at runtime.

use fork_codec::dylink_archive::{
    decode_dylink_archive,
    encode::{dylink_module_template_digest, encode_dylink_archive, plan_dylink_archive},
    walk::{ArchiveWalk, SparseArchive},
    ArchiveBytes, DylinkAllocation, DylinkArchive, DylinkInitialization,
    DylinkInitializationStage, DylinkModule, DylinkTableFunction, DylinkTablePatch,
    DylinkTablePatchRun, DylinkTransaction,
};
use wasm_posix_shared::Errno;

const POINTER_WIDTH: u8 = 4;
const MEMORY_BYTES: u64 = 512 * 1024;
/// Records start well above zero so that a stray null pointer can never be
/// mistaken for a valid address.
const RECORD_BASE: u64 = 0x2000;

/// An archive with every payload shape a record can carry: provider edges,
/// allocations, TLS, an in-flight initialization with its staged transaction,
/// and a table patch with both a null run and a function run.
///
/// `digest` is left zero here and filled in by [`expected_archive`], because
/// the encoder recomputes the digest from the module bytes rather than carrying
/// a caller-supplied one forward.
fn source_archive() -> DylinkArchive {
    DylinkArchive {
        pointer_width: POINTER_WIDTH,
        generation: 5,
        next_handle: 4,
        table_state_root: 0x1000,
        table_checkpoint_generation: 2,
        modules: sample_modules(),
        transactions: vec![DylinkTransaction {
            token: 11,
            name: String::from("libinit.so"),
            module_bytes: vec![0, 97, 115, 109, 43],
            digest: [0u8; 32],
            global_visibility: false,
        }],
        table_patches: vec![DylinkTablePatch {
            generation: 4,
            activation_id: 7,
            owner_id: 3,
            start: 5,
            table_length: 12,
            runs: vec![
                DylinkTablePatchRun {
                    length: 2,
                    function: None,
                },
                DylinkTablePatchRun {
                    length: 3,
                    function: Some(DylinkTableFunction {
                        activation_id: 8,
                        ordinal: 4,
                    }),
                },
            ],
        }],
    }
}

fn sample_modules() -> Vec<DylinkModule> {
    vec![
        // A plain provider: no dependencies, no allocations. Its name is 7
        // bytes, so its padded name field also exercises the align-to-8 rule.
        DylinkModule {
            name: String::from("liba.so"),
            module_bytes: vec![0, 97, 115, 109, 1],
            digest: [0u8; 32],
            memory_base: 0x20000,
            table_base: 3,
            tls_base: None,
            activation_id: Some(7),
            handle: None,
            ref_count: None,
            global_visibility: true,
            committed_global_root: false,
            provider_dependencies: vec![],
            allocations: vec![],
            initialization: None,
        },
        // The widest record: a provider edge, two allocations, TLS, a handle.
        DylinkModule {
            name: String::from("libb.so"),
            module_bytes: vec![0, 97, 115, 109, 2, 2, 2],
            digest: [0u8; 32],
            memory_base: 0x21000,
            table_base: 9,
            tls_base: Some(0x22000),
            activation_id: Some(8),
            handle: Some(3),
            ref_count: Some(2),
            global_visibility: true,
            committed_global_root: true,
            provider_dependencies: vec![String::from("liba.so")],
            // Mappings sit far above the record region: the decoder rejects an
            // archived mapping that overlaps archive storage.
            allocations: vec![
                DylinkAllocation {
                    address: 0x30000,
                    size: 64,
                    mapping_address: 0x30000,
                    mapping_size: 4096,
                },
                DylinkAllocation {
                    address: 0x31010,
                    size: 32,
                    mapping_address: 0x31000,
                    mapping_size: 4096,
                },
            ],
            initialization: None,
        },
        // An in-flight dlopen: no handle yet, and it claims the transaction.
        DylinkModule {
            name: String::from("libinit.so"),
            module_bytes: vec![0, 97, 115, 109, 43],
            digest: [0u8; 32],
            memory_base: 0x23000,
            table_base: 20,
            tls_base: None,
            activation_id: Some(9),
            handle: None,
            ref_count: None,
            global_visibility: false,
            committed_global_root: false,
            provider_dependencies: vec![],
            allocations: vec![],
            initialization: Some(DylinkInitialization {
                transaction_token: 11,
                stage: DylinkInitializationStage::Relocations,
                table_index: 19,
            }),
        },
    ]
}

/// What a reader of the published image sees: [`source_archive`] with the
/// digests the encoder computes.
fn expected_archive() -> DylinkArchive {
    let mut archive = source_archive();
    for module in &mut archive.modules {
        module.digest = dylink_module_template_digest(&module.module_bytes);
    }
    for transaction in &mut archive.transactions {
        transaction.digest = dylink_module_template_digest(&transaction.module_bytes);
    }
    archive
}

/// Encode the archive into a flat linear-memory image, and report the head
/// address plus the total record bytes the image occupies.
fn encoded_image(archive: &DylinkArchive) -> (Vec<u8>, u64, u64) {
    let layout = plan_dylink_archive(archive).expect("archive plans");
    let mut addresses = Vec::with_capacity(layout.sizes.len());
    let mut cursor = RECORD_BASE;
    for size in &layout.sizes {
        addresses.push(cursor);
        cursor += (*size + 7) & !7;
    }
    let records = encode_dylink_archive(archive, &addresses).expect("archive encodes");
    let mut memory = vec![0u8; MEMORY_BYTES as usize];
    for record in &records {
        let start = record.address as usize;
        memory[start..start + record.bytes.len()].copy_from_slice(&record.bytes);
    }
    (memory, addresses[0], layout.total_bytes())
}

fn put_u64(memory: &mut [u8], offset: u64, value: u64) {
    let offset = offset as usize;
    memory[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn read_u64(memory: &[u8], offset: u64) -> u64 {
    let offset = offset as usize;
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&memory[offset..offset + 8]);
    u64::from_le_bytes(bytes)
}

/// Answer every range the walk asks for out of `memory`, the way a host would
/// answer out of guest linear memory. Reports the finished walk and how many
/// bytes were handed over.
fn drive(walk: &mut ArchiveWalk, memory: &[u8]) -> Result<u64, Errno> {
    let mut fetched = 0u64;
    let mut requests = 0u32;
    while let Some((address, length)) = walk.next_range() {
        // A walker that failed to make progress would otherwise hang the host.
        requests += 1;
        assert!(requests < 1000, "walk did not terminate");
        let start = address as usize;
        let end = start + length as usize;
        walk.supply(memory[start..end].to_vec())?;
        fetched += length;
    }
    Ok(fetched)
}

#[test]
fn the_walk_fetches_exactly_what_the_decoder_reads() {
    let expected = expected_archive();
    let (memory, head, total_record_bytes) = encoded_image(&expected);

    let mut walk = ArchiveWalk::new(head, POINTER_WIDTH, MEMORY_BYTES);
    let fetched = drive(&mut walk, &memory).expect("every range is answerable");
    let decoded = walk
        .finish()
        .expect("the fetched image decodes")
        .expect("a published archive is present");

    assert_eq!(decoded, expected);
    // Nothing outside the records was requested, and no record byte was
    // missed: the walk's ranges tile the archive exactly.
    assert_eq!(fetched, total_record_bytes);
    // The flat decoder over the same memory agrees, which is what makes the
    // sparse view a faithful substitute rather than a second format.
    assert_eq!(
        decode_dylink_archive(&memory[..], head, POINTER_WIDTH).expect("flat image decodes"),
        decoded
    );
}

#[test]
fn a_record_longer_than_its_header_is_fetched_in_two_ranges() {
    let (memory, head, _) = encoded_image(&expected_archive());
    let layout = plan_dylink_archive(&expected_archive()).expect("plans");

    let mut walk = ArchiveWalk::new(head, POINTER_WIDTH, MEMORY_BYTES);
    let mut ranges = Vec::new();
    while let Some(range) = walk.next_range() {
        ranges.push(range);
        let (address, length) = range;
        walk.supply(memory[address as usize..(address + length) as usize].to_vec())
            .expect("supply");
    }

    // One range for the header, then a header range plus a remainder range for
    // every record that carries a payload. Every record in this archive does.
    assert_eq!(ranges.len(), 1 + 2 * (layout.sizes.len() - 1));
    // The second range of a record starts where its fixed header ends.
    let first_module = read_u64(&memory, head + 32);
    assert!(ranges.contains(&(first_module, 136)));
    assert_eq!(ranges[2].0, first_module + 136);
}

#[test]
fn an_unpublished_archive_is_not_an_error() {
    // A process that never loaded a shared object publishes no archive. That is
    // an ordinary state, not a malformed image.
    let walk = ArchiveWalk::new(0, POINTER_WIDTH, MEMORY_BYTES);
    assert_eq!(walk.next_range(), None);
    assert_eq!(walk.finish(), Ok(None));
}

#[test]
fn a_chain_that_loops_back_is_rejected_rather_than_walked_forever() {
    let (mut memory, head, _) = encoded_image(&expected_archive());
    let first_module = read_u64(&memory, head + 32);
    // Point the first module's `next` at itself. The header still declares
    // three modules, so a walker without cycle detection would revisit this
    // record until the declared count ran out -- or forever, had the count
    // been larger.
    put_u64(&mut memory, first_module + 8, first_module);

    let mut walk = ArchiveWalk::new(head, POINTER_WIDTH, MEMORY_BYTES);
    assert_eq!(drive(&mut walk, &memory), Err(Errno::EINVAL));
    assert_eq!(walk.next_range(), None);
    assert_eq!(walk.finish(), Err(Errno::EINVAL));
}

#[test]
fn a_chain_longer_than_the_header_declared_is_rejected() {
    let (mut memory, head, _) = encoded_image(&expected_archive());
    // Claim two modules while the chain still links three: the third record's
    // address would otherwise be fetched and silently ignored.
    memory[(head + 24) as usize..(head + 28) as usize].copy_from_slice(&2u32.to_le_bytes());

    let mut walk = ArchiveWalk::new(head, POINTER_WIDTH, MEMORY_BYTES);
    assert_eq!(drive(&mut walk, &memory), Err(Errno::EINVAL));
    assert_eq!(walk.finish(), Err(Errno::EINVAL));
}

#[test]
fn a_declared_count_no_memory_could_hold_is_rejected_before_fetching() {
    let (mut memory, head, _) = encoded_image(&expected_archive());
    memory[(head + 24) as usize..(head + 28) as usize].copy_from_slice(&u32::MAX.to_le_bytes());

    let mut walk = ArchiveWalk::new(head, POINTER_WIDTH, MEMORY_BYTES);
    // The very first supply -- the archive header itself -- is where this is
    // caught, so the host is never asked for four billion records.
    let (address, length) = walk.next_range().expect("header range");
    assert_eq!(
        walk.supply(memory[address as usize..(address + length) as usize].to_vec()),
        Err(Errno::EINVAL)
    );
}

#[test]
fn a_supply_of_the_wrong_length_is_refused() {
    let (_, head, _) = encoded_image(&expected_archive());
    let mut walk = ArchiveWalk::new(head, POINTER_WIDTH, MEMORY_BYTES);
    let (_, length) = walk.next_range().expect("header range");

    assert_eq!(
        walk.supply(vec![0u8; (length + 1) as usize]),
        Err(Errno::EINVAL)
    );
    assert_eq!(
        walk.supply(vec![0u8; (length - 1) as usize]),
        Err(Errno::EINVAL)
    );
    // The question still stands, so a caller that miscounted can answer again.
    assert_eq!(walk.next_range(), Some((head, length)));
}

#[test]
fn finishing_an_incomplete_walk_is_an_error() {
    let (_, head, _) = encoded_image(&expected_archive());
    let walk = ArchiveWalk::new(head, POINTER_WIDTH, MEMORY_BYTES);
    assert_eq!(walk.finish(), Err(Errno::EINVAL));
}

#[test]
fn a_head_outside_the_declared_memory_is_refused_without_a_fetch() {
    let walk = ArchiveWalk::new(MEMORY_BYTES - 8, POINTER_WIDTH, MEMORY_BYTES);
    assert_eq!(walk.next_range(), None);
    assert_eq!(walk.finish(), Err(Errno::EINVAL));
}

#[test]
fn sparse_storage_refuses_a_read_that_straddles_two_blocks() {
    let mut storage = SparseArchive::new(64);
    storage.insert(0, vec![0xaa; 8]);
    storage.insert(8, vec![0xbb; 8]);

    // Each block reads back on its own.
    assert_eq!(storage.slice(0, 8), Ok(&[0xaa; 8][..]));
    assert_eq!(storage.slice(8, 8), Ok(&[0xbb; 8][..]));
    // Adjacency is not contiguity: two blocks are two separate answers from
    // the host, and joining them would hide a caller that supplied a stale or
    // mismatched range.
    assert_eq!(storage.slice(4, 8), Err(Errno::EINVAL));
    // A range no block backs at all, and one past the declared memory.
    assert_eq!(storage.slice(32, 4), Err(Errno::EINVAL));
    assert_eq!(storage.slice(60, 8), Err(Errno::EINVAL));
    assert_eq!(ArchiveBytes::len(&storage), 64);
}
