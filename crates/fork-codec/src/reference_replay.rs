//! Reference-reconstruction replay driver (Phase 6 D6.1 — funcref + null).
//!
//! Where `reference_transaction` DECODES the live segmented fork reference
//! transaction (KFRV + KFRS) into a validated `SegmentedReferenceTransaction`,
//! this module DRIVES the per-recipe queries the co-resident fork module needs
//! to reconstruct reference values from that graph. It is the small,
//! portable core the module's `__wpk_fork_ref_decode_funcref` export consults:
//! recipe id -> (activation, function-catalog ordinal), so the module can do a
//! `table.get` on the imported function catalog table.
//!
//! ## Admitted kinds (D6.1)
//!
//! This slice admits FUNCREF and NULL ONLY. A funcref is the one reference kind
//! a Wasm module can reconstruct with ZERO new engine-floor callbacks: its
//! identity lives in an engine `Table` (the guest's `__wpk_fork_function_catalog`
//! funcref table), which the module imports and reads with `table.get`. Null is
//! the reserved empty reference. Every OTHER kind (exnref, i31, struct, array,
//! static-root) needs the anyref transit and is DEFERRED to a later reference
//! slice; asking this driver for
//! one is a truthful `EINVAL`, never a silent wrong value.
//!
//! The host computes the SAME "every node is funcref or null" predicate before
//! flipping the module's funcref import, but the module re-checks
//! (`all_nodes_funcref_or_null`) so a host that disagrees can never drive an
//! unsupported kind through the funcref path — it fails loudly instead.

use wasm_posix_shared::Errno;

use alloc::vec::Vec;

use crate::reference_recipes::ReferenceRecipeNode;
use crate::reference_transaction::SegmentedReferenceTransaction;

/// The resolved funcref recipe for one node: the activation whose function
/// catalog holds the target and the ordinal within it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FuncrefTarget {
    pub module_activation: u32,
    pub function_ordinal: u32,
}

/// The resolved static-root recipe for one node: the activation whose
/// instantiation-time static-root catalog holds the target and the ordinal
/// within it. The static-root binder maps this to a merged anyref-catalog slot
/// (`base(module_activation) + static_root_ordinal`) for a wasm `table.get`,
/// mirroring [`FuncrefTarget`] for the funcref path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StaticRootTarget {
    pub module_activation: u32,
    pub static_root_ordinal: u32,
}

/// Holds a decoded reference transaction and answers the funcref/null recipe
/// queries the co-resident module needs during reference reconstruction.
#[derive(Debug, Clone)]
pub struct ReferenceReplayDriver {
    transaction: SegmentedReferenceTransaction,
}

impl ReferenceReplayDriver {
    /// Wrap a decoded transaction for replay.
    pub fn new(transaction: SegmentedReferenceTransaction) -> Self {
        Self { transaction }
    }

    /// The wrapped transaction (diagnostics / vector access).
    pub fn transaction(&self) -> &SegmentedReferenceTransaction {
        &self.transaction
    }

    /// Number of canonical recipe nodes in the graph.
    pub fn node_count(&self) -> usize {
        self.transaction.nodes.len()
    }

    /// Resolve a funcref-or-null recipe:
    ///
    /// * `Ok(None)` — the recipe is the canonical Null reference (reconstruct
    ///   `ref.null func`).
    /// * `Ok(Some(target))` — a Funcref naming an `(activation, ordinal)` for a
    ///   `table.get` on that activation's function catalog.
    /// * `Err(EINVAL)` — the recipe id is out of range, the graph is internally
    ///   inconsistent, or the node is a kind D6.1 does not admit (anything other
    ///   than Null / Funcref). The caller must NOT fabricate a value; an
    ///   unsupported kind is a truthful failure until its slice lands.
    pub fn funcref_node(&self, recipe_id: u32) -> Result<Option<FuncrefTarget>, Errno> {
        let entry = self
            .transaction
            .nodes
            .get(recipe_id as usize)
            .ok_or(Errno::EINVAL)?;
        // The decoder guarantees canonical id == index; assert it so a corrupt
        // graph reaching here is a loud failure, not a silent mis-resolution.
        if entry.id != recipe_id {
            return Err(Errno::EINVAL);
        }
        match &entry.node {
            ReferenceRecipeNode::Null => Ok(None),
            ReferenceRecipeNode::Funcref {
                module_activation,
                function_ordinal,
            } => Ok(Some(FuncrefTarget {
                module_activation: *module_activation,
                function_ordinal: *function_ordinal,
            })),
            _ => Err(Errno::EINVAL),
        }
    }

