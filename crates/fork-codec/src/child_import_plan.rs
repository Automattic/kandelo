//! What a fresh child must put in each activation's import object.
//!
//! # Why this is here and not in the host
//!
//! The host's job at child instantiation is to build a JavaScript import
//! object. That is genuinely a host act -- an import object is a JS object and
//! its members are `WebAssembly.Global` and `WebAssembly.Table` values. What was
//! NOT a host act, and what the 468-line TypeScript planner did anyway, is
//! deciding what goes in it: matching each `KFIG`/`KFIT` declaration to the
//! binding record the parent sealed, cross-checking their types, looking up the
//! saved snapshot behind a base import, and rejecting the combinations that
//! cannot be reconstructed. Every input to those decisions is a byte image this
//! crate already decodes.
//!
//! So this produces a PLAN: one entry per imported global or table of one
//! activation, each saying which import ordinal it is and exactly one of
//!
//!   - leave the base import alone (optionally with the saved scalar the parent
//!     recorded for it),
//!   - use this plain number, or this 64-bit integer,
//!   - materialize this reference recipe at this type -- the one engine floor,
//!   - read `__wpk_fork_global_N` / `__wpk_fork_table_N` off THAT activation's
//!     instance.
//!
//! The host then does the only remaining irreducible thing: turn five
//! instructions into an import object.
//!
//! # Why the plan carries a space
//!
//! `kind` numbering OVERLAPS between the two spaces --
//! `IMPORTED_GLOBAL_BINDING_RAW_NUMBER` and `IMPORTED_TABLE_BINDING_`
//! `ACTIVATION_TABLE` are both 1 -- exactly as the module's imported-section
//! seed found when it stored both spaces. A reader that looks at `kind` without `space` is reading a different
//! record than the writer wrote, so `space` travels with every entry rather
//! than being implied by where the entry came from.

extern crate alloc;

use alloc::vec::Vec;

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use crate::imported_globals::ImportedGlobals;
use crate::imported_tables::ImportedTables;
use crate::module_state_records::{
    GlobalSnapshot, ImportedGlobalBinding, ImportedTableBinding,
};

/// Import space of a plan entry: globals or tables. Same numbering as the
/// fork module's `IMPORT_SPACE_*` and `fm_set_import_provenance`, deliberately.
pub const IMPORT_SPACE_GLOBAL: u8 = 0;
/// See [`IMPORT_SPACE_GLOBAL`].
pub const IMPORT_SPACE_TABLE: u8 = 1;

/// `flags` bit: `bits` carries the parent's saved value for this base import.
///
/// Only ever set on an unshared, mutable `i32`/`i64` base import that the parent
/// snapshotted. Those are the dylink GOT cells: the loader allocates the fresh
/// `Global` wrapper itself, so the child must not override the import, but the
/// saved contents are still the parent's and still authoritative.
pub const IMPORT_PLAN_FLAG_SAVED: u8 = 1;

/// One import of one child activation, and what to do about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportPlanEntry {
    /// Position in the activation's WHOLE import section, which is how
    /// `fork_instrument` numbered it. That is what lets the host find the
    /// matching `(module, name)` without this crate carrying names.
    pub import_ordinal: u32,
    pub space: u8,
    /// A `WPK_FORK_IMPORTED_{GLOBAL,TABLE}_BINDING_*` kind, read under `space`.
    pub kind: u8,
    /// The declared value type (globals) or element type (tables).
    pub type_code: u8,
    pub flags: u8,
    /// Raw bits for `RAW_NUMBER`/`RAW_BIGINT`, the recipe id for
    /// `RAW_REFERENCE`, the saved value when [`IMPORT_PLAN_FLAG_SAVED`] is set,
    /// and 0 otherwise.
    pub bits: u64,
    pub source_activation: u32,
    pub source_owner: u32,
}

/// One `MutableGlobal` snapshot, with the coordinate it was recorded under.
pub struct PlanSnapshot<'a> {
    pub activation: u32,
    pub owner: u32,
    pub snapshot: &'a GlobalSnapshot,
}

