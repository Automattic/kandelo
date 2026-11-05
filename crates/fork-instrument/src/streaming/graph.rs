//! Conservative semantic call closure over compact original-byte summaries.
//! Sink/facts refinement is intentionally a separate pass.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use super::{CallTarget, Dispatch, ProgramPoint, Scan, ValueProof};

#[derive(Debug, PartialEq, Eq)]
pub struct ReachingPlan {
    pub activations: BTreeSet<u32>,
    pub control_reachable: BTreeSet<u32>,
    pub tail_sites: BTreeSet<ProgramPoint>,
}

#[derive(Default)]
struct TableTargets {
    slots: BTreeMap<(u32, u32), BTreeSet<u32>>,
    slot_functions: BTreeMap<u32, BTreeSet<u32>>,
    unknown_slots: BTreeMap<u32, BTreeSet<u32>>,
    functions: BTreeMap<u32, BTreeSet<u32>>,
    unknown: BTreeSet<u32>,
}

impl TableTargets {
    fn can_dispatch(&self, table: u32, index: ValueProof, function: u32) -> bool {
        if self.unknown.contains(&table) {
            return true;
        }
        if self
            .functions
            .get(&table)
            .is_some_and(|s| s.contains(&function))
        {
            return true;
        }
        match index {
            ValueProof::I32(i) => {
                let slot = i as u32;
                self.slots
                    .get(&(table, slot))
                    .is_some_and(|s| s.contains(&function))
                    || self
                        .unknown_slots
                        .get(&table)
                        .is_some_and(|s| s.contains(&slot))
            }
            _ => {
                self.slot_functions
                    .get(&table)
                    .is_some_and(|s| s.contains(&function))
                    || self
                        .unknown_slots
                        .get(&table)
                        .is_some_and(|s| !s.is_empty())
            }
        }
    }

    fn add_unpositioned(&mut self, table: u32, value: ValueProof) {
        match value {
            ValueProof::Function(f) => {
                self.functions.entry(table).or_default().insert(f);
            }
            ValueProof::Unknown => {
                self.unknown.insert(table);
            }
            _ => {}
        }
    }
}

fn table_targets(scan: &Scan<'_>) -> TableTargets {
    let mut out = TableTargets::default();
    let mut inits: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();
    let mut copies = BTreeSet::new();
    for body in scan.functions.iter().filter_map(|f| f.body.as_ref()) {
        for &(element, table) in &body.table_inits {
            inits.entry(element).or_default().insert(table);
        }
        copies.extend(body.table_copies.iter().copied());
        out.unknown
            .extend(body.dynamic_table_writes.iter().copied());
    }
    for (table, &init) in scan.table_initializers.iter().enumerate() {
        // Match the oracle: declarations contribute concrete function refs;
        // unknown input from an imported table is a cross-module boundary
        // only when external dispatch is enabled by the caller.
        if let ValueProof::Function(_) = init {
            out.add_unpositioned(table as u32, init);
        }
    }
    for (index, element) in scan.elements.iter().enumerate() {
        if let Some((table, offset)) = element.active {
            for (i, &item) in element.items.iter().enumerate() {
                if let Some(base) = offset {
                    let Some(slot) = (base as u32).checked_add(i as u32) else {
                        out.unknown.insert(table);
                        continue;
                    };
                    match item {
                        ValueProof::Function(f) => {
                            out.slots.entry((table, slot)).or_default().insert(f);
                            out.slot_functions.entry(table).or_default().insert(f);
                        }
                        ValueProof::Unknown => {
                            out.unknown_slots.entry(table).or_default().insert(slot);
                        }
                        _ => {}
                    }
                } else {
                    out.add_unpositioned(table, item);
                }
            }
        } else if !element.declared {
            if let Some(tables) = inits.get(&(index as u32)) {
                for &table in tables {
                    for &item in &element.items {
                        out.add_unpositioned(table, item);
                    }
                }
            }
        }
    }
    loop {
        let mut changed = false;
        for &(src, dst) in &copies {
            if out.unknown.contains(&src)
                || out.unknown_slots.get(&src).is_some_and(|s| !s.is_empty())
            {
                changed |= out.unknown.insert(dst);
            }
            let mut functions = out.functions.get(&src).cloned().unwrap_or_default();
            functions.extend(out.slot_functions.get(&src).into_iter().flatten().copied());
            let dst = out.functions.entry(dst).or_default();
            let before = dst.len();
            dst.extend(functions);
            changed |= before != dst.len();
        }
        if !changed {
            break;
        }
    }
    out
}

#[derive(Clone, Copy)]
struct Edge {
    caller: u32,
    tail: Option<ProgramPoint>,
}