    /// Resolve a static-root recipe to its `(activation, ordinal)`:
    ///
    /// * `Ok(target)` — a StaticRoot naming the activation whose static-root
    ///   catalog holds the value and the ordinal within it. The static-root
    ///   binder maps this to a merged anyref-catalog slot (`base(activation) +
    ///   ordinal`) via `fm_static_root_slot` for a wasm `table.get`.
    /// * `Err(EINVAL)` — the recipe id is out of range, the graph is internally
    ///   inconsistent, or the node is not a StaticRoot. The caller must NOT
    ///   fabricate a value; a mismatched kind is a truthful failure.
    ///
    /// Unlike a funcref, a static root is NOT decoded on a guest import: it is
    /// published into the anyref transit at slot `recipe_id + 1` by a
    /// [`DRIVE_OP_STATIC_ROOT`](crate::drive_plan::DRIVE_OP_STATIC_ROOT) drive
    /// step before any `_gc_fill` consumes it, so this accessor answers only the
    /// slot query the injected drive shim needs.
    pub fn static_root_node(&self, recipe_id: u32) -> Result<StaticRootTarget, Errno> {
        let entry = self
            .transaction
            .nodes
            .get(recipe_id as usize)
            .ok_or(Errno::EINVAL)?;
        // The decoder guarantees canonical id == index; assert it so a corrupt
        // graph reaching here is a loud failure, not a silent mis-resolution.
        if entry.id != recipe_id {
            return Err(Errno::EINVAL);
        }
        match &entry.node {
            ReferenceRecipeNode::StaticRoot {
                module_activation,
                static_root_ordinal,
            } => Ok(StaticRootTarget {
                module_activation: *module_activation,
                static_root_ordinal: *static_root_ordinal,
            }),
            _ => Err(Errno::EINVAL),
        }
    }

    /// True when EVERY node in the graph is Null or Funcref — the exact kind set
    /// D6.1 reconstructs through the module. The module gates
    /// `begin_reference_replay` on this so a disagreeing host can never drive an
    /// unsupported reference kind through the funcref import.
    pub fn all_nodes_funcref_or_null(&self) -> bool {
        self.transaction.nodes.iter().all(|entry| {
            matches!(
                entry.node,
                ReferenceRecipeNode::Null | ReferenceRecipeNode::Funcref { .. }
            )
        })
    }

    /// The number of Exnref nodes in the graph — the proof-of-use count the
    /// module bumps into `fm_exnrefs_reconstructed` once an exnref-bearing graph
    /// is admitted and driven through the module. The drive itself leaves the
    /// Exnref arm inert (the guest export materializes the exception), so this
    /// count is what proves the module (not a silent JS fallback) handled an
    /// exnref graph.
    pub fn exnref_node_count(&self) -> u32 {
        self.transaction
            .nodes
            .iter()
            .filter(|entry| matches!(entry.node, ReferenceRecipeNode::Exnref { .. }))
            .count() as u32
    }

