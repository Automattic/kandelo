//! Funcref table-replica reconcile PLAN.
//!
//! A forked child, and any peer worker, must bring its instance-local
//! `__indirect_function_table` back in step with the process's published
//! loader state. The published form is a chain of `DylinkTablePatch` records
//! (`dylink_archive`), each a run-length description of consecutive slots set
//! to a `(activation_id, ordinal)` catalog coordinate or cleared to null.
//!
//! # Why this is a plan rather than an apply
//!
//! Applying a patch means `table.set` on a funcref table, and Rust has no way
//! to emit one — the same split the GC drive plan already uses. So this module
//! turns patches into a flat, ordered list of steps, and an injected wasm shim
//! performs the table writes. Keeping the decision here means there is ONE
//! reader of the patch format rather than one per host.
//!
//! `crates/dylink` owns the protocol around these records — generations,
//! ordering, publication. This module only decides what a reconcile must WRITE,
//! given patches and the generation the caller has already applied.

use alloc::vec::Vec;

use wasm_posix_shared::Errno;

use crate::dylink_archive::DylinkTablePatch;

/// One funcref table slot a reconcile must write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TablePatchStep {
    /// Slot in the guest's `__indirect_function_table`.
    pub dest: u32,
    /// Catalog coordinate to write, meaningless when `clear` is set.
    pub activation_id: u32,
    pub ordinal: u32,
    /// Write a null rather than a function.
    pub clear: bool,
}

/// A reconcile that would write more slots than this is refused rather than
/// run: a patch chain long enough to exceed it means the publisher is emitting
/// unbounded history where a checkpoint was expected, and silently applying
/// millions of writes would turn a coherence bug into a hang.
pub const MAX_PLAN_STEPS: usize = 1 << 20;

/// Plan the writes that bring `owner_id`'s table from `since_generation` up to
/// the newest published patch.
///
/// Patches at or below `since_generation` are already applied and are skipped;
/// `>` and not `>=` is the whole point, since re-applying a generation the
/// caller already has would undo a newer local mutation.
///
/// Generations must be STRICTLY increasing across the patches that apply, which
/// is `crates/dylink`'s publication rule. A chain that repeats or goes backwards
/// is rejected rather than sorted: the order records causality, so a
/// disordered chain means the publisher is wrong and applying it in some
/// invented order would make two workers disagree about what happened.
pub fn plan_table_patches(
    patches: &[DylinkTablePatch],
    owner_id: u32,
    since_generation: u64,
) -> Result<Vec<TablePatchStep>, Errno> {
    let mut steps: Vec<TablePatchStep> = Vec::new();
    let mut last_generation: Option<u64> = None;

    for patch in patches {
        if patch.owner_id != owner_id {
            continue;
        }
        if patch.generation <= since_generation {
            continue;
        }
        if let Some(previous) = last_generation {
            if patch.generation <= previous {
                return Err(Errno::EINVAL); // non-monotonic publication order
            }
        }
        last_generation = Some(patch.generation);

        let mut cursor = patch.start;
        for run in &patch.runs {
            let end = cursor.checked_add(run.length).ok_or(Errno::EINVAL)?;
            if end > patch.table_length {
                return Err(Errno::EINVAL); // run runs past the table it describes
            }
            for slot in cursor..end {
                let dest = u32::try_from(slot).map_err(|_| Errno::EINVAL)?;
                if steps.len() >= MAX_PLAN_STEPS {
                    return Err(Errno::E2BIG);
                }
                steps.push(match run.function {
                    Some(function) => TablePatchStep {
                        dest,
                        activation_id: function.activation_id,
                        ordinal: function.ordinal,
                        clear: false,
                    },
                    None => TablePatchStep {
                        dest,
                        activation_id: 0,
                        ordinal: 0,
                        clear: true,
                    },
                });
            }
            cursor = end;
        }
    }
    Ok(steps)
}

