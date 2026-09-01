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
//! the reserved empty reference. Every OTHER kind (externref, exnref, i31,
//! struct, array, static-root) needs a host identity provider or the anyref
//! transit and is DEFERRED to a later reference slice; asking this driver for
//! one is a truthful `EINVAL`, never a silent wrong value.
//!
//! The host computes the SAME "every node is funcref or null" predicate before
//! flipping the module's funcref import, but the module re-checks
//! (`all_nodes_funcref_or_null`) so a host that disagrees can never drive an
//! unsupported kind through the funcref path — it fails loudly instead.

use wasm_posix_shared::Errno;

use alloc::vec::Vec;

use crate::host_capabilities::{ForkHostCapabilities, HostGeneration, HostRef};
use crate::reference_recipes::{node_edges, ReferenceRecipeNode};
use crate::reference_transaction::SegmentedReferenceTransaction;

/// The resolved funcref recipe for one node: the activation whose function
/// catalog holds the target and the ordinal within it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FuncrefTarget {
    pub module_activation: u32,
    pub function_ordinal: u32,
}

/// The result of one reference-reconstruction drive: the host identities the
/// module re-rooted for this fork, the host generation that owns them, and how
/// many references it reconstructed. `host_refs` is indexed by recipe id; a slot
/// is `None` for a node the drive did not re-root (Null / Funcref / a
/// not-yet-admitted aggregate). The module stashes this alongside its driver so
/// the once-per-value host roots outlive the drive until fork teardown calls
/// `ForkHostCapabilities::release_generation(generation)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconstructionState {
    host_refs: Vec<Option<HostRef>>,
    generation: HostGeneration,
    reconstructed: u32,
}

impl ReconstructionState {
    /// The host generation that owns every root re-established by the drive. It
    /// is `HostGeneration(0)` (the reserved sentinel) when the drive needed no
    /// host identity at all (a funcref/null graph), in which case no generation
    /// was begun and nothing needs releasing.
    pub fn generation(&self) -> HostGeneration {
        self.generation
    }

    /// The number of references the drive re-rooted through the host seam (the
    /// externref count for D6.2). Proof-of-use for `fm_externrefs_resolved`.
    pub fn reconstructed(&self) -> u32 {
        self.reconstructed
    }

    /// The host ref the drive re-rooted for `recipe_id`, if any.
    pub fn host_ref(&self, recipe_id: u32) -> Option<HostRef> {
        self.host_refs.get(recipe_id as usize).copied().flatten()
    }
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

    /// True when EVERY node is Null, Funcref, or Externref — the widened kind set
    /// D6.2 reconstructs through the module. Externref adds the host engine-floor
    /// (`resolve_externref` + the anyref transit) on top of D6.1's funcref/null.
    /// The host computes the same predicate before flipping the reference path;
    /// the module re-checks so a disagreeing host can never drive an unadmitted
    /// kind (exnref / GC struct/array / i31 / static-root) through the seam.
    pub fn all_nodes_externref_funcref_or_null(&self) -> bool {
        self.transaction.nodes.iter().all(|entry| {
            matches!(
                entry.node,
                ReferenceRecipeNode::Null
                    | ReferenceRecipeNode::Funcref { .. }
                    | ReferenceRecipeNode::Externref { .. }
            )
        })
    }

    /// True when EVERY node is Null, Funcref, Externref, or Exnref — the widened
    /// kind set D6.3a admits through the module. An exnref adds NO new
    /// engine-floor callback: its program exception tag is guest-module-local, so
    /// the guest export `__wpk_fork_exception_materialize` does the throw /
    /// `catch_ref` against its own tag. The module's only job is to root the
    /// exnref's reachable externref payloads in the anyref transit
    /// (`transit_rooted_recipes` + PHASE B) before the guest codec consumes them.
    /// The still-deferred aggregate kinds (GC struct/array / i31 / static-root)
    /// need a JS drive-order this slice does not move, so they keep the
    /// byte-identical JS reference path. The host computes the same predicate
    /// (plus an exception-descriptor validity check it alone can see) before
    /// flipping the reference path; the module re-checks so a disagreeing host can
    /// never drive an unadmitted kind through the seam.
    pub fn all_nodes_exnref_externref_funcref_or_null(&self) -> bool {
        self.transaction.nodes.iter().all(|entry| {
            matches!(
                entry.node,
                ReferenceRecipeNode::Null
                    | ReferenceRecipeNode::Funcref { .. }
                    | ReferenceRecipeNode::Externref { .. }
                    | ReferenceRecipeNode::Exnref { .. }
            )
        })
    }

