//! Everything a fresh fork child must know before it instantiates anything.
//!
//! A child rebuilds its activations -- the main module and every `dlopen`ed
//! side module -- as new instances, and each one's import object has to name
//! the values the parent's did. [`crate::child_import_plan`] decides that per
//! activation. This module finishes the job for the whole child, so the host
//! is left with nothing to decide:
//!
//!   - Each import becomes one ROW that says how to produce its value: a raw
//!     number, a null, a slot of some activation's catalog, some activation's
//!     exported global or table, or "keep the base import".
//!   - A raw reference is resolved against the decoded reference graph here,
//!     including the check that the graph's node kind can be imported at the
//!     type the binding declared. The two facts come from different records,
//!     so a mismatch means the arena disagrees with itself.
//!   - The INSTANTIATION ORDER comes from the same rows: an activation that
//!     reads another's export or catalog must be instantiated after it.
//!
//! The host then does what only it can: build JavaScript import objects,
//! `Table.get` a catalog slot, and read an export off a live instance.
//!
//! This replaced the host's `ForkChildReferences` and most of
//! `ForkChildImports` (lane F stage 1G).

extern crate alloc;

use alloc::vec::Vec;

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use crate::child_import_plan::{ImportPlanEntry, IMPORT_PLAN_FLAG_SAVED, IMPORT_SPACE_GLOBAL};
use crate::reference_recipes::ReferenceRecipeNode;

/// The import is a plain number; `a`/`b` are the low/high halves of its f64
/// bits.
pub const CHILD_PLAN_RESOLVE_RAW_F64: u8 = 1;
/// The import is a 64-bit integer; `a`/`b` are its low/high halves.
pub const CHILD_PLAN_RESOLVE_RAW_I64: u8 = 2;
/// The import is a null reference.
pub const CHILD_PLAN_RESOLVE_NULL: u8 = 3;
/// Slot `a` of activation `dep_activation`'s own function catalog.
pub const CHILD_PLAN_RESOLVE_FUNC_CATALOG_SLOT: u8 = 4;
/// Slot `a` of activation `dep_activation`'s own static-root catalog.
pub const CHILD_PLAN_RESOLVE_STATIC_ROOT_SLOT: u8 = 5;
/// Activation `a`'s exported global number `b` (`__wpk_fork_global_<b>`).
pub const CHILD_PLAN_RESOLVE_PROVIDER_GLOBAL: u8 = 6;
/// Activation `a`'s exported table number `b` (`__wpk_fork_table_<b>`).
pub const CHILD_PLAN_RESOLVE_PROVIDER_TABLE: u8 = 7;
/// Keep the base import; the parent saved its scalar, bits `a`/`b` (low/high).
/// Only a mutable, unshared `i32`/`i64` global -- a dylink GOT cell.
pub const CHILD_PLAN_RESOLVE_SAVED_BASE_SCALAR: u8 = 8;
/// Keep the base import; nothing was saved for it.
pub const CHILD_PLAN_RESOLVE_KEEP_BASE: u8 = 9;

/// `dep_activation` when a row depends on no activation.
pub const CHILD_PLAN_NO_ACTIVATION: u32 = u32::MAX;
/// `{activation_count u32, row_count u32, order_ptr u32}`.
pub const CHILD_PLAN_HEADER_BYTES: usize = 12;
/// One encoded [`ChildPlanRow`].
pub const CHILD_PLAN_ROW_BYTES: usize = 24;

/// One import of one child activation, and how to produce its value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChildPlanRow {
    pub activation: u32,
    /// Position in the activation's whole import section.
    pub import_ordinal: u32,
    /// A `CHILD_PLAN_RESOLVE_*`.
    pub resolve: u8,
    /// The declared value type (globals) or element type (tables).
    pub type_code: u8,
    /// The import plan's flags (`IMPORT_PLAN_FLAG_SAVED`).
    pub flags: u16,
    pub a: u32,
    pub b: u32,
    /// The activation that must be instantiated first, or
    /// [`CHILD_PLAN_NO_ACTIVATION`].
    pub dep_activation: u32,
}