    /// The first Exnref node whose `(module_activation, tag_ordinal)` its owning
    /// activation's exception codec does NOT declare, or `None` when every exnref
    /// in the graph names a declared tag. `tag_declared(activation, tag)` answers
    /// whether that activation's seeded exception codec declared the ordinal; a
    /// `false` for an exnref's own coordinate — including an activation that
    /// declared no exception codec at all — is a violation.
    ///
    /// This is the exnref tag-validity ADMISSION gate. The module runs it at the
    /// child-install ENTRY (`fm_attach_child`, COW and borrowed alike), BEFORE
    /// it builds the reconstruction drive plan whose
    /// [`DRIVE_OP_EXN`](crate::drive_plan) step would otherwise `call_indirect` the
    /// guest exception-materialize export blindly. A corrupt / mismatched exnref
    /// recipe (a tag its owning activation never declared) must fail loud with
    /// `EINVAL` — truthful failure over a silent wrong exception reconstruction —
    /// never be driven. In normal operation a captured exnref always names a tag
    /// its activation declared, so this returns `None` on every well-formed fork.
    /// This is the module-side re-check that supersedes the former host boundary
    /// `assertForkModuleExnrefTagsDeclared`: the module now owns the fail-loud
    /// exnref admission, seeded per activation by `fm_set_activation_exception_tags`.
    pub fn first_undeclared_exnref(
        &self,
        tag_declared: impl Fn(u32, u32) -> bool,
    ) -> Option<(u32, u32)> {
        for entry in &self.transaction.nodes {
            if let ReferenceRecipeNode::Exnref {
                module_activation,
                tag_ordinal,
                ..
            } = entry.node
            {
                if !tag_declared(module_activation, tag_ordinal) {
                    return Some((module_activation, tag_ordinal));
                }
            }
        }
        None
    }

    /// True when EVERY node is a kind the module admits: Null, Funcref,
    /// Exnref, a typed-GC value (Struct / Array / I31), or a StaticRoot. (There
    /// is no host-`externref` node: a fork carrying one is refused at
    /// capture.) This is the whole set reference reconstruction drives through
    /// the co-resident module — no kind remains on the JS reference path.
    ///
    /// Admitting typed GC adds NO new engine-floor callback and moves NO
    /// drive-order into the module: the fork side module is instantiated BEFORE
    /// the guest exists, so it cannot import the guest's `_gc_allocate`/`_gc_fill`
    /// exports, and the PROVEN JS drive-order (`materializeTypedGraph`) is
    /// reproduced by `build_drive_plan`. An i31 is a scalar leaf (no host call,
    /// no transit).
    ///
    /// A StaticRoot is an IMMUTABLE, `ref.eq`-capable WasmGC reference the module
    /// statically initializes; it too adds NO new engine-floor callback. It is
    /// published into the anyref transit at slot `recipe + 1` by a
    /// [`DRIVE_OP_STATIC_ROOT`](crate::drive_plan::DRIVE_OP_STATIC_ROOT) step
    /// (`table.set(transit, recipe+1, table.get(static_root_catalog, base+ord))`,
    /// both wasm) before any consumer reads it — the static-root binder. The host
    /// computes the same KIND predicate (plus a GC-descriptor validity check only
    /// it can see) before flipping the reference path; the module re-checks so a
    /// disagreeing host can never drive an unadmitted kind through the seam.
    pub fn all_nodes_module_admissible(&self) -> bool {
        self.transaction.nodes.iter().all(|entry| {
            matches!(
                entry.node,
                ReferenceRecipeNode::Null
                    | ReferenceRecipeNode::Funcref { .. }
                    | ReferenceRecipeNode::Exnref { .. }
                    | ReferenceRecipeNode::Struct { .. }
                    | ReferenceRecipeNode::Array { .. }
                    | ReferenceRecipeNode::I31 { .. }
                    | ReferenceRecipeNode::StaticRoot { .. }
            )
        })
    }