fn is_reference_type(type_code: u8) -> bool {
    type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
        || type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF
        || type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
        || type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF
}

/// Build one activation's import plan, in import-ordinal order.
///
/// `globals` and `tables` are that activation's own `KFIG`/`KFIT` sections;
/// `global_bindings` and `table_bindings` are the whole inherited arena's
/// binding records, filtered here by consumer activation; `snapshots` are the
/// arena's `MutableGlobal` records.
///
/// Refuses, rather than producing a partial plan, when:
///
///   - a declaration has no binding, or a binding names a declaration that does
///     not exist (either way the child would bind an import from coordinates
///     describing nothing);
///   - a binding's type disagrees with the declaration's;
///   - a `RAW_REFERENCE` binding sits on a non-reference type, or a non-null
///     `exnref` claims raw provenance -- an `exnref` has no carrier, so a
///     non-zero recipe there is impossible rather than merely unsupported;
///   - two entries claim the same import ordinal.
pub fn build_child_import_plan(
    activation: u32,
    globals: &ImportedGlobals,
    tables: &ImportedTables,
    global_bindings: &[ImportedGlobalBinding],
    table_bindings: &[ImportedTableBinding],
    snapshots: &[PlanSnapshot<'_>],
) -> Result<Vec<ImportPlanEntry>, Errno> {
    let mut out: Vec<ImportPlanEntry> = Vec::new();

    for declaration in &globals.globals {
        let binding = global_bindings
            .iter()
            .find(|b| {
                b.consumer_activation == activation && b.consumer_owner == declaration.owner_id
            })
            .ok_or(Errno::EINVAL)?;
        if binding.type_code != declaration.type_code {
            return Err(Errno::EINVAL); // the binding describes another global
        }
        let mut entry = ImportPlanEntry {
            import_ordinal: declaration.import_ordinal,
            space: IMPORT_SPACE_GLOBAL,
            kind: binding.kind,
            type_code: declaration.type_code,
            flags: 0,
            bits: 0,
            source_activation: binding.source_activation,
            source_owner: binding.source_owner,
        };
        match binding.kind {
            abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER
            | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT => {
                entry.bits = binding.raw_bits;
            }
            abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE => {
                if !is_reference_type(declaration.type_code) {
                    return Err(Errno::EINVAL);
                }
                if declaration.type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
                    && binding.recipe_id != 0
                {
                    return Err(Errno::EINVAL); // non-null exnref with no carrier
                }
                entry.bits = u64::from(binding.recipe_id);
            }
            abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL => {}
            abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT => {
                // The saved scalar, when this is the shape that has one. An
                // absent snapshot is NOT an error: only the mutable unshared
                // integer imports are snapshotted, and the flag is how the host
                // tells "no saved value" from "saved value zero".
                if declaration.mutable
                    && !declaration.shared
                    && (declaration.type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32
                        || declaration.type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64)
                {
                    if let Some(found) = snapshots.iter().find(|s| {
                        s.activation == activation && s.owner == declaration.owner_id
                    }) {
                        if found.snapshot.type_code != declaration.type_code {
                            return Err(Errno::EINVAL); // snapshot is another type
                        }
                        entry.bits = scalar_bits(&found.snapshot.value)?;
                        entry.flags |= IMPORT_PLAN_FLAG_SAVED;
                    }
                }
            }
            _ => return Err(Errno::EINVAL),
        }
        out.push(entry);
    }

    for declaration in &tables.tables {
        let binding = table_bindings
            .iter()
            .find(|b| {
                b.consumer_activation == activation && b.consumer_owner == declaration.owner_id
            })
            .ok_or(Errno::EINVAL)?;
        match binding.kind {
            abi::WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE
            | abi::WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT => {}
            _ => return Err(Errno::EINVAL),
        }
        out.push(ImportPlanEntry {
            import_ordinal: declaration.import_ordinal,
            space: IMPORT_SPACE_TABLE,
            kind: binding.kind,
            type_code: declaration.type_code,
            flags: 0,
            bits: 0,
            source_activation: binding.source_activation,
            source_owner: binding.source_owner,
        });
    }

    // Every binding this activation owns must have been claimed by a
    // declaration, or the arena describes imports this module does not have --
    // which means the child and the parent disagree about what it imports.
    let claimed_globals = out
        .iter()
        .filter(|e| e.space == IMPORT_SPACE_GLOBAL)
        .count();
    let claimed_tables = out.len() - claimed_globals;
    if global_bindings
        .iter()
        .filter(|b| b.consumer_activation == activation)
        .count()
        != claimed_globals
        || table_bindings
            .iter()
            .filter(|b| b.consumer_activation == activation)
            .count()
            != claimed_tables
    {
        return Err(Errno::EINVAL);
    }

    out.sort_by_key(|e| e.import_ordinal);
    if out.windows(2).any(|w| w[0].import_ordinal == w[1].import_ordinal) {
        return Err(Errno::EINVAL); // two imports claim one ordinal
    }
    require_saved_duplicates_agree(globals, &out)?;
    Ok(out)
}

/// Duplicate `(module, name)` base imports must carry one saved value.
///
/// The dylink loader allocates ONE cell for a name however many times the
/// module imports it, so every duplicate is an alias of that cell and the
/// parent can only have saved one value for it. Two different saved values
/// mean the arena disagrees with itself; the loader would get whichever it
/// asked about first. This was the host's `savedMutableGlobalImport` check.
fn require_saved_duplicates_agree(
    globals: &ImportedGlobals,
    plan: &[ImportPlanEntry],
) -> Result<(), Errno> {
    let mut saved: Vec<(&str, &str, u64)> = Vec::new();
    for declaration in &globals.globals {
        let entry = plan
            .binary_search_by_key(&declaration.import_ordinal, |e| e.import_ordinal)
            .map(|at| &plan[at])
            .map_err(|_| Errno::EINVAL)?;
        if entry.space == IMPORT_SPACE_GLOBAL && entry.flags & IMPORT_PLAN_FLAG_SAVED != 0 {
            saved.push((&declaration.module, &declaration.name, entry.bits));
        }
    }
    saved.sort_unstable();
    if saved
        .windows(2)
        .any(|w| (w[0].0, w[0].1) == (w[1].0, w[1].1) && w[0].2 != w[1].2)
    {
        return Err(Errno::EINVAL);
    }
    Ok(())
}

/// The little-endian bits of a 4- or 8-byte snapshot value.
fn scalar_bits(value: &[u8]) -> Result<u64, Errno> {
    match value.len() {
        4 => Ok(u64::from(u32::from_le_bytes([
            value[0], value[1], value[2], value[3],
        ]))),
        8 => Ok(u64::from_le_bytes([
            value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7],
        ])),
        _ => Err(Errno::EINVAL),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imported_globals::ImportedGlobal;
    use crate::imported_tables::ImportedTable;
    use alloc::string::String;
    use alloc::vec;

    const I32: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32;
    const EXTERNREF: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF;
    const EXNREF: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF;
    const FUNCREF: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF;
    const RAW_NUMBER: u8 = abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER;
    const RAW_REFERENCE: u8 = abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE;
    const ACTIVATION_GLOBAL: u8 = abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL;
    const BASE_IMPORT: u8 = abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT;
    const ACTIVATION_TABLE: u8 = abi::WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE;

    fn global(owner: u32, ordinal: u32, type_code: u8, mutable: bool) -> ImportedGlobal {
        ImportedGlobal {
            module: String::from("env"),
            name: String::from("g"),
            import_ordinal: ordinal,
            owner_id: owner,
            type_code,
            mutable,
            shared: false,
        }
    }

    fn table(owner: u32, ordinal: u32) -> ImportedTable {
        ImportedTable {
            module: String::from("env"),
            name: String::from("t"),
            import_ordinal: ordinal,
            owner_id: owner,
            type_code: FUNCREF,
            table64: false,
        }
    }

    fn binding(owner: u32, kind: u8, type_code: u8) -> ImportedGlobalBinding {
        ImportedGlobalBinding {
            consumer_activation: 1,
            consumer_owner: owner,
            source_activation: 0,
            source_owner: 0,
            recipe_id: 0,
            raw_bits: 0,
            kind,
            flags: 0,
            type_code,
        }
    }

    fn table_binding(owner: u32, kind: u8) -> ImportedTableBinding {
        ImportedTableBinding {
            consumer_activation: 1,
            consumer_owner: owner,
            source_activation: 0,
            source_owner: 0,
            kind,
        }
    }

    fn snapshot(type_code: u8, value: vec::Vec<u8>) -> GlobalSnapshot {
        GlobalSnapshot {
            type_code,
            value,
            recipe_id: None,
        }
    }

    fn build(
        globals: vec::Vec<ImportedGlobal>,
        tables: vec::Vec<ImportedTable>,
        gb: vec::Vec<ImportedGlobalBinding>,
        tb: vec::Vec<ImportedTableBinding>,
        snaps: &[PlanSnapshot<'_>],
    ) -> Result<vec::Vec<ImportPlanEntry>, Errno> {
        build_child_import_plan(
            1,
            &ImportedGlobals { globals },
            &ImportedTables { tables },
            &gb,
            &tb,
            snaps,
        )
    }

    #[test]
    fn plans_each_declaration_in_import_ordinal_order() {
        // Tables and globals interleave in the import section, and the plan is
        // ordered by the ordinal rather than by space -- the host walks one
        // list against `WebAssembly.Module.imports()`.
        let mut raw = binding(7, RAW_NUMBER, I32);
        raw.raw_bits = 0x4059_0000_0000_0000; // 100.0 as f64 bits
        let mut provider = binding(8, ACTIVATION_GLOBAL, I32);
        provider.source_activation = 0;
        provider.source_owner = 3;
        let mut tb = table_binding(9, ACTIVATION_TABLE);
        tb.source_activation = 0;
        tb.source_owner = 4;
        let plan = build(
            vec![global(7, 2, I32, false), global(8, 0, I32, false)],
            vec![table(9, 1)],
            vec![raw, provider],
            vec![tb],
            &[],
        )
        .unwrap();
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0].import_ordinal, 0);
        assert_eq!(plan[0].kind, ACTIVATION_GLOBAL);
        assert_eq!(plan[0].source_owner, 3);
        assert_eq!(plan[1].import_ordinal, 1);
        assert_eq!(plan[1].space, IMPORT_SPACE_TABLE);
        assert_eq!(plan[1].source_owner, 4);
        assert_eq!(plan[2].import_ordinal, 2);
        assert_eq!(plan[2].bits, 0x4059_0000_0000_0000);
    }

    #[test]
    fn carries_the_saved_scalar_of_a_mutable_base_import() {
        let saved = snapshot(I32, vec![0x2a, 0, 0, 0]);
        let plan = build(
            vec![global(7, 0, I32, true)],
            vec![],
            vec![binding(7, BASE_IMPORT, I32)],
            vec![],
            &[PlanSnapshot {
                activation: 1,
                owner: 7,
                snapshot: &saved,
            }],
        )
        .unwrap();
        assert_eq!(plan[0].flags & IMPORT_PLAN_FLAG_SAVED, IMPORT_PLAN_FLAG_SAVED);
        assert_eq!(plan[0].bits, 42);
    }

    #[test]
    fn an_immutable_base_import_carries_no_saved_value() {
        // The flag, not the value, is what says "there is a saved scalar" --
        // otherwise a genuinely saved zero is indistinguishable from none.
        let saved = snapshot(I32, vec![0, 0, 0, 0]);
        let plan = build(
            vec![global(7, 0, I32, false)],
            vec![],
            vec![binding(7, BASE_IMPORT, I32)],
            vec![],
            &[PlanSnapshot {
                activation: 1,
                owner: 7,
                snapshot: &saved,
            }],
        )
        .unwrap();
        assert_eq!(plan[0].flags & IMPORT_PLAN_FLAG_SAVED, 0);
        assert_eq!(plan[0].bits, 0);
    }

    #[test]
    fn refuses_a_declaration_with_no_binding() {
        assert_eq!(
            build(vec![global(7, 0, I32, false)], vec![], vec![], vec![], &[]),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn refuses_a_binding_no_declaration_claims() {
        assert_eq!(
            build(
                vec![global(7, 0, I32, false)],
                vec![],
                vec![binding(7, RAW_NUMBER, I32), binding(8, RAW_NUMBER, I32)],
                vec![],
                &[],
            ),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn refuses_a_binding_whose_type_disagrees_with_the_declaration() {
        assert_eq!(
            build(
                vec![global(7, 0, I32, false)],
                vec![],
                vec![binding(7, RAW_NUMBER, EXTERNREF)],
                vec![],
                &[],
            ),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn refuses_raw_reference_provenance_on_a_scalar() {
        assert_eq!(
            build(
                vec![global(7, 0, I32, false)],
                vec![],
                vec![binding(7, RAW_REFERENCE, I32)],
                vec![],
                &[],
            ),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn refuses_a_non_null_exnref_claiming_raw_provenance() {
        // An `exnref` has no carrier, so a non-zero recipe here is impossible
        // rather than unsupported.
        let mut b = binding(7, RAW_REFERENCE, EXNREF);
        b.recipe_id = 5;
        assert_eq!(
            build(vec![global(7, 0, EXNREF, false)], vec![], vec![b], vec![], &[]),
            Err(Errno::EINVAL)
        );
        let null = binding(7, RAW_REFERENCE, EXNREF);
        assert!(build(vec![global(7, 0, EXNREF, false)], vec![], vec![null], vec![], &[]).is_ok());
    }

    #[test]
    fn refuses_an_undefined_kind_in_either_space() {
        assert_eq!(
            build(
                vec![global(7, 0, I32, false)],
                vec![],
                vec![binding(7, 99, I32)],
                vec![],
                &[],
            ),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            build(vec![], vec![table(9, 0)], vec![], vec![table_binding(9, 99)], &[]),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn refuses_two_imports_claiming_one_ordinal() {
        // A global and a table at the same ordinal: the host resolves by
        // ordinal, so this would silently bind one of them to the other's slot.
        assert_eq!(
            build(
                vec![global(7, 0, I32, false)],
                vec![table(9, 0)],
                vec![binding(7, RAW_NUMBER, I32)],
                vec![table_binding(9, ACTIVATION_TABLE)],
                &[],
            ),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn refuses_duplicate_base_imports_whose_saved_values_disagree() {
        // Two imports of one `(module, name)` alias one loader cell, so the
        // parent saved one value for it. Agreeing duplicates plan; a conflict
        // is the arena disagreeing with itself.
        let plan_with = |second: u8| {
            let first = snapshot(I32, vec![42, 0, 0, 0]);
            let other = snapshot(I32, vec![second, 0, 0, 0]);
            build(
                vec![global(7, 0, I32, true), global(8, 1, I32, true)],
                vec![],
                vec![binding(7, BASE_IMPORT, I32), binding(8, BASE_IMPORT, I32)],
                vec![],
                &[
                    PlanSnapshot { activation: 1, owner: 7, snapshot: &first },
                    PlanSnapshot { activation: 1, owner: 8, snapshot: &other },
                ],
            )
        };
        assert_eq!(plan_with(42).map(|p| p.len()), Ok(2));
        assert_eq!(plan_with(43), Err(Errno::EINVAL));
    }

    #[test]
    fn refuses_a_saved_snapshot_of_the_wrong_type() {
        let saved = snapshot(EXTERNREF, vec![0, 0, 0, 0]);
        assert_eq!(
            build(
                vec![global(7, 0, I32, true)],
                vec![],
                vec![binding(7, BASE_IMPORT, I32)],
                vec![],
                &[PlanSnapshot {
                    activation: 1,
                    owner: 7,
                    snapshot: &saved,
                }],
            ),
            Err(Errno::EINVAL)
        );
    }
}