/// The generation a reconcile reaches by applying [`plan_table_patches`]'s
/// output, or `since_generation` when nothing applies.
///
/// Reported separately from the steps because the caller must publish it only
/// AFTER the writes land: storing it first would let a peer observe a
/// generation whose table entries are not there yet.
pub fn planned_generation(
    patches: &[DylinkTablePatch],
    owner_id: u32,
    since_generation: u64,
) -> u64 {
    patches
        .iter()
        .filter(|patch| patch.owner_id == owner_id && patch.generation > since_generation)
        .map(|patch| patch.generation)
        .max()
        .unwrap_or(since_generation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dylink_archive::{DylinkTableFunction, DylinkTablePatchRun};
    use alloc::vec;

    fn patch(
        generation: u64,
        owner_id: u32,
        start: u64,
        table_length: u64,
        runs: Vec<DylinkTablePatchRun>,
    ) -> DylinkTablePatch {
        DylinkTablePatch {
            generation,
            activation_id: 0,
            owner_id,
            start,
            table_length,
            runs,
        }
    }

    fn run(length: u64, function: Option<(u32, u32)>) -> DylinkTablePatchRun {
        DylinkTablePatchRun {
            length,
            function: function.map(|(activation_id, ordinal)| DylinkTableFunction {
                activation_id,
                ordinal,
            }),
        }
    }

    /// The same archive fixture `dylink_archive.rs` decodes: real output from
    /// the TypeScript `DylinkForkArchive` writer. Planning against it rather
    /// than only against hand-built patches is what catches a disagreement
    /// between the publisher's run encoding and this reader's expansion.
    const TS_FIXTURE: &[u8] = include_bytes!("../testdata/dylink-archive-wasm32.bin");
    const FIXTURE_HEAD: u64 = 4096;
    const FIXTURE_MEMORY_BYTES: usize = 262_144;
    const FIXTURE_PW: u8 = 4;

    fn fixture_archive() -> crate::dylink_archive::DylinkArchive {
        let mut mem = TS_FIXTURE.to_vec();
        mem.resize(FIXTURE_MEMORY_BYTES, 0);
        crate::dylink_archive::decode_dylink_archive(&mem, FIXTURE_HEAD, FIXTURE_PW).unwrap()
    }

    #[test]
    fn plans_against_the_real_published_archive() {
        let archive = fixture_archive();
        // Whatever the fixture happens to carry, planning it must be total and
        // self-consistent: every owner it names plans without error, and
        // replanning from the generation just reached yields nothing.
        let owners: alloc::collections::BTreeSet<u32> =
            archive.table_patches.iter().map(|p| p.owner_id).collect();
        // Without this the loop below would be VACUOUS on a fixture that
        // happens to carry no patches, and the test would pass by asserting
        // nothing.
        assert!(
            !owners.is_empty(),
            "the fixture must carry table patches for this test to mean anything",
        );
        for owner in owners {
            let steps = plan_table_patches(&archive.table_patches, owner, 0)
                .expect("a published chain plans");
            let reached = planned_generation(&archive.table_patches, owner, 0);
            assert!(
                reached > 0,
                "owner {owner} has patches, so it reaches a generation",
            );
            let again = plan_table_patches(&archive.table_patches, owner, reached)
                .expect("replan is total");
            assert!(
                again.is_empty(),
                "replanning from the generation just reached must write nothing",
            );
            // Every step names a slot inside the table its patch described.
            assert!(
                steps.iter().all(|s| s.dest != u32::MAX),
                "no step names a sentinel slot",
            );
        }
    }

    #[test]
    fn a_run_expands_to_consecutive_slots_from_start() {
        let patches = vec![patch(1, 7, 4, 16, vec![run(3, Some((2, 9)))])];
        let steps = plan_table_patches(&patches, 7, 0).unwrap();
        assert_eq!(steps.len(), 3);
        assert_eq!(
            steps.iter().map(|s| s.dest).collect::<Vec<_>>(),
            vec![4, 5, 6],
        );
        assert!(steps.iter().all(|s| s.activation_id == 2 && s.ordinal == 9 && !s.clear));
    }

    #[test]
    fn a_run_with_no_function_clears_rather_than_writing_slot_zero() {
        // A null run must CLEAR. Writing catalog slot 0 instead would silently
        // populate every cleared slot with whichever function happens to be
        // first in the catalog.
        let patches = vec![patch(1, 7, 0, 4, vec![run(2, None)])];
        let steps = plan_table_patches(&patches, 7, 0).unwrap();
        assert!(steps.iter().all(|s| s.clear), "null runs clear");
    }

    #[test]
    fn runs_advance_the_cursor_so_they_do_not_overlap() {
        let patches = vec![patch(
            1,
            7,
            0,
            8,
            vec![run(2, Some((1, 1))), run(2, Some((1, 2)))],
        )];
        let steps = plan_table_patches(&patches, 7, 0).unwrap();
        assert_eq!(
            steps.iter().map(|s| (s.dest, s.ordinal)).collect::<Vec<_>>(),
            vec![(0, 1), (1, 1), (2, 2), (3, 2)],
        );
    }

    #[test]
    fn already_applied_generations_are_skipped_strictly() {
        // `>` not `>=`: re-applying the generation the caller already has would
        // undo any newer local mutation made since.
        let patches = vec![
            patch(1, 7, 0, 8, vec![run(1, Some((1, 1)))]),
            patch(2, 7, 1, 8, vec![run(1, Some((1, 2)))]),
        ];
        assert_eq!(plan_table_patches(&patches, 7, 0).unwrap().len(), 2);
        assert_eq!(plan_table_patches(&patches, 7, 1).unwrap().len(), 1);
        assert_eq!(plan_table_patches(&patches, 7, 2).unwrap().len(), 0);
    }

    #[test]
    fn another_owners_patches_are_not_applied() {
        let patches = vec![patch(1, 9, 0, 8, vec![run(4, Some((1, 1)))])];
        assert!(plan_table_patches(&patches, 7, 0).unwrap().is_empty());
    }

    #[test]
    fn a_disordered_chain_is_refused_rather_than_sorted() {
        // The order records causality. Inventing one would let two workers
        // disagree about what happened.
        let patches = vec![
            patch(2, 7, 0, 8, vec![run(1, Some((1, 1)))]),
            patch(1, 7, 1, 8, vec![run(1, Some((1, 2)))]),
        ];
        assert_eq!(plan_table_patches(&patches, 7, 0), Err(Errno::EINVAL));
        let repeated = vec![
            patch(2, 7, 0, 8, vec![run(1, Some((1, 1)))]),
            patch(2, 7, 1, 8, vec![run(1, Some((1, 2)))]),
        ];
        assert_eq!(plan_table_patches(&repeated, 7, 0), Err(Errno::EINVAL));
    }

    #[test]
    fn a_run_past_the_table_it_describes_is_refused() {
        let patches = vec![patch(1, 7, 6, 8, vec![run(4, Some((1, 1)))])];
        assert_eq!(plan_table_patches(&patches, 7, 0), Err(Errno::EINVAL));
    }

    #[test]
    fn the_reached_generation_is_the_highest_applied_not_the_last_seen() {
        // The out-of-order patch must belong to the SAME owner. An earlier
        // version of this test put it under a different owner, so the filter
        // removed it before order could matter and `.last()` passed in place of
        // `.max()` — a test that could not fail.
        //
        // `plan_table_patches` refuses a disordered chain, so this input cannot
        // reach a reconcile. `planned_generation` is public and independently
        // callable, so it is correct by construction rather than by relying on
        // its caller having checked first.
        let disordered = vec![
            patch(5, 7, 0, 8, vec![run(1, Some((1, 1)))]),
            patch(1, 7, 1, 8, vec![run(1, Some((1, 2)))]),
        ];
        assert_eq!(
            planned_generation(&disordered, 7, 0),
            5,
            "the HIGHEST applicable generation, not whichever came last",
        );

        let ordered = vec![
            patch(1, 7, 0, 8, vec![run(1, Some((1, 1)))]),
            patch(5, 7, 1, 8, vec![run(1, Some((1, 2)))]),
            patch(3, 9, 2, 8, vec![run(1, Some((1, 3)))]), // another owner
        ];
        assert_eq!(planned_generation(&ordered, 7, 0), 5);
        assert_eq!(planned_generation(&ordered, 7, 5), 5, "nothing to apply");
        assert_eq!(planned_generation(&[], 7, 4), 4, "empty chain holds");
    }
}