    /// The distinct set of activations any StaticRoot recipe in the graph names,
    /// sorted ascending (empty when the graph has no static root). The static-root
    /// binder seeds a per-activation merged-catalog base for each activation in
    /// this set (mirroring [`funcref_activations`](Self::funcref_activations)); a
    /// StaticRoot naming an activation with no seeded base is a truthful failure,
    /// never a read against the wrong catalog slice.
    pub fn static_root_activations(&self) -> Vec<u32> {
        let mut activations: Vec<u32> = self
            .transaction
            .nodes
            .iter()
            .filter_map(|entry| match entry.node {
                ReferenceRecipeNode::StaticRoot {
                    module_activation, ..
                } => Some(module_activation),
                _ => None,
            })
            .collect();
        activations.sort_unstable();
        activations.dedup();
        activations
    }

    /// The number of typed-GC nodes (Struct + Array + I31) in the graph — the
    /// proof-of-use count the module bumps into `fm_gc_nodes_reconstructed` once a
    /// typed-GC graph is admitted and driven through the module (the guest
    /// drives the GC allocate/fill under the JS order), so this count is what
    /// proves the module (not a silent JS fallback) admitted a typed-GC graph.
    pub fn gc_node_count(&self) -> u32 {
        self.transaction
            .nodes
            .iter()
            .filter(|entry| {
                matches!(
                    entry.node,
                    ReferenceRecipeNode::Struct { .. }
                        | ReferenceRecipeNode::Array { .. }
                        | ReferenceRecipeNode::I31 { .. }
                )
            })
            .count() as u32
    }

