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

use crate::reference_recipes::ReferenceRecipeNode;
use crate::reference_transaction::SegmentedReferenceTransaction;

/// The resolved funcref recipe for one node: the activation whose function
/// catalog holds the target and the ordinal within it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FuncrefTarget {
    pub module_activation: u32,
    pub function_ordinal: u32,
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
}