    /// The number of Exnref nodes in the graph — the proof-of-use count the
    /// module bumps into `fm_exnrefs_reconstructed` once an exnref-bearing graph
    /// is admitted and driven through the module. The drive itself leaves the
    /// Exnref arm inert (the guest export materializes the exception), so this
    /// count, not `ReconstructionState::reconstructed`, is what proves the module
    /// (not a silent JS fallback) handled an exnref graph.
    pub fn exnref_node_count(&self) -> u32 {
        self.transaction
            .nodes
            .iter()
            .filter(|entry| matches!(entry.node, ReferenceRecipeNode::Exnref { .. }))
            .count() as u32
    }

    /// The recipe ids of externrefs that a typed/exnref consumer reaches — the
    /// externrefs that MUST be staged in the anyref transit table (at slot
    /// `recipe_id + 1`) before the consumer's GC fill / exception materialize
    /// reads them (the R1 rooting hazard). Mirrors the reachable-externref set
    /// `materializeTypedGraph` publishes into the transit
    /// (`fork-early-reference-provider.ts:1252-1255`).
    ///
    /// EMPTY for a plain externref-in-a-local graph: a bare externref is decoded
    /// straight through the (still-JS) `__wpk_fork_ref_decode_externref` import
    /// and never enters the transit. So D6.2's admitted graphs (null / funcref /
    /// externref, with no aggregate consumer) publish nothing here; the transit
    /// path is exercised by hand-built graphs now and by real forks once the
    /// aggregate kinds (D6.3 exnref, D6.4 struct/array) are admitted.
    pub fn transit_rooted_recipes(&self) -> Vec<u32> {
        let nodes = &self.transaction.nodes;
        // Seed the reachability walk from every aggregate consumer's edges.
        let mut pending: Vec<u32> = Vec::new();
        for entry in nodes {
            if matches!(
                entry.node,
                ReferenceRecipeNode::Exnref { .. }
                    | ReferenceRecipeNode::Struct { .. }
                    | ReferenceRecipeNode::Array { .. }
            ) {
                pending.extend_from_slice(node_edges(&entry.node));
            }
        }
        let mut seen = alloc::vec![false; nodes.len()];
        let mut rooted: Vec<u32> = Vec::new();
        while let Some(id) = pending.pop() {
            let index = id as usize;
            match seen.get(index) {
                Some(false) => seen[index] = true,
                _ => continue, // out of range (impossible on a decoded graph) or already seen
            }
            let node = &nodes[index].node;
            if matches!(node, ReferenceRecipeNode::Externref { .. }) {
                rooted.push(id);
            }
            pending.extend_from_slice(node_edges(node));
        }
        rooted.sort_unstable();
        rooted.dedup();
        rooted
    }