    /// The distinct set of activations any Funcref recipe in the graph names,
    /// sorted ascending (empty for a null-only graph).
    ///
    /// This RETIRES the single-activation `sole_funcref_activation` gate (Phase 6
    /// D7a.1b). A funcref no longer has to belong to one activation: every funcref
    /// resolves against a MERGED, activation-namespaced catalog (the host lays
    /// each activation's function catalog at a distinct base in one imported
    /// table), so funcrefs may span any number of activations. The module seeds a
    /// per-activation catalog base for each activation in this set; a funcref
    /// naming an activation with no seeded base is a truthful failure, never a
    /// read against the wrong catalog. A funcref minted in module A but held by
    /// module B's frame still resolves against A (its `module_activation`), not B
    /// (the caller) — the namespaced catalog is keyed by the recipe's coordinate.
    pub fn funcref_activations(&self) -> Vec<u32> {
        let mut activations: Vec<u32> = self
            .transaction
            .nodes
            .iter()
            .filter_map(|entry| match entry.node {
                ReferenceRecipeNode::Funcref {
                    module_activation, ..
                } => Some(module_activation),
                _ => None,
            })
            .collect();
        activations.sort_unstable();
        activations.dedup();
        activations
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use alloc::vec;
    use alloc::vec::Vec;

    use crate::reference_recipes::ReferenceRecipeEntry;
    use crate::reference_transaction::VectorInternIndex;

    fn entry(id: u32, node: ReferenceRecipeNode) -> ReferenceRecipeEntry {
        ReferenceRecipeEntry { id, node }
    }

    fn transaction(nodes: Vec<ReferenceRecipeEntry>) -> SegmentedReferenceTransaction {
        SegmentedReferenceTransaction {
            roots: Vec::new(),
            nodes,
            vectors: vec![Vec::new()],
            vector_intern: VectorInternIndex::default(),
        }
    }

    /// A funcref-only graph: Null at id 0, two funcrefs after it.
    fn funcref_only() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(
                1,
                ReferenceRecipeNode::Funcref {
                    module_activation: 0,
                    function_ordinal: 3,
                },
            ),
            entry(
                2,
                ReferenceRecipeNode::Funcref {
                    module_activation: 0,
                    function_ordinal: 7,
                },
            ),
        ]))
    }

    #[test]
    fn null_recipe_resolves_to_none() {
        assert_eq!(funcref_only().funcref_node(0), Ok(None));
    }

    #[test]
    fn funcref_recipe_resolves_to_target() {
        let driver = funcref_only();
        assert_eq!(
            driver.funcref_node(1),
            Ok(Some(FuncrefTarget {
                module_activation: 0,
                function_ordinal: 3,
            }))
        );
        assert_eq!(
            driver.funcref_node(2),
            Ok(Some(FuncrefTarget {
                module_activation: 0,
                function_ordinal: 7,
            }))
        );
    }

    #[test]
    fn out_of_range_recipe_is_einval() {
        assert_eq!(funcref_only().funcref_node(3), Err(Errno::EINVAL));
        assert_eq!(funcref_only().funcref_node(u32::MAX), Err(Errno::EINVAL));
    }

    #[test]
    fn non_canonical_id_is_einval() {
        // A graph whose stored id disagrees with its index must fail loudly.
        let driver = ReferenceReplayDriver::new(transaction(vec![entry(
            9,
            ReferenceRecipeNode::Null,
        )]));
        assert_eq!(driver.funcref_node(0), Err(Errno::EINVAL));
    }

    #[test]
    fn unsupported_kind_is_einval() {
        // An i31 recipe is a valid graph node but NOT a D6.1 funcref path.
        let driver = ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(1, ReferenceRecipeNode::I31 { value: 5 }),
        ]));
        assert_eq!(driver.funcref_node(1), Err(Errno::EINVAL));
        assert!(!driver.all_nodes_funcref_or_null());
    }

    #[test]
    fn funcref_only_graph_is_supported() {
        assert!(funcref_only().all_nodes_funcref_or_null());
    }

    #[test]
    fn node_count_and_transaction_accessors() {
        let driver = funcref_only();
        assert_eq!(driver.node_count(), 3);
        assert_eq!(driver.transaction().nodes.len(), 3);
    }

    // --- Exnref tag-validity admission gate (`first_undeclared_exnref`) -------

    /// A graph carrying one exnref naming `(module_activation, tag_ordinal)`,
    /// plus a leading null so ids stay canonical.
    fn exnref_graph(module_activation: u32, tag_ordinal: u32) -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(
                1,
                ReferenceRecipeNode::Exnref {
                    module_activation,
                    tag_ordinal,
                    layout_id: 0,
                    scalars: Vec::new(),
                    payloads: Vec::new(),
                },
            ),
        ]))
    }

    #[test]
    fn undeclared_exnref_tag_is_rejected() {
        // Activation 0 declared tags {0, 1}, but the recipe names tag 7: a
        // corrupt / mismatched exnref that must fail the admission gate so the
        // module refuses to drive it (the caller maps `Some` to `EINVAL`).
        let driver = exnref_graph(0, 7);
        let declared = |activation: u32, tag: u32| activation == 0 && (tag == 0 || tag == 1);
        assert_eq!(driver.first_undeclared_exnref(declared), Some((0, 7)));
    }

    #[test]
    fn declared_exnref_tag_is_admitted() {
        // The well-formed case: the recipe names a tag its activation declared,
        // so the gate returns `None` and reconstruction proceeds.
        let driver = exnref_graph(0, 1);
        let declared = |activation: u32, tag: u32| activation == 0 && (tag == 0 || tag == 1);
        assert_eq!(driver.first_undeclared_exnref(declared), None);
    }

    #[test]
    fn exnref_naming_undeclared_activation_is_rejected() {
        // An exnref naming an activation whose exception codec declared NOTHING
        // (the lookup is `false` for every coordinate) is a violation, not a
        // silent admit.
        let driver = exnref_graph(3, 0);
        assert_eq!(driver.first_undeclared_exnref(|_, _| false), Some((3, 0)));
    }

    #[test]
    fn exnref_free_graph_admits_trivially() {
        // A funcref-only graph has no exnref node, so the gate never fires even
        // with a lookup that would reject everything.
        assert_eq!(funcref_only().first_undeclared_exnref(|_, _| false), None);
    }

    // --- D7a.1b: multi-activation funcref graphs (merged catalog) -----------

    /// A graph whose funcrefs span TWO activations (5 and 2), plus a null. This
    /// is the case the retired `sole_funcref_activation` gate rejected; D7a.1b
    /// admits it and resolves each funcref against its OWN activation's catalog
    /// via the merged, activation-namespaced catalog.
    fn cross_activation_funcref() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(
                1,
                ReferenceRecipeNode::Funcref {
                    module_activation: 5,
                    function_ordinal: 1,
                },
            ),
            entry(
                2,
                ReferenceRecipeNode::Funcref {
                    module_activation: 2,
                    function_ordinal: 4,
                },
            ),
            entry(
                3,
                ReferenceRecipeNode::Funcref {
                    module_activation: 5,
                    function_ordinal: 9,
                },
            ),
        ]))
    }

    #[test]
    fn funcref_activations_lists_distinct_sorted_activations() {
        // Both activations appear once, sorted ascending — the set the module
        // seeds a per-activation catalog base for.
        assert_eq!(cross_activation_funcref().funcref_activations(), vec![2, 5]);
    }

    #[test]
    fn cross_activation_funcrefs_resolve_against_their_own_activation() {
        // A funcref minted in activation 5 stays activation 5 even in a graph
        // that also holds an activation-2 funcref: `funcref_node` resolves each
        // against its OWN `(module_activation, function_ordinal)`, never the
        // caller's. The merged catalog namespaces by exactly this coordinate.
        let driver = cross_activation_funcref();
        assert_eq!(
            driver.funcref_node(1),
            Ok(Some(FuncrefTarget {
                module_activation: 5,
                function_ordinal: 1,
            }))
        );
        assert_eq!(
            driver.funcref_node(2),
            Ok(Some(FuncrefTarget {
                module_activation: 2,
                function_ordinal: 4,
            }))
        );
        assert_eq!(
            driver.funcref_node(3),
            Ok(Some(FuncrefTarget {
                module_activation: 5,
                function_ordinal: 9,
            }))
        );
    }

    #[test]
    fn funcref_activations_empty_for_null_only_graph() {
        let driver = ReferenceReplayDriver::new(transaction(vec![entry(
            0,
            ReferenceRecipeNode::Null,
        )]));
        assert!(driver.funcref_activations().is_empty());
    }

    #[test]
    fn funcref_activations_single_for_one_activation_graph() {
        // The single-activation graph reports exactly its one activation, so the
        // module's byte-identical base-empty path (base 0) still applies.
        assert_eq!(funcref_only().funcref_activations(), vec![0]);
    }

    // --- drive-plan structure over typed graphs ---------------------------
    //
    // These assert the PLAN STRUCTURE `build_drive_plan` emits for graphs this
    // driver admits. A funcref leaf stands in wherever a leaf is needed: it
    // needs no drive step (the injected funcref shim reconstructs it), so the
    // plans below are the aggregate steps alone. There is no host-externref
    // node or transit step any more (stage E2).

    use crate::drive_plan::{
        build_drive_plan, drive_table_base, DrivePlanHints, DriveStep, DRIVE_OP_ALLOC,
        DRIVE_OP_EXN, DRIVE_OP_FILL,
    };

    /// A minimal [`DrivePlanHints`] for these graphs: no constructor
    /// dependencies, no defaultable shells, no i31 owner, and a configurable exn
    /// owner.
    #[derive(Default)]
    struct TestHints {
        exn_owner: Option<u32>,
    }

    impl DrivePlanHints for TestHints {
        fn allocation_dependencies(&self, _recipe_id: u32) -> &[u32] {
            &[]
        }
        fn is_defaultable_shell(&self, _recipe_id: u32) -> bool {
            false
        }
        fn i31_owner(&self) -> Option<u32> {
            None
        }
        fn exn_owner(&self, _recipe_id: u32) -> Option<u32> {
            self.exn_owner
        }
    }

    /// A step's (op, recipe) — the shape the plan-order assertions care about.
    fn op_recipe(step: &DriveStep) -> (u32, u32) {
        (step.op, step.recipe)
    }

    fn funcref_leaf() -> ReferenceRecipeNode {
        ReferenceRecipeNode::Funcref {
            module_activation: 0,
            function_ordinal: 0,
        }
    }

    #[test]
    fn funcref_only_graph_has_an_empty_drive_plan() {
        let driver = funcref_only();
        let plan = build_drive_plan(&driver.transaction().nodes, &TestHints::default()).unwrap();
        assert!(plan.is_empty());
    }

    #[test]
    fn struct_over_funcref_allocates_then_fills() {
        let driver = ReferenceReplayDriver::new(transaction(vec![
            entry(
                0,
                ReferenceRecipeNode::Struct {
                    module_activation: 3,
                    type_ordinal: 1,
                    layout_id: 9,
                    scalars: alloc::vec![0u8; 4],
                    fields: vec![1],
                },
            ),
            entry(1, funcref_leaf()),
        ]));
        let plan = build_drive_plan(&driver.transaction().nodes, &TestHints::default()).unwrap();
        assert_eq!(
            plan.iter().map(op_recipe).collect::<Vec<_>>(),
            vec![(DRIVE_OP_ALLOC, 0), (DRIVE_OP_FILL, 0)]
        );
    }

    /// An exnref whose reference payload names a funcref.
    fn exnref_over_funcref() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(1, funcref_leaf()),
            entry(
                2,
                ReferenceRecipeNode::Exnref {
                    module_activation: 0,
                    tag_ordinal: 0,
                    layout_id: 0,
                    scalars: alloc::vec![0u8; 0],
                    payloads: vec![1],
                },
            ),
        ]))
    }

    #[test]
    fn exnref_materializes_in_its_owner_activation() {
        // The materialize runs against the guest's own module-local tag (the EXN
        // step drives `__wpk_fork_exception_materialize`); no host tag is minted
        // anywhere in the plan.
        let driver = exnref_over_funcref();
        let hints = TestHints { exn_owner: Some(3) };
        let plan = build_drive_plan(&driver.transaction().nodes, &hints).unwrap();
        assert_eq!(plan.iter().map(op_recipe).collect::<Vec<_>>(), vec![(DRIVE_OP_EXN, 2)]);
        assert_eq!(plan[0].slot, drive_table_base(3) + DRIVE_OP_EXN);
        assert_eq!(driver.exnref_node_count(), 1);
    }

    // --- D6.4a: typed-GC (struct/array/i31) admission ------------------------

    /// A struct<->array CYCLE whose subgraph reaches an ALIASED funcref leaf:
    ///   id 0 = struct  -> array(1) + funcref(2)
    ///   id 1 = array   -> struct(0) (back-edge, the cycle) + funcref(2) (alias)
    ///   id 2 = funcref (reached from BOTH the struct field and the array element)
    fn struct_array_cycle() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(
                0,
                ReferenceRecipeNode::Struct {
                    module_activation: 0,
                    type_ordinal: 1,
                    layout_id: 1,
                    scalars: alloc::vec![0u8; 4],
                    fields: vec![1, 2],
                },
            ),
            entry(
                1,
                ReferenceRecipeNode::Array {
                    module_activation: 0,
                    type_ordinal: 2,
                    layout_id: 2,
                    scalars: alloc::vec![0u8; 2],
                    elements: vec![0, 2],
                },
            ),
            entry(2, funcref_leaf()),
        ]))
    }

    #[test]
    fn module_gate_admits_every_surviving_kind() {
        assert!(struct_array_cycle().all_nodes_module_admissible());
        let i31_graph = ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::I31 { value: -17 }),
            entry(1, ReferenceRecipeNode::I31 { value: 42 }),
        ]));
        assert!(i31_graph.all_nodes_module_admissible());
        assert!(exnref_over_funcref().all_nodes_module_admissible());
        assert!(funcref_only().all_nodes_module_admissible());
        // static-root is admitted (the static-root binder publishes it into the
        // anyref transit via a DRIVE_OP_STATIC_ROOT step — no host seam).
        let static_root = ReferenceReplayDriver::new(transaction(vec![entry(
            0,
            ReferenceRecipeNode::StaticRoot {
                module_activation: 0,
                static_root_ordinal: 0,
            },
        )]));
        assert!(static_root.all_nodes_module_admissible());
    }

    #[test]
    fn static_root_node_resolves_target_and_activations() {
        // A mixed graph: null, a static root in activation 3, a static root in
        // activation 1, and a funcref (a non-static kind) — the accessor resolves
        // only the static roots and lists their distinct activations sorted.
        let driver = ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(
                1,
                ReferenceRecipeNode::StaticRoot {
                    module_activation: 3,
                    static_root_ordinal: 5,
                },
            ),
            entry(
                2,
                ReferenceRecipeNode::StaticRoot {
                    module_activation: 1,
                    static_root_ordinal: 2,
                },
            ),
            entry(
                3,
                ReferenceRecipeNode::Funcref {
                    module_activation: 0,
                    function_ordinal: 0,
                },
            ),
        ]));
        assert_eq!(
            driver.static_root_node(1),
            Ok(StaticRootTarget {
                module_activation: 3,
                static_root_ordinal: 5,
            })
        );
        assert_eq!(
            driver.static_root_node(2),
            Ok(StaticRootTarget {
                module_activation: 1,
                static_root_ordinal: 2,
            })
        );
        // A non-static kind, an out-of-range id, and the null node are truthful
        // EINVALs — the accessor never fabricates a slot.
        assert_eq!(driver.static_root_node(0), Err(Errno::EINVAL));
        assert_eq!(driver.static_root_node(3), Err(Errno::EINVAL));
        assert_eq!(driver.static_root_node(99), Err(Errno::EINVAL));
        // Distinct activations, sorted ascending (the base-seed set).
        assert_eq!(driver.static_root_activations(), vec![1, 3]);
        // A graph with no static root reports an empty activation set.
        assert!(funcref_only().static_root_activations().is_empty());
    }

    #[test]
    fn gc_node_count_counts_struct_array_and_i31_nodes() {
        // struct + array (the funcref leaf is not a GC node).
        assert_eq!(struct_array_cycle().gc_node_count(), 2);
        // A pure i31 pair.
        let i31_graph = ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::I31 { value: 1 }),
            entry(1, ReferenceRecipeNode::I31 { value: 2 }),
            entry(2, ReferenceRecipeNode::Null),
        ]));
        assert_eq!(i31_graph.gc_node_count(), 2);
        // Graphs with no GC nodes count zero.
        assert_eq!(funcref_only().gc_node_count(), 0);
        assert_eq!(exnref_over_funcref().gc_node_count(), 0);
    }

    #[test]
    fn typed_gc_cycle_allocates_all_then_fills() {
        // Allocate-all-first breaks the struct<->array cycle: ALLOC 0, ALLOC 1,
        // FILL 0, FILL 1. The aliased funcref leaf needs no step.
        let driver = struct_array_cycle();
        let plan = build_drive_plan(&driver.transaction().nodes, &TestHints::default()).unwrap();
        assert_eq!(
            plan.iter().map(op_recipe).collect::<Vec<_>>(),
            vec![
                (DRIVE_OP_ALLOC, 0),
                (DRIVE_OP_ALLOC, 1),
                (DRIVE_OP_FILL, 0),
                (DRIVE_OP_FILL, 1),
            ]
        );
        assert_eq!(driver.gc_node_count(), 2);
    }
}
