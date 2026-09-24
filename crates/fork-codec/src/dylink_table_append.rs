//! Appending ONE table patch to a published dylink archive.
//!
//! [`crate::dylink_archive_encode`] lays out a whole archive image: it wants an
//! address for every record and resolves every `next` pointer and header cursor
//! from them. That is the right shape for publishing an archive, and the wrong
//! shape for adding one patch to an archive that already exists -- doing it
//! that way would relocate every record, which means copying every side-module
//! image on every `table.set`.
//!
//! So this computes the small write set an append actually needs: the new
//! record, the previous tail's `next` pointer, the header cursors that move,
//! and the generation to publish afterwards.
//!
//! # Ordering is part of the contract
//!
//! [`DylinkTablePatchAppend::generation`] is published LAST, separately, and
//! this module does not put it in `writes` for exactly that reason. A reader
//! that saw a newer generation before the record it describes had landed would
//! follow a `next` pointer into uninitialized memory. `crates/dylink`'s
//! publisher splits its header write around the generation fence for the same
//! reason; this keeps that discipline for the incremental path.

use alloc::vec::Vec;

use wasm_posix_shared::Errno;

use super::encode::DylinkArchiveRecord;
use super::{DylinkArchive, DylinkTablePatch};

/// Byte offsets of the header fields an append moves. Derived from the header
/// `dylink_archive_encode` writes, in its own field order.
const HEADER_GENERATION_OFFSET: u64 = 40;
const HEADER_FIRST_PATCH_OFFSET: u64 = 56;
const HEADER_LAST_PATCH_OFFSET: u64 = 64;
const HEADER_PATCH_COUNT_OFFSET: u64 = 72;
const HEADER_PATCH_BYTES_OFFSET: u64 = 76;

/// Offset of a KFJP record's `next` pointer, after magic/version/header-size.
const PATCH_NEXT_OFFSET: u64 = 8;

/// The declared ceilings the decoder enforces, re-checked here so an append can
/// never build an archive the decoder would later refuse.
const MAX_TABLE_PATCH_RECORDS: u32 = 256;
const MAX_TABLE_PATCH_BYTES: u32 = 1024 * 1024;

/// Everything one appended patch must write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DylinkTablePatchAppend {
    /// The record images to write, in order. Every one must land before
    /// `generation` is published.
    pub writes: Vec<DylinkArchiveRecord>,
    /// The generation to store at `generation_address` AFTER every write in
    /// `writes` has landed. Never included in `writes`: see the module docs.
    pub generation: u64,
    /// Absolute address of the header's generation fence.
    pub generation_address: u64,
}