    /// Drive the once-per-value host reconstruction the co-resident module
    /// orchestrates: obtain each externref's durable host identity, then root the
    /// transit-reachable ones in the anyref transit. The MODULE owns the ORDER;
    /// the HOST owns the identity, addressed only by opaque `u32` ordinal, so no
    /// live reference ever crosses into the module.
    ///
    /// PHASE A (obtain): walk the nodes in id order and re-root each externref
    /// via `resolve_externref`, recording `recipe_id -> HostRef`. Null / Funcref
    /// / StaticRoot / I31 need no host identity here (funcref stays the
    /// wasm→wasm `table.get` path from D6.1). The aggregate arms are the D6.3 /
    /// D6.4 seams; today they are inert (the caller's gate keeps aggregate graphs
    /// out of production, and the hand-built transit unit test walks them).
    ///
    /// PHASE B (root): for each `transit_rooted_recipes()` id, publish the
    /// obtained ref into the transit at `recipe_id + 1`, then read it back and
    /// assert the SAME identity (`Err(EINVAL)` otherwise — the R1 guard that a
    /// reachable slot is non-null and unmoved before any GC fill consumes it).
    ///
    /// The host generation is opened only when there is host-backed work
    /// (an externref to root, or a transit slot to publish); a pure funcref/null
    /// graph opens none (its `generation` is the reserved sentinel `0`), so the
    /// inert-stub D6.1 path never consults the host. On success the returned
    /// [`ReconstructionState`] holds the live roots until fork teardown releases
    /// the generation.
    pub fn drive_reconstruction<H: ForkHostCapabilities>(
        &self,
        host: &mut H,
        pid: u32,
    ) -> Result<ReconstructionState, Errno> {
        let nodes = &self.transaction.nodes;
        let mut host_refs: Vec<Option<HostRef>> = alloc::vec![None; nodes.len()];
        let mut reconstructed: u32 = 0;

        let transit_recipes = self.transit_rooted_recipes();
        let needs_host = !transit_recipes.is_empty()
            || nodes
                .iter()
                .any(|entry| matches!(entry.node, ReferenceRecipeNode::Externref { .. }));

        // Only open a host root scope when there is identity to re-root; a
        // funcref/null graph leaves the sentinel generation and never calls out.
        let generation = if needs_host {
            host.begin_generation(pid)?
        } else {
            HostGeneration(0)
        };

        // PHASE A — obtain each reconstructed value's host identity.
        for entry in nodes {
            match &entry.node {
                ReferenceRecipeNode::Externref { handle } => {
                    let host_ref = host.resolve_externref(generation, *handle)?;
                    host_refs[entry.id as usize] = Some(host_ref);
                    reconstructed = reconstructed.checked_add(1).ok_or(Errno::ENOSPC)?;
                }
                // Funcref stays the wasm→wasm table.get path (D6.1); the other
                // scalars need no host identity in this phase.
                ReferenceRecipeNode::Null
                | ReferenceRecipeNode::Funcref { .. }
                | ReferenceRecipeNode::StaticRoot { .. }
                | ReferenceRecipeNode::I31 { .. } => {}
                // D6.3: Exnref arm — mint_exception_tag + materialize payload +
                // publish the exnref; inert until the exnref slice lands.
                ReferenceRecipeNode::Exnref { .. } => {}
                // D6.4: Struct/Array arm — allocate the shell, then fill in edge
                // order with the R1/R2 guards; inert until the GC slice lands.
                ReferenceRecipeNode::Struct { .. } | ReferenceRecipeNode::Array { .. } => {}
            }
        }

        // PHASE B — root every transit-reachable externref, then verify identity.
        for recipe_id in transit_recipes {
            let host_ref = host_refs
                .get(recipe_id as usize)
                .copied()
                .flatten()
                .ok_or(Errno::EINVAL)?;
            let slot = recipe_id.checked_add(1).ok_or(Errno::EINVAL)?;
            host.transit_publish(generation, slot, host_ref)?;
            let read_back = host.transit_read(generation, slot)?;
            if read_back != host_ref {
                return Err(Errno::EINVAL); // R1: slot lost identity before consume
            }
        }

        Ok(ReconstructionState {
            host_refs,
            generation,
            reconstructed,
        })
    }