fn discover(plan: &mut ReachingPlan, queue: &mut VecDeque<u32>, edge: Edge) {
    if let Some(point) = edge.tail {
        plan.tail_sites.insert(point);
    } else {
        plan.activations.insert(edge.caller);
    }
    if plan.control_reachable.insert(edge.caller) {
        queue.push_back(edge.caller);
    }
}

impl Scan<'_> {
    /// Resolve the direct/indirect/reference fixed point without decoding any
    /// function again. Seeds and the external-boundary policy are explicit so
    /// legacy dlopen lowering and sink analysis cannot silently be skipped.
    ///
    /// Call this on the original scan for original-module analysis. It does
    /// not claim to model the extra driver introduced by legacy dlopen lowering.
    pub fn reaching_from_seeds(
        &self,
        seeds: impl IntoIterator<Item = u32>,
        external_dynamic_dispatch: bool,
    ) -> anyhow::Result<ReachingPlan> {
        let tables = table_targets(self);
        let types = self.types.as_ref();
        let signature = |ty: u32| {
            let id = types.core_type_at_in_module(ty);
            types.get(id).unwrap().composite_type.unwrap_func().clone()
        };
        let mut reverse: HashMap<u32, Vec<Edge>> = HashMap::new();
        let mut precise_refs: HashMap<u32, Vec<(u32, Edge)>> = HashMap::new();
        let mut dispatch: HashMap<wasmparser::FuncType, Vec<(Dispatch, Edge)>> = HashMap::new();
        let mut plan = ReachingPlan {
            activations: BTreeSet::new(),
            control_reachable: BTreeSet::new(),
            tail_sites: BTreeSet::new(),
        };
        let mut queue = VecDeque::new();
        for seed in seeds {
            anyhow::ensure!(
                (seed as usize) < self.functions.len(),
                "fork seed index out of bounds"
            );
            plan.activations.insert(seed);
            if plan.control_reachable.insert(seed) {
                queue.push_back(seed);
            }
        }
        for (caller, body) in self
            .functions
            .iter()
            .enumerate()
            .filter_map(|(i, f)| f.body.as_ref().map(|b| (i as u32, b)))
        {
            for (target, tail) in body
                .calls
                .iter()
                .map(|&t| (t, None))
                .chain(body.tails.iter().map(|t| (t.target, Some(t.point))))
            {
                let edge = Edge { caller, tail };
                match target {
                    CallTarget::Direct(callee) => reverse.entry(callee).or_default().push(edge),
                    CallTarget::Dispatch(site) => {
                        let ty = match site {
                            Dispatch::Table { ty, .. } | Dispatch::Ref { ty, .. } => ty,
                        };
                        if external_dynamic_dispatch
                            && matches!(
                                site,
                                Dispatch::Table { .. }
                                    | Dispatch::Ref {
                                        target: ValueProof::Unknown,
                                        ..
                                    }
                            )
                        {
                            discover(&mut plan, &mut queue, edge);
                        }
                        match site {
                            Dispatch::Ref {
                                target: ValueProof::Function(f),
                                ..
                            } => precise_refs.entry(f).or_default().push((ty, edge)),
                            Dispatch::Ref {
                                target: ValueProof::Null,
                                ..
                            } => {}
                            _ => dispatch
                                .entry(signature(ty))
                                .or_default()
                                .push((site, edge)),
                        }
                    }
                }
            }
        }
        while let Some(callee) = queue.pop_front() {
            if let Some(callers) = reverse.remove(&callee) {
                for edge in callers {
                    discover(&mut plan, &mut queue, edge);
                }
            }
            let mut ty = Some(types.core_type_at_in_module(self.functions[callee as usize].ty));
            let mut signatures = HashSet::new();
            while let Some(id) = ty {
                let sig = types.get(id).unwrap().composite_type.unwrap_func();
                if signatures.insert(sig.clone()) {
                    if let Some(sites) = dispatch.get_mut(sig) {
                        // A site only needs one fork-reaching target. Removing
                        // resolved sites avoids an expanded caller/callee graph.
                        sites.retain(|&(site, edge)| {
                            let reaches = match site {
                                Dispatch::Table { table, index, .. } => {
                                    tables.can_dispatch(table, index, callee)
                                }
                                Dispatch::Ref { .. } => true,
                            };
                            if reaches {
                                discover(&mut plan, &mut queue, edge);
                            }
                            !reaches
                        });
                    }
                    if let Some(edges) = precise_refs.get(&callee) {
                        for &(expected, edge) in edges {
                            if signature(expected) == *sig {
                                discover(&mut plan, &mut queue, edge);
                            }
                        }
                    }
                }
                ty = types.supertype_of(id);
            }
        }
        Ok(plan)
    }
}