/// Plan the append of `patch` to the archive rooted at `head`.
///
/// `archive` is the DECODED current image and `tail_address` is the address of
/// its last table-patch record, or `None` when it has none. The caller supplies
/// `record_address`: storage for exactly [`appended_record_size`] bytes.
///
/// The patch's generation must be newer than the archive's, because a
/// generation that did not advance is a patch no peer would ever apply.
pub fn plan_table_patch_append(
    archive: &DylinkArchive,
    head: u64,
    tail_address: Option<u64>,
    record_address: u64,
    patch: &DylinkTablePatch,
) -> Result<DylinkTablePatchAppend, Errno> {
    if head == 0 || record_address == 0 {
        return Err(Errno::EINVAL);
    }
    if patch.generation <= archive.generation {
        return Err(Errno::EINVAL);
    }
    // `tail_address` and the decoded patch list have to agree, or the caller is
    // describing an archive this one is not.
    match (tail_address, archive.table_patches.is_empty()) {
        (None, true) | (Some(_), false) => {}
        _ => return Err(Errno::EINVAL),
    }

    let size = appended_record_size(patch)?;
    let count = u32::try_from(archive.table_patches.len())
        .map_err(|_| Errno::EINVAL)?
        .checked_add(1)
        .ok_or(Errno::EINVAL)?;
    if count > MAX_TABLE_PATCH_RECORDS {
        return Err(Errno::EINVAL);
    }
    let mut bytes = 0u64;
    for existing in &archive.table_patches {
        bytes = bytes
            .checked_add(appended_record_size(existing)?)
            .ok_or(Errno::EINVAL)?;
    }
    let bytes = bytes.checked_add(size).ok_or(Errno::EINVAL)?;
    if bytes > u64::from(MAX_TABLE_PATCH_BYTES) {
        return Err(Errno::EINVAL);
    }

    let mut writes = Vec::new();
    writes.push(DylinkArchiveRecord {
        address: record_address,
        bytes: encode_patch_record(patch, size)?,
    });
    match tail_address {
        // Link the new record onto the chain. This is written BEFORE the header
        // cursors move, so a reader walking from `first_patch` reaches the new
        // record only once the record itself is there.
        Some(tail) => writes.push(DylinkArchiveRecord {
            address: tail
                .checked_add(PATCH_NEXT_OFFSET)
                .ok_or(Errno::EINVAL)?,
            bytes: record_address.to_le_bytes().to_vec(),
        }),
        // First patch in the archive: the chain starts at the new record.
        None => writes.push(DylinkArchiveRecord {
            address: header_field(head, HEADER_FIRST_PATCH_OFFSET)?,
            bytes: record_address.to_le_bytes().to_vec(),
        }),
    }
    writes.push(DylinkArchiveRecord {
        address: header_field(head, HEADER_LAST_PATCH_OFFSET)?,
        bytes: record_address.to_le_bytes().to_vec(),
    });
    writes.push(DylinkArchiveRecord {
        address: header_field(head, HEADER_PATCH_COUNT_OFFSET)?,
        bytes: count.to_le_bytes().to_vec(),
    });
    writes.push(DylinkArchiveRecord {
        address: header_field(head, HEADER_PATCH_BYTES_OFFSET)?,
        bytes: u32::try_from(bytes)
            .map_err(|_| Errno::EINVAL)?
            .to_le_bytes()
            .to_vec(),
    });

    Ok(DylinkTablePatchAppend {
        writes,
        generation: patch.generation,
        generation_address: header_field(head, HEADER_GENERATION_OFFSET)?,
    })
}

/// Bytes one patch record occupies, header plus one entry per run.
pub fn appended_record_size(patch: &DylinkTablePatch) -> Result<u64, Errno> {
    let runs = u64::try_from(patch.runs.len()).map_err(|_| Errno::EINVAL)?;
    runs.checked_mul(TABLE_PATCH_RUN_SIZE)
        .and_then(|payload| payload.checked_add(TABLE_PATCH_HEADER_SIZE))
        .ok_or(Errno::EINVAL)
}

const TABLE_PATCH_HEADER_SIZE: u64 = 64;
const TABLE_PATCH_RUN_SIZE: u64 = 24;
const TABLE_PATCH_MAGIC: u32 = 0x504a_464b; // "KFJP"
const TABLE_PATCH_VERSION: u16 = 1;

fn header_field(head: u64, offset: u64) -> Result<u64, Errno> {
    head.checked_add(offset).ok_or(Errno::EINVAL)
}