impl ChildPlanRow {
    fn encode(&self, out: &mut [u8]) {
        out[0..4].copy_from_slice(&self.activation.to_le_bytes());
        out[4..8].copy_from_slice(&self.import_ordinal.to_le_bytes());
        out[8] = self.resolve;
        out[9] = self.type_code;
        out[10..12].copy_from_slice(&self.flags.to_le_bytes());
        out[12..16].copy_from_slice(&self.a.to_le_bytes());
        out[16..20].copy_from_slice(&self.b.to_le_bytes());
        out[20..24].copy_from_slice(&self.dep_activation.to_le_bytes());
    }
}

/// What a raw reference recipe names, as far as a child's import cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceLeaf {
    Null,
    Funcref { activation: u32, ordinal: u32 },
    StaticRoot { activation: u32, ordinal: u32 },
    Exnref,
    I31,
    Struct,
    Array,
}

/// The [`ReferenceLeaf`] of one decoded graph node.
pub fn reference_leaf(node: &ReferenceRecipeNode) -> ReferenceLeaf {
    match node {
        ReferenceRecipeNode::Null => ReferenceLeaf::Null,
        ReferenceRecipeNode::Funcref {
            module_activation,
            function_ordinal,
        } => ReferenceLeaf::Funcref {
            activation: *module_activation,
            ordinal: *function_ordinal,
        },
        ReferenceRecipeNode::StaticRoot {
            module_activation,
            static_root_ordinal,
        } => ReferenceLeaf::StaticRoot {
            activation: *module_activation,
            ordinal: *static_root_ordinal,
        },
        ReferenceRecipeNode::Exnref { .. } => ReferenceLeaf::Exnref,
        ReferenceRecipeNode::I31 { .. } => ReferenceLeaf::I31,
        ReferenceRecipeNode::Struct { .. } => ReferenceLeaf::Struct,
        ReferenceRecipeNode::Array { .. } => ReferenceLeaf::Array,
    }
}

/// Can a node of this kind be imported at the declared reference type?
///
/// A null imports at any reference type. Otherwise the kind must be one the
/// declared type can hold: a static root is whatever the guest rooted, so it
/// fits every type but `exnref`.
fn admissible(leaf: ReferenceLeaf, type_code: u8) -> bool {
    use ReferenceLeaf as L;
    match type_code {
        _ if leaf == L::Null => true,
        abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF => {
            matches!(leaf, L::Funcref { .. } | L::StaticRoot { .. })
        }
        abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF => matches!(leaf, L::StaticRoot { .. }),
        abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF => leaf == L::Exnref,
        abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF => {
            matches!(leaf, L::I31 | L::Struct | L::Array | L::StaticRoot { .. })
        }
        _ => false,
    }
}

/// The row for one planned import.
///
/// `leaf` is asked only for a raw reference. Refuses with `EINVAL` when the
/// graph's kind cannot be imported at the declared type, and with
/// `EOPNOTSUPP` for a kind that is admissible but cannot be produced before
/// instantiation: an `exnref` cannot cross JavaScript at all (a child that
/// needs one imports its owning activation's global instead), and a typed GC
/// value is rebuilt by the module driving its owner's codec, which needs that
/// owner to exist.
pub fn plan_row(
    activation: u32,
    entry: &ImportPlanEntry,
    leaf: &mut impl FnMut(u32) -> Result<ReferenceLeaf, Errno>,
) -> Result<ChildPlanRow, Errno> {
    let (lo, hi) = (entry.bits as u32, (entry.bits >> 32) as u32);
    let mut row = ChildPlanRow {
        activation,
        import_ordinal: entry.import_ordinal,
        resolve: CHILD_PLAN_RESOLVE_KEEP_BASE,
        type_code: entry.type_code,
        flags: u16::from(entry.flags),
        a: 0,
        b: 0,
        dep_activation: CHILD_PLAN_NO_ACTIVATION,
    };
    let provider = |row: &mut ChildPlanRow, resolve: u8| {
        row.resolve = resolve;
        row.a = entry.source_activation;
        row.b = entry.source_owner;
        row.dep_activation = entry.source_activation;
    };
    if entry.space != IMPORT_SPACE_GLOBAL {
        match entry.kind {
            abi::WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE => {
                provider(&mut row, CHILD_PLAN_RESOLVE_PROVIDER_TABLE)
            }
            abi::WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT => {}
            _ => return Err(Errno::EINVAL),
        }
        return Ok(row);
    }
    match entry.kind {
        abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER => {
            (row.resolve, row.a, row.b) = (CHILD_PLAN_RESOLVE_RAW_F64, lo, hi);
        }
        abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT => {
            (row.resolve, row.a, row.b) = (CHILD_PLAN_RESOLVE_RAW_I64, lo, hi);
        }
        abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL => {
            provider(&mut row, CHILD_PLAN_RESOLVE_PROVIDER_GLOBAL)
        }
        abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT => {
            if entry.flags & IMPORT_PLAN_FLAG_SAVED != 0 {
                (row.resolve, row.a, row.b) = (CHILD_PLAN_RESOLVE_SAVED_BASE_SCALAR, lo, hi);
            }
        }
        abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE => {
            let recipe = u32::try_from(entry.bits).map_err(|_| Errno::EINVAL)?;
            let node = leaf(recipe)?;
            if !admissible(node, entry.type_code) {
                return Err(Errno::EINVAL);
            }
            match node {
                ReferenceLeaf::Null => row.resolve = CHILD_PLAN_RESOLVE_NULL,
                ReferenceLeaf::Funcref { activation, ordinal } => {
                    (row.resolve, row.a) = (CHILD_PLAN_RESOLVE_FUNC_CATALOG_SLOT, ordinal);
                    row.dep_activation = activation;
                }
                ReferenceLeaf::StaticRoot { activation, ordinal } => {
                    (row.resolve, row.a) = (CHILD_PLAN_RESOLVE_STATIC_ROOT_SLOT, ordinal);
                    row.dep_activation = activation;
                }
                _ => return Err(Errno::EOPNOTSUPP),
            }
        }
        _ => return Err(Errno::EINVAL),
    }
    Ok(row)
}