    /// The single activation every Funcref recipe belongs to, if any:
    ///
    /// * `Ok(None)` — no Funcref recipes (a null-only graph); no catalog needed.
    /// * `Ok(Some(activation))` — every Funcref names this one activation, so a
    ///   single imported function catalog table resolves them all.
    /// * `Err(EINVAL)` — Funcref recipes span MORE than one activation. D6.1
    ///   imports exactly one catalog table (the primary activation's), so a
    ///   multi-activation funcref fork is a deferred case, not a silent
    ///   mis-resolution against the wrong catalog.
    ///
    /// The module requires this to hold before flipping the funcref import: with
    /// one catalog table it can only reconstruct funcrefs from one activation.
    pub fn sole_funcref_activation(&self) -> Result<Option<u32>, Errno> {
        let mut activation: Option<u32> = None;
        for entry in &self.transaction.nodes {
            if let ReferenceRecipeNode::Funcref {
                module_activation, ..
            } = entry.node
            {
                match activation {
                    None => activation = Some(module_activation),
                    Some(existing) if existing == module_activation => {}
                    Some(_) => return Err(Errno::EINVAL),
                }
            }
        }
        Ok(activation)
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
        // An externref recipe is a valid graph node but NOT a D6.1 funcref path.
        let driver = ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(1, ReferenceRecipeNode::Externref { handle: 5 }),
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

    // --- D6.2: externref reconstruction drive through the host seam --------

    use crate::host_capabilities::mock::MockForkHost;
    use crate::host_capabilities::ForkHostCapabilities;

    /// A plain externref-in-a-local graph: Null at id 0, two durable externrefs.
    /// No aggregate consumer, so nothing is transit-rooted (D6.2 case).
    fn plain_externref() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(1, ReferenceRecipeNode::Externref { handle: 7 }),
            entry(2, ReferenceRecipeNode::Externref { handle: 42 }),
        ]))
    }

    /// A transit-reachable graph (hand-built): a struct whose field edge names an
    /// externref, so the externref must be published into the anyref transit
    /// before the struct fill consumes it. D6.2 does not admit structs in
    /// production (the gate rejects them), but `drive_reconstruction` walks this
    /// directly to exercise PHASE B without waiting for the aggregate slice.
    fn struct_over_externref() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
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
            entry(1, ReferenceRecipeNode::Externref { handle: 5 }),
        ]))
    }

    #[test]
    fn widened_gate_admits_externref_funcref_null() {
        assert!(plain_externref().all_nodes_externref_funcref_or_null());
        assert!(funcref_only().all_nodes_externref_funcref_or_null());
        // A struct is still not an admitted kind for D6.2.
        assert!(!struct_over_externref().all_nodes_externref_funcref_or_null());
    }

    #[test]
    fn plain_externref_graph_has_no_transit_rooted_recipes() {
        assert!(plain_externref().transit_rooted_recipes().is_empty());
        assert!(funcref_only().transit_rooted_recipes().is_empty());
    }

    #[test]
    fn drive_resolves_each_externref_node_through_the_host() {
        let mut host = MockForkHost::new();
        let driver = plain_externref();
        let state = driver.drive_reconstruction(&mut host, 99).expect("drive");

        // Every externref node was resolved through the seam, in node order.
        assert_eq!(host.resolved_externref_handles(), &[7, 42]);
        assert_eq!(state.reconstructed(), 2);
        // Null carries no host ref; each externref recorded one.
        assert!(state.host_ref(0).is_none());
        assert!(state.host_ref(1).is_some());
        assert!(state.host_ref(2).is_some());

        // The generation is live and roots exactly the two externrefs; a plain
        // externref graph publishes nothing into the transit.
        let generation = state.generation();
        assert!(host.is_active(generation));
        assert_eq!(host.live_ref_count(generation), 2);
        assert_eq!(host.transit_slot_count(generation), 0);

        // Release drops the roots (the fork-teardown step drive does not do).
        host.release_generation(generation).expect("release");
        assert!(!host.is_active(generation));
    }

    #[test]
    fn funcref_only_drive_touches_no_host() {
        // A funcref/null graph needs no host identity (funcref stays wasm→wasm
        // via table.get). The drive must not open a generation, so an inert host
        // is never consulted — preserving the D6.1 path with inert stubs.
        let mut host = MockForkHost::new();
        let state = funcref_only()
            .drive_reconstruction(&mut host, 1)
            .expect("drive");
        assert_eq!(state.reconstructed(), 0);
        assert!(host.resolved_externref_handles().is_empty());
        // No generation was begun (sentinel 0), so nothing is active.
        assert!(!host.is_active(state.generation()));
    }

    #[test]
    fn drive_publishes_and_verifies_transit_for_reachable_externref() {
        let mut host = MockForkHost::new();
        let driver = struct_over_externref();
        let state = driver.drive_reconstruction(&mut host, 3).expect("drive");

        // PHASE A resolved the externref; PHASE B published it into the transit
        // at recipe_id+1 and read it back with matching identity.
        assert_eq!(host.resolved_externref_handles(), &[5]);
        assert_eq!(state.reconstructed(), 1);
        assert_eq!(driver.transit_rooted_recipes(), vec![1]);
        assert_eq!(host.transit_slot_count(state.generation()), 1);
    }

    #[test]
    fn drive_rejects_lost_transit_identity_without_panic() {
        // An engine that loses the anyref slot's identity between publish and
        // read is a truthful EINVAL (R1 guard), never a silent wrong value.
        let mut host = MockForkHost::new();
        host.corrupt_transit_reads();
        assert_eq!(
            struct_over_externref().drive_reconstruction(&mut host, 3),
            Err(Errno::EINVAL)
        );
    }

    // --- D6.3a: exnref admission + transit into production ------------------

    /// An exnref whose reference payload names an externref: the externref must
    /// be published into the anyref transit before the guest codec's
    /// `__wpk_fork_exception_materialize` throws/catch_refs it. The MODULE does
    /// not mint the exception tag or throw (that is the guest export's job); it
    /// only re-roots the reachable externref payload, so `drive_reconstruction`'s
    /// Exnref arm stays a no-op while PHASE B still roots the payload.
    fn exnref_over_externref() -> ReferenceReplayDriver {
        ReferenceReplayDriver::new(transaction(vec![
            entry(0, ReferenceRecipeNode::Null),
            entry(1, ReferenceRecipeNode::Externref { handle: 8 }),
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
    fn widened_gate_admits_exnref_but_d6_2_predicate_does_not() {
        let driver = exnref_over_externref();
        // The D6.3a predicate admits exnref; the D6.2 predicate rejects it.
        assert!(driver.all_nodes_exnref_externref_funcref_or_null());
        assert!(!driver.all_nodes_externref_funcref_or_null());
        // The widened gate still admits every previously-admitted graph.
        assert!(plain_externref().all_nodes_exnref_externref_funcref_or_null());
        assert!(funcref_only().all_nodes_exnref_externref_funcref_or_null());
        // A struct is still not an admitted kind (deferred to D6.4).
        assert!(!struct_over_externref().all_nodes_exnref_externref_funcref_or_null());
    }

    #[test]
    fn drive_roots_exnref_reachable_externref_without_minting_a_tag() {
        let mut host = MockForkHost::new();
        let driver = exnref_over_externref();
        let state = driver.drive_reconstruction(&mut host, 5).expect("drive");

        // PHASE A resolved the reachable externref payload; PHASE B published it
        // into the transit at recipe_id+1 and read it back with matching
        // identity (the R1 rooting guard the guest exception materialize relies
        // on).
        assert_eq!(host.resolved_externref_handles(), &[8]);
        assert_eq!(state.reconstructed(), 1);
        assert_eq!(driver.transit_rooted_recipes(), vec![1]);
        assert_eq!(host.transit_slot_count(state.generation()), 1);

        // The exnref node was admitted (proof-of-use count for
        // `fm_exnrefs_reconstructed`) ...
        assert_eq!(driver.exnref_node_count(), 1);
        // ... but the drive minted NO exception tag: the guest export owns the
        // throw/catch_ref against its own module-local tag, so the Exnref drive
        // arm stays inert (`mint_exception_tag` must never be called here).
        assert_eq!(host.mint_exception_tag_calls(), 0);
    }

    #[test]
    fn drive_rejects_lost_transit_identity_for_exnref_without_panic() {
        // The same R1 guard applies to an exnref's reachable externref payload:
        // an engine that loses the anyref slot identity is a truthful EINVAL.
        let mut host = MockForkHost::new();
        host.corrupt_transit_reads();
        assert_eq!(
            exnref_over_externref().drive_reconstruction(&mut host, 5),
            Err(Errno::EINVAL)
        );
    }
}