fn encode_patch_record(patch: &DylinkTablePatch, size: u64) -> Result<Vec<u8>, Errno> {
    let mut out = Vec::with_capacity(size as usize);
    out.extend_from_slice(&TABLE_PATCH_MAGIC.to_le_bytes());
    out.extend_from_slice(&TABLE_PATCH_VERSION.to_le_bytes());
    out.extend_from_slice(&(TABLE_PATCH_HEADER_SIZE as u16).to_le_bytes());
    // A newly appended record is always the tail, so its `next` is null.
    out.extend_from_slice(&0u64.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&patch.generation.to_le_bytes());
    out.extend_from_slice(&patch.activation_id.to_le_bytes());
    out.extend_from_slice(&patch.owner_id.to_le_bytes());
    out.extend_from_slice(&patch.start.to_le_bytes());
    out.extend_from_slice(&patch.table_length.to_le_bytes());
    out.extend_from_slice(
        &u32::try_from(patch.runs.len())
            .map_err(|_| Errno::EINVAL)?
            .to_le_bytes(),
    );
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved
    debug_assert_eq!(out.len() as u64, TABLE_PATCH_HEADER_SIZE);
    for run in &patch.runs {
        out.extend_from_slice(&run.length.to_le_bytes());
        match run.function {
            Some(function) => {
                out.extend_from_slice(&1u32.to_le_bytes());
                out.extend_from_slice(&function.activation_id.to_le_bytes());
                out.extend_from_slice(&function.ordinal.to_le_bytes());
            }
            None => {
                out.extend_from_slice(&0u32.to_le_bytes());
                out.extend_from_slice(&0u32.to_le_bytes());
                out.extend_from_slice(&0u32.to_le_bytes());
            }
        }
        out.extend_from_slice(&0u32.to_le_bytes()); // reserved
    }
    if out.len() as u64 != size {
        return Err(Errno::EINVAL);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{decode_dylink_archive, DylinkTableFunction, DylinkTablePatchRun};
    use alloc::vec;

    const TS_FIXTURE: &[u8] = include_bytes!("../testdata/dylink-archive-wasm32.bin");
    const FIXTURE_HEAD: u64 = 4096;
    const FIXTURE_MEMORY_BYTES: usize = 262_144;
    const FIXTURE_PW: u8 = 4;
    /// Free space well past the fixture's own records.
    const SCRATCH: u64 = 128 * 1024;

    fn fixture_memory() -> Vec<u8> {
        let mut mem = TS_FIXTURE.to_vec();
        mem.resize(FIXTURE_MEMORY_BYTES, 0);
        mem
    }

    fn apply(mem: &mut [u8], writes: &[DylinkArchiveRecord]) {
        for write in writes {
            let start = write.address as usize;
            mem[start..start + write.bytes.len()].copy_from_slice(&write.bytes);
        }
    }

    fn new_patch(generation: u64, owner_id: u32) -> DylinkTablePatch {
        DylinkTablePatch {
            generation,
            activation_id: 1,
            owner_id,
            start: 9,
            table_length: 64,
            runs: vec![DylinkTablePatchRun {
                length: 2,
                function: Some(DylinkTableFunction { activation_id: 1, ordinal: 5 }),
            }],
        }
    }

    /// The tail address of the fixture's patch chain, found by walking it.
    ///
    /// Derived rather than hardcoded: a hardcoded address would still "work"
    /// against a regenerated fixture while linking the new record onto nothing.
    fn fixture_tail(mem: &[u8]) -> Option<u64> {
        let first = u64::from_le_bytes(
            mem[(FIXTURE_HEAD + HEADER_FIRST_PATCH_OFFSET) as usize..][..8]
                .try_into()
                .unwrap(),
        );
        if first == 0 {
            return None;
        }
        let mut at = first;
        loop {
            let next = u64::from_le_bytes(
                mem[(at + PATCH_NEXT_OFFSET) as usize..][..8].try_into().unwrap(),
            );
            if next == 0 {
                return Some(at);
            }
            at = next;
        }
    }

    #[test]
    fn an_appended_patch_decodes_back_out_of_the_real_archive() {
        let mut mem = fixture_memory();
        let before = decode_dylink_archive(&mem, FIXTURE_HEAD, FIXTURE_PW).unwrap();
        let tail = fixture_tail(&mem);
        // Without this the test would pass vacuously on a fixture with no
        // patches, where appending the FIRST patch takes a different branch.
        assert!(tail.is_some(), "the fixture must already carry a patch chain");

        let patch = new_patch(before.generation + 1, 3);
        let plan =
            plan_table_patch_append(&before, FIXTURE_HEAD, tail, SCRATCH, &patch).unwrap();
        apply(&mut mem, &plan.writes);
        // The generation is published separately, after every write lands.
        mem[plan.generation_address as usize..][..8]
            .copy_from_slice(&plan.generation.to_le_bytes());

        let after = decode_dylink_archive(&mem, FIXTURE_HEAD, FIXTURE_PW)
            .expect("an appended archive still decodes");
        assert_eq!(after.table_patches.len(), before.table_patches.len() + 1);
        assert_eq!(after.table_patches.last(), Some(&patch));
        assert_eq!(after.generation, patch.generation);
        // Everything that was there is still there, unmoved.
        assert_eq!(
            &after.table_patches[..before.table_patches.len()],
            &before.table_patches[..],
        );
        assert_eq!(after.modules, before.modules);
    }

    #[test]
    fn the_appended_patch_is_what_a_reconcile_then_plans() {
        let mut mem = fixture_memory();
        let before = decode_dylink_archive(&mem, FIXTURE_HEAD, FIXTURE_PW).unwrap();
        let patch = new_patch(before.generation + 1, 3);
        let plan = plan_table_patch_append(
            &before,
            FIXTURE_HEAD,
            fixture_tail(&mem),
            SCRATCH,
            &patch,
        )
        .unwrap();
        apply(&mut mem, &plan.writes);
        mem[plan.generation_address as usize..][..8]
            .copy_from_slice(&plan.generation.to_le_bytes());

        let after = decode_dylink_archive(&mem, FIXTURE_HEAD, FIXTURE_PW).unwrap();
        // A peer already at the OLD generation must now be told to write
        // exactly the slots this patch describes, and nothing else.
        let plans =
            crate::dylink_table_plan::plan_table_patches(&after.table_patches, before.generation)
                .unwrap();
        assert_eq!(plans.len(), 1, "exactly the appended patch is new");
        assert_eq!(plans[0].owner_id, patch.owner_id);
        let steps = &plans[0].steps;
        assert_eq!(
            steps.len(),
            patch.runs.iter().map(|r| r.length as usize).sum::<usize>(),
            "the append is visible to the planner as its own runs",
        );
        assert!(steps.iter().all(|s| s.dest >= patch.start as u32));
    }

    #[test]
    fn a_generation_that_does_not_advance_is_refused() {
        let mem = fixture_memory();
        let archive = decode_dylink_archive(&mem, FIXTURE_HEAD, FIXTURE_PW).unwrap();
        // Equal, not just older: republishing the current generation would be
        // a patch every peer decides it has already applied.
        let patch = new_patch(archive.generation, 3);
        assert_eq!(
            plan_table_patch_append(&archive, FIXTURE_HEAD, fixture_tail(&mem), SCRATCH, &patch),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn a_tail_that_disagrees_with_the_decoded_chain_is_refused() {
        let mem = fixture_memory();
        let archive = decode_dylink_archive(&mem, FIXTURE_HEAD, FIXTURE_PW).unwrap();
        let patch = new_patch(archive.generation + 1, 3);
        // Saying "no tail" about an archive that HAS patches would link the new
        // record onto the header's first-patch cursor and orphan the existing
        // chain -- a silent loss, not an error, if this were not checked.
        assert_eq!(
            plan_table_patch_append(&archive, FIXTURE_HEAD, None, SCRATCH, &patch),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn the_generation_is_never_one_of_the_writes() {
        let mem = fixture_memory();
        let archive = decode_dylink_archive(&mem, FIXTURE_HEAD, FIXTURE_PW).unwrap();
        let patch = new_patch(archive.generation + 1, 3);
        let plan =
            plan_table_patch_append(&archive, FIXTURE_HEAD, fixture_tail(&mem), SCRATCH, &patch)
                .unwrap();
        // The fence must be published by the caller AFTER the writes. If it
        // ever appeared in `writes`, a caller applying them in order would
        // publish a generation whose record had not landed yet.
        assert!(
            plan.writes.iter().all(|w| w.address != plan.generation_address),
            "the generation fence is not part of the write set",
        );
    }
}