/// One activation's import plan, as [`crate::build_child_import_plan`] made it.
pub struct ActivationImportPlan<'a> {
    pub activation: u32,
    pub entries: &'a [ImportPlanEntry],
}

/// A whole child's plan: every activation's rows, and the order to
/// instantiate the activations in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildPlan {
    pub rows: Vec<ChildPlanRow>,
    pub order: Vec<u32>,
    pub activation_count: u32,
}

/// Build the child's plan over `activations`, which must be in strictly
/// ascending id order. `leaf` resolves a raw reference's recipe id.
pub fn build_child_plan(
    activations: &[ActivationImportPlan<'_>],
    mut leaf: impl FnMut(u32) -> Result<ReferenceLeaf, Errno>,
) -> Result<ChildPlan, Errno> {
    if activations.windows(2).any(|w| w[0].activation >= w[1].activation) {
        return Err(Errno::EINVAL);
    }
    let mut rows = Vec::new();
    for plan in activations {
        for entry in plan.entries {
            rows.push(plan_row(plan.activation, entry, &mut leaf)?);
        }
    }
    let ids: Vec<u32> = activations.iter().map(|p| p.activation).collect();
    let order = instantiation_order(&ids, &rows)?;
    let activation_count = u32::try_from(ids.len()).map_err(|_| Errno::EINVAL)?;
    Ok(ChildPlan {
        rows,
        order,
        activation_count,
    })
}

/// The order a child must instantiate `activations` (ascending) in.
///
/// Providers before consumers. Each round takes every activation whose
/// providers are all placed, in id order, so the answer is the same on every
/// run -- a child that instantiates in another order than the archive records
/// is a child whose dylink state no longer matches. An activation depending on
/// itself is ignored here: there is no earlier instance to wait for, and what
/// its row names is refused when the host resolves it.
///
/// `EINVAL` for a dependency on an activation the child does not have;
/// `EDEADLK` for a provider cycle, since no activation in it can go first.
pub fn instantiation_order(activations: &[u32], rows: &[ChildPlanRow]) -> Result<Vec<u32>, Errno> {
    let mut edges: Vec<(u32, u32)> = Vec::new(); // (consumer, provider)
    for row in rows {
        let dep = row.dep_activation;
        if dep == CHILD_PLAN_NO_ACTIVATION || dep == row.activation {
            continue;
        }
        if activations.binary_search(&dep).is_err() {
            return Err(Errno::EINVAL);
        }
        edges.push((row.activation, dep));
    }
    let mut remaining: Vec<u32> = activations.to_vec();
    let mut order = Vec::with_capacity(remaining.len());
    while !remaining.is_empty() {
        let ready: Vec<u32> = remaining
            .iter()
            .copied()
            .filter(|id| {
                !edges
                    .iter()
                    .any(|(consumer, provider)| consumer == id && remaining.contains(provider))
            })
            .collect();
        if ready.is_empty() {
            return Err(Errno::EDEADLK);
        }
        remaining.retain(|id| !ready.contains(id));
        order.extend(ready);
    }
    Ok(order)
}

/// Bytes [`encode_child_plan`] writes for `plan`.
pub fn child_plan_len(plan: &ChildPlan) -> usize {
    CHILD_PLAN_HEADER_BYTES + plan.rows.len() * CHILD_PLAN_ROW_BYTES + plan.order.len() * 4
}

/// Encode `plan` into `out`, which will live at guest address `base`:
/// the header, the rows, then the order the header's `order_ptr` names.
pub fn encode_child_plan(plan: &ChildPlan, out: &mut [u8], base: u32) -> Result<(), Errno> {
    if out.len() != child_plan_len(plan) {
        return Err(Errno::EINVAL);
    }
    let rows_end = CHILD_PLAN_HEADER_BYTES + plan.rows.len() * CHILD_PLAN_ROW_BYTES;
    let order_ptr = u32::try_from(rows_end)
        .ok()
        .and_then(|offset| base.checked_add(offset))
        .ok_or(Errno::EINVAL)?;
    let row_count = u32::try_from(plan.rows.len()).map_err(|_| Errno::EINVAL)?;
    out[0..4].copy_from_slice(&plan.activation_count.to_le_bytes());
    out[4..8].copy_from_slice(&row_count.to_le_bytes());
    out[8..12].copy_from_slice(&order_ptr.to_le_bytes());
    for (row, chunk) in plan
        .rows
        .iter()
        .zip(out[CHILD_PLAN_HEADER_BYTES..rows_end].chunks_exact_mut(CHILD_PLAN_ROW_BYTES))
    {
        row.encode(chunk);
    }
    for (id, chunk) in plan.order.iter().zip(out[rows_end..].chunks_exact_mut(4)) {
        chunk.copy_from_slice(&id.to_le_bytes());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::child_import_plan::IMPORT_SPACE_TABLE;
    use alloc::vec;

    const I32: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32;
    const I64: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64;
    const FUNCREF: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF;
    const EXTERNREF: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF;
    const EXNREF: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF;
    const ANYREF: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF;

    fn entry(ordinal: u32, space: u8, kind: u8, type_code: u8) -> ImportPlanEntry {
        ImportPlanEntry {
            import_ordinal: ordinal,
            space,
            kind,
            type_code,
            flags: 0,
            bits: 0,
            source_activation: 0,
            source_owner: 0,
        }
    }

    fn provider(ordinal: u32, from: u32, owner: u32) -> ImportPlanEntry {
        let mut e = entry(
            ordinal,
            IMPORT_SPACE_GLOBAL,
            abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL,
            I32,
        );
        (e.source_activation, e.source_owner) = (from, owner);
        e
    }

    fn reference(ordinal: u32, recipe: u64, type_code: u8) -> ImportPlanEntry {
        let mut e = entry(
            ordinal,
            IMPORT_SPACE_GLOBAL,
            abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE,
            type_code,
        );
        e.bits = recipe;
        e
    }

    /// A graph of: 0 null, 1 funcref of activation 2, 2 static root of 1,
    /// 3 exnref, 4 i31, 5 struct, 6 array.
    fn graph(recipe: u32) -> Result<ReferenceLeaf, Errno> {
        Ok(match recipe {
            0 => ReferenceLeaf::Null,
            1 => ReferenceLeaf::Funcref { activation: 2, ordinal: 7 },
            2 => ReferenceLeaf::StaticRoot { activation: 1, ordinal: 3 },
            3 => ReferenceLeaf::Exnref,
            4 => ReferenceLeaf::I31,
            5 => ReferenceLeaf::Struct,
            6 => ReferenceLeaf::Array,
            _ => return Err(Errno::EINVAL),
        })
    }

    fn row(e: ImportPlanEntry) -> Result<ChildPlanRow, Errno> {
        plan_row(0, &e, &mut graph)
    }

    #[test]
    fn scalar_rows_carry_their_bits_split_low_high() {
        let mut number = entry(0, IMPORT_SPACE_GLOBAL, abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER, I32);
        number.bits = 0x4059_0000_0000_0001;
        let r = row(number).unwrap();
        assert_eq!((r.resolve, r.a, r.b), (CHILD_PLAN_RESOLVE_RAW_F64, 1, 0x4059_0000));
        let mut big = entry(0, IMPORT_SPACE_GLOBAL, abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT, I64);
        big.bits = u64::MAX;
        let r = row(big).unwrap();
        assert_eq!((r.resolve, r.a, r.b), (CHILD_PLAN_RESOLVE_RAW_I64, u32::MAX, u32::MAX));
        assert_eq!(r.dep_activation, CHILD_PLAN_NO_ACTIVATION);
    }

    #[test]
    fn base_imports_keep_the_base_and_carry_a_saved_scalar_when_there_is_one() {
        let base = entry(0, IMPORT_SPACE_GLOBAL, abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT, I32);
        assert_eq!(row(base).unwrap().resolve, CHILD_PLAN_RESOLVE_KEEP_BASE);
        let mut saved = base;
        saved.flags = IMPORT_PLAN_FLAG_SAVED;
        saved.bits = 42;
        let r = row(saved).unwrap();
        assert_eq!((r.resolve, r.a, r.b), (CHILD_PLAN_RESOLVE_SAVED_BASE_SCALAR, 42, 0));
        let table = entry(0, IMPORT_SPACE_TABLE, abi::WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT, FUNCREF);
        assert_eq!(row(table).unwrap().resolve, CHILD_PLAN_RESOLVE_KEEP_BASE);
    }

    #[test]
    fn provider_rows_name_the_provider_and_depend_on_it() {
        let r = row(provider(3, 1, 5)).unwrap();
        assert_eq!((r.resolve, r.a, r.b, r.dep_activation), (CHILD_PLAN_RESOLVE_PROVIDER_GLOBAL, 1, 5, 1));
        let mut table = entry(4, IMPORT_SPACE_TABLE, abi::WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE, FUNCREF);
        (table.source_activation, table.source_owner) = (2, 9);
        let r = row(table).unwrap();
        assert_eq!((r.resolve, r.a, r.b, r.dep_activation), (CHILD_PLAN_RESOLVE_PROVIDER_TABLE, 2, 9, 2));
    }

    #[test]
    fn a_raw_reference_resolves_to_its_owners_catalog_slot() {
        let f = row(reference(0, 1, FUNCREF)).unwrap();
        assert_eq!((f.resolve, f.a, f.dep_activation), (CHILD_PLAN_RESOLVE_FUNC_CATALOG_SLOT, 7, 2));
        let s = row(reference(0, 2, EXTERNREF)).unwrap();
        assert_eq!((s.resolve, s.a, s.dep_activation), (CHILD_PLAN_RESOLVE_STATIC_ROOT_SLOT, 3, 1));
        let n = row(reference(0, 0, EXNREF)).unwrap();
        assert_eq!((n.resolve, n.dep_activation), (CHILD_PLAN_RESOLVE_NULL, CHILD_PLAN_NO_ACTIVATION));
    }

    #[test]
    fn refuses_a_kind_the_declared_type_cannot_hold() {
        // The kind x declared-type table the host's `requireCompatible` held.
        assert_eq!(row(reference(0, 1, EXTERNREF)), Err(Errno::EINVAL)); // funcref as externref
        assert_eq!(row(reference(0, 1, ANYREF)), Err(Errno::EINVAL)); // funcref as anyref
        assert_eq!(row(reference(0, 5, FUNCREF)), Err(Errno::EINVAL)); // struct as funcref
        assert_eq!(row(reference(0, 3, FUNCREF)), Err(Errno::EINVAL)); // exnref as funcref
        assert_eq!(row(reference(0, 2, EXNREF)), Err(Errno::EINVAL)); // static root as exnref
        assert_eq!(row(reference(0, 1, I32)), Err(Errno::EINVAL)); // not a reference type
        assert_eq!(row(reference(0, 99, FUNCREF)), Err(Errno::EINVAL)); // no such recipe
        assert!(row(reference(0, 2, FUNCREF)).is_ok()); // a static root fits funcref
        assert!(row(reference(0, 2, ANYREF)).is_ok()); // and anyref
    }

    #[test]
    fn refuses_an_admissible_kind_no_child_can_produce_before_instantiation() {
        assert_eq!(row(reference(0, 3, EXNREF)), Err(Errno::EOPNOTSUPP));
        for recipe in [4, 5, 6] {
            assert_eq!(row(reference(0, recipe, ANYREF)), Err(Errno::EOPNOTSUPP));
        }
    }

    fn plan(activations: &[(u32, Vec<ImportPlanEntry>)]) -> Result<ChildPlan, Errno> {
        let views: Vec<ActivationImportPlan<'_>> = activations
            .iter()
            .map(|(activation, entries)| ActivationImportPlan { activation: *activation, entries })
            .collect();
        build_child_plan(&views, graph)
    }

    #[test]
    fn orders_providers_before_consumers_and_ties_by_id() {
        // 0 reads 2's global and a funcref recipe 1, which 2 owns; 2 reads
        // 1's global; 1 depends on nothing.
        let p = plan(&[
            (0, vec![provider(0, 2, 1), reference(1, 1, FUNCREF)]),
            (1, vec![]),
            (2, vec![provider(0, 1, 0)]),
        ])
        .unwrap();
        assert_eq!(p.order, vec![1, 2, 0]);
        assert_eq!(p.activation_count, 3);
        assert_eq!(p.rows.len(), 3);
        assert_eq!(p.rows[2].activation, 2);
    }

    #[test]
    fn a_round_takes_every_ready_activation_in_id_order() {
        // 0 and 3 both wait on 5; 5 and 7 are ready together.
        let p = plan(&[
            (0, vec![provider(0, 5, 0)]),
            (3, vec![provider(0, 5, 0)]),
            (5, vec![]),
            (7, vec![]),
        ])
        .unwrap();
        assert_eq!(p.order, vec![5, 7, 0, 3]);
    }

    #[test]
    fn ignores_a_self_dependency() {
        assert_eq!(plan(&[(0, vec![provider(0, 0, 1)])]).unwrap().order, vec![0]);
    }

    #[test]
    fn refuses_a_provider_cycle_with_edeadlk() {
        assert_eq!(
            plan(&[(0, vec![provider(0, 1, 0)]), (1, vec![provider(0, 0, 0)])]),
            Err(Errno::EDEADLK)
        );
        // A cycle behind an acyclic prefix is still a cycle.
        assert_eq!(
            plan(&[
                (0, vec![]),
                (1, vec![provider(0, 2, 0)]),
                (2, vec![provider(0, 3, 0)]),
                (3, vec![provider(0, 1, 0)]),
            ]),
            Err(Errno::EDEADLK)
        );
    }

    #[test]
    fn refuses_a_dependency_on_an_activation_the_child_does_not_have() {
        assert_eq!(plan(&[(0, vec![provider(0, 4, 0)])]), Err(Errno::EINVAL));
    }

    #[test]
    fn refuses_activations_out_of_order() {
        assert_eq!(plan(&[(1, vec![]), (0, vec![])]), Err(Errno::EINVAL));
        assert_eq!(plan(&[(1, vec![]), (1, vec![])]), Err(Errno::EINVAL));
    }

    #[test]
    fn encodes_header_rows_and_order() {
        let p = plan(&[(0, vec![provider(2, 1, 5)]), (1, vec![])]).unwrap();
        let mut out = vec![0u8; child_plan_len(&p)];
        encode_child_plan(&p, &mut out, 0x1000).unwrap();
        let word = |at: usize| u32::from_le_bytes([out[at], out[at + 1], out[at + 2], out[at + 3]]);
        assert_eq!((word(0), word(4)), (2, 1));
        let order_ptr = word(8);
        assert_eq!(order_ptr, 0x1000 + 12 + 24);
        let row = &out[12..36];
        assert_eq!(word(12), 0); // activation
        assert_eq!(word(16), 2); // import ordinal
        assert_eq!((row[8], row[9]), (CHILD_PLAN_RESOLVE_PROVIDER_GLOBAL, I32));
        assert_eq!((word(24), word(28), word(32)), (1, 5, 1));
        let order_at = (order_ptr - 0x1000) as usize;
        assert_eq!((word(order_at), word(order_at + 4)), (1, 0));
        assert_eq!(encode_child_plan(&p, &mut out[1..], 0x1000), Err(Errno::EINVAL));
    }
}
