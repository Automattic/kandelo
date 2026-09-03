//! Reference-state analysis for fork continuation planning.
//!
//! This module deliberately analyzes the original Walrus IR.  The emission
//! transform splits and nests instruction sequences, so running liveness after
//! rewriting would answer questions about synthetic locals rather than the
//! guest values that are live at a fork landing.
//!
//! The analysis is independent from `instrument.rs` for now.  It provides:
//!
//! * stable, depth-first call-site identities;
//! * a structured control-flow graph, including exception edges;
//! * backward reference-local and scalar-local liveness; and
//! * a conservative forward definitely-null analysis.
//!
//! `MaybeNonNull` intentionally includes both non-null values and values whose
//! nullness is unknown.  Only `DefinitelyNull` is strong enough to omit a
//! reconstruction recipe.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use anyhow::{Result, bail};
use walrus::{
    AbstractHeapType, FunctionId, FunctionKind, HeapType, LocalFunction, LocalId, Module, RefType,
    TableId, TagId, TypeId, ValType,
    ir::{
        AtomicWidth, Instr, InstrSeqId, InstrSeqType, LegacyCatch, LoadKind, TryTableCatch,
        UnaryOp, Value,
    },
};

/// Stable identity assigned before any instruction rewriting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OriginalCallSiteId(pub u32);

/// One instruction in the original Walrus IR.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OriginalProgramPoint {
    pub sequence: InstrSeqId,
    pub instruction_index: usize,
}

/// The invocation form at a fork-relevant call landing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginalCallKind {
    Direct(FunctionId),
    Indirect { table: TableId, ty: TypeId },
    Ref { ty: TypeId },
}

impl OriginalCallKind {
    fn signature(self, module: &Module) -> TypeId {
        match self {
            Self::Direct(function) => module.funcs.get(function).ty(),
            Self::Indirect { ty, .. } | Self::Ref { ty } => ty,
        }
    }

    fn extra_stack_operands(self) -> usize {
        match self {
            Self::Indirect { .. } | Self::Ref { .. } => 1,
            Self::Direct(_) => 0,
        }
    }

    fn has_reference_callee(self) -> bool {
        matches!(self, Self::Ref { .. })
    }
}

/// One statically typed reference operand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReferenceOperand {
    /// Parameter index for arguments, or stack index for carryovers.
    pub index: usize,
    pub ty: RefType,
}

/// Precision of the operand-stack carryover scan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CarryoverPrecision {
    Exact,
    /// At least one carryover slot had a producer this bounded scanner could
    /// not type.  Consumers must not interpret an empty reference list as a
    /// proof that no reference is carried.
    ContainsUnknownSlots,
    Unavailable,
}

/// Conservative null provenance for a reference local.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReferenceNullability {
    DefinitelyNull,
    MaybeNonNull,
}

impl ReferenceNullability {
    fn join(self, other: Self) -> Self {
        if self == Self::DefinitelyNull && other == Self::DefinitelyNull {
            Self::DefinitelyNull
        } else {
            Self::MaybeNonNull
        }
    }
}

/// Reference facts at one fork-relevant original call.
#[derive(Clone, Debug)]
pub struct ReferenceCallSite {
    pub id: OriginalCallSiteId,
    pub point: OriginalProgramPoint,
    pub kind: OriginalCallKind,
    pub reference_arguments: Vec<ReferenceOperand>,
    pub reference_results: Vec<ReferenceOperand>,
    /// `call_ref` and `return_call_ref` consume a function reference in
    /// addition to the declared function parameters.
    pub has_reference_callee: bool,
    pub reference_carryovers: Vec<ReferenceOperand>,
    pub carryover_precision: CarryoverPrecision,
    /// References needed after the call returns normally.  This is the set a
    /// fork continuation needs after reissuing its active call.
    pub live_ref_locals_on_normal_return: BTreeSet<LocalId>,
    /// References needed on any normal or exceptional successor.  Keeping this
    /// separate makes exceptional CFG coverage testable without making a
    /// throwing-only cleanup value look live on deterministic fork replay.
    pub live_ref_locals_on_any_successor: BTreeSet<LocalId>,
    /// Scalar locals needed on any normal or exceptional successor.  The
    /// frame planner saves only these (plus parameters and pure-replay
    /// inputs) instead of every scalar local the function mentions.
    pub live_scalar_locals_on_any_successor: BTreeSet<LocalId>,
    pub local_nullability_before_call: BTreeMap<LocalId, ReferenceNullability>,
    pub reachable: bool,
}

/// Standalone output for one local function.
#[derive(Clone, Debug)]
pub struct FunctionReferenceAnalysis {
    pub function: FunctionId,
    pub reference_locals: BTreeMap<LocalId, RefType>,
    pub call_sites: Vec<ReferenceCallSite>,
}

/// Analyze reference state for one function.
///
/// Direct calls are selected only when their target is in
/// `fork_path_targets`.  Indirect and reference calls are selected
/// conservatively because their runtime target is not encoded in the
/// instruction.  This mirrors the transform's original-IR landing discovery.
pub fn analyze_function_references(
    module: &Module,
    function: FunctionId,
    fork_path_targets: &HashSet<FunctionId>,
) -> Result<FunctionReferenceAnalysis> {
    let FunctionKind::Local(local) = &module.funcs.get(function).kind else {
        bail!("reference analysis requires a local function");
    };

    let reference_locals = collect_reference_locals(module, local);
    let scalar_locals = collect_scalar_locals(module, local);
    let mut cfg = StructuredCfg::build(module, local, fork_path_targets)?;
    let tracked_references: BTreeSet<LocalId> = reference_locals.keys().copied().collect();
    let reference_liveness = compute_local_liveness(&cfg, &tracked_references);
    let scalar_liveness = compute_local_liveness(&cfg, &scalar_locals);
    let nullability = compute_nullability(module, local, &cfg, &reference_locals);
    annotate_stack_carryovers(module, local, &mut cfg.calls);

    let mut call_sites = Vec::with_capacity(cfg.calls.len());
    for call in cfg.calls {
        let signature = module.types.get(call.kind.signature(module));
        let reference_arguments = signature
            .params()
            .iter()
            .enumerate()
            .filter_map(|(index, ty)| match ty {
                ValType::Ref(ty) => Some(ReferenceOperand { index, ty: *ty }),
                _ => None,
            })
            .collect();
        let reference_results = signature
            .results()
            .iter()
            .enumerate()
            .filter_map(|(index, ty)| match ty {
                ValType::Ref(ty) => Some(ReferenceOperand { index, ty: *ty }),
                _ => None,
            })
            .collect();

        let normal_live = call
            .normal_successor
            .map(|node| reference_liveness.live_in_set(node))
            .unwrap_or_default();
        let state = nullability[call.node].clone();
        call_sites.push(ReferenceCallSite {
            id: call.id,
            point: call.point,
            kind: call.kind,
            reference_arguments,
            reference_results,
            has_reference_callee: call.kind.has_reference_callee(),
            reference_carryovers: call.reference_carryovers,
            carryover_precision: call.carryover_precision,
            live_ref_locals_on_normal_return: normal_live,
            live_ref_locals_on_any_successor: reference_liveness.live_out_set(call.node),
            live_scalar_locals_on_any_successor: scalar_liveness.live_out_set(call.node),
            local_nullability_before_call: state.clone().unwrap_or_default(),
            reachable: state.is_some(),
        });
    }

    Ok(FunctionReferenceAnalysis {
        function,
        reference_locals,
        call_sites,
    })
}

type NodeId = usize;

#[derive(Clone)]
enum ExceptionRegion {
    TryTable(Vec<TryTableCatch>),
    Legacy(Vec<LegacyCatch>),
}

#[derive(Clone, Copy)]
enum SequenceOwner {
    Function { exit: NodeId },
    Linear { continuation: NodeId },
    Loop { continuation: NodeId },
}

struct CfgNode {
    point: Option<OriginalProgramPoint>,
    successors: Vec<NodeId>,
    predecessors: Vec<NodeId>,
    active_exceptions: Vec<ExceptionRegion>,
}

struct PendingCall {
    id: OriginalCallSiteId,
    point: OriginalProgramPoint,
    node: NodeId,
    kind: OriginalCallKind,
    normal_successor: Option<NodeId>,
    reference_carryovers: Vec<ReferenceOperand>,
    carryover_precision: CarryoverPrecision,
}

struct StructuredCfg<'a> {
    local: &'a LocalFunction,
    nodes: Vec<CfgNode>,
    point_nodes: BTreeMap<OriginalProgramPoint, NodeId>,
    sequence_ends: HashMap<InstrSeqId, NodeId>,
    owners: HashMap<InstrSeqId, SequenceOwner>,
    sequence_order: Vec<InstrSeqId>,
    function_exit: NodeId,
    calls: Vec<PendingCall>,
}

impl<'a> StructuredCfg<'a> {
    fn build(
        module: &Module,
        local: &'a LocalFunction,
        fork_path_targets: &HashSet<FunctionId>,
    ) -> Result<Self> {
        let mut cfg = Self {
            local,
            nodes: Vec::new(),
            point_nodes: BTreeMap::new(),
            sequence_ends: HashMap::new(),
            owners: HashMap::new(),
            sequence_order: Vec::new(),
            function_exit: 0,
            calls: Vec::new(),
        };
        cfg.function_exit = cfg.add_node(None, Vec::new());
        let entry = local.entry_block();
        cfg.owners.insert(
            entry,
            SequenceOwner::Function {
                exit: cfg.function_exit,
            },
        );
        cfg.enumerate_sequence(module, entry, Vec::new(), fork_path_targets, &mut 0)?;
        cfg.add_control_flow_edges()?;
        cfg.populate_predecessors();
        Ok(cfg)
    }

    fn add_node(
        &mut self,
        point: Option<OriginalProgramPoint>,
        active_exceptions: Vec<ExceptionRegion>,
    ) -> NodeId {
        let id = self.nodes.len();
        self.nodes.push(CfgNode {
            point,
            successors: Vec::new(),
            predecessors: Vec::new(),
            active_exceptions,
        });
        id
    }

    fn enumerate_sequence(
        &mut self,
        module: &Module,
        sequence: InstrSeqId,
        active_exceptions: Vec<ExceptionRegion>,
        fork_path_targets: &HashSet<FunctionId>,
        next_call_id: &mut u32,
    ) -> Result<()> {
        if self.sequence_ends.contains_key(&sequence) {
            return Ok(());
        }
        self.sequence_order.push(sequence);
        let block = self.local.block(sequence);
        for instruction_index in 0..block.instrs.len() {
            let point = OriginalProgramPoint {
                sequence,
                instruction_index,
            };
            let node = self.add_node(Some(point), active_exceptions.clone());
            self.point_nodes.insert(point, node);
        }
        let end = self.add_node(None, active_exceptions.clone());
        self.sequence_ends.insert(sequence, end);

        // Assign calls in the same parent-before-child DFS order used by the
        // switch transform's original call discovery.
        for (instruction_index, (instruction, _)) in block.instrs.iter().enumerate() {
            let point = OriginalProgramPoint {
                sequence,
                instruction_index,
            };
            let node = self.point_nodes[&point];
            if let Some(kind) = selected_call(instruction, fork_path_targets) {
                self.calls.push(PendingCall {
                    id: OriginalCallSiteId(*next_call_id),
                    point,
                    node,
                    kind,
                    normal_successor: None,
                    reference_carryovers: Vec::new(),
                    carryover_precision: CarryoverPrecision::Unavailable,
                });
                *next_call_id += 1;
            }

            let continuation = self.next_node(sequence, instruction_index);
            match instruction {
                Instr::Block(block) => {
                    self.owners
                        .insert(block.seq, SequenceOwner::Linear { continuation });
                    self.enumerate_sequence(
                        module,
                        block.seq,
                        active_exceptions.clone(),
                        fork_path_targets,
                        next_call_id,
                    )?;
                }
                Instr::Loop(loop_) => {
                    self.owners
                        .insert(loop_.seq, SequenceOwner::Loop { continuation });
                    self.enumerate_sequence(
                        module,
                        loop_.seq,
                        active_exceptions.clone(),
                        fork_path_targets,
                        next_call_id,
                    )?;
                }
                Instr::IfElse(if_else) => {
                    for child in [if_else.consequent, if_else.alternative] {
                        self.owners
                            .insert(child, SequenceOwner::Linear { continuation });
                        self.enumerate_sequence(
                            module,
                            child,
                            active_exceptions.clone(),
                            fork_path_targets,
                            next_call_id,
                        )?;
                    }
                }
                Instr::TryTable(try_table) => {
                    self.owners
                        .insert(try_table.seq, SequenceOwner::Linear { continuation });
                    let mut nested = active_exceptions.clone();
                    nested.push(ExceptionRegion::TryTable(try_table.catches.clone()));
                    self.enumerate_sequence(
                        module,
                        try_table.seq,
                        nested,
                        fork_path_targets,
                        next_call_id,
                    )?;
                }
                Instr::Try(try_) => {
                    self.owners
                        .insert(try_.seq, SequenceOwner::Linear { continuation });
                    let mut nested = active_exceptions.clone();
                    nested.push(ExceptionRegion::Legacy(try_.catches.clone()));
                    self.enumerate_sequence(
                        module,
                        try_.seq,
                        nested,
                        fork_path_targets,
                        next_call_id,
                    )?;
                    for catch in &try_.catches {
                        let handler = match catch {
                            LegacyCatch::Catch { handler, .. }
                            | LegacyCatch::CatchAll { handler } => *handler,
                            LegacyCatch::Delegate { .. } => continue,
                        };
                        self.owners
                            .insert(handler, SequenceOwner::Linear { continuation });
                        // Exceptions in a handler propagate to the enclosing
                        // region, not to a later clause of the same legacy try.
                        self.enumerate_sequence(
                            module,
                            handler,
                            active_exceptions.clone(),
                            fork_path_targets,
                            next_call_id,
                        )?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn next_node(&self, sequence: InstrSeqId, instruction_index: usize) -> NodeId {
        let point = OriginalProgramPoint {
            sequence,
            instruction_index: instruction_index + 1,
        };
        self.point_nodes
            .get(&point)
            .copied()
            .unwrap_or(self.sequence_ends[&sequence])
    }

    fn sequence_entry(&self, sequence: InstrSeqId) -> NodeId {
        self.point_nodes
            .get(&OriginalProgramPoint {
                sequence,
                instruction_index: 0,
            })
            .copied()
            .unwrap_or(self.sequence_ends[&sequence])
    }

    fn label_target(&self, sequence: InstrSeqId) -> Result<NodeId> {
        let Some(owner) = self.owners.get(&sequence).copied() else {
            bail!("branch references an unowned instruction sequence");
        };
        Ok(match owner {
            SequenceOwner::Function { exit } => exit,
            SequenceOwner::Linear { continuation } => continuation,
            SequenceOwner::Loop { .. } => self.sequence_entry(sequence),
        })
    }

    fn normal_completion(&self, sequence: InstrSeqId) -> Result<NodeId> {
        let Some(owner) = self.owners.get(&sequence).copied() else {
            bail!("instruction sequence has no structural owner");
        };
        Ok(match owner {
            SequenceOwner::Function { exit } => exit,
            SequenceOwner::Linear { continuation } | SequenceOwner::Loop { continuation } => {
                continuation
            }
        })
    }

    fn add_edge(&mut self, from: NodeId, to: NodeId) {
        if !self.nodes[from].successors.contains(&to) {
            self.nodes[from].successors.push(to);
        }
    }

    fn add_control_flow_edges(&mut self) -> Result<()> {
        let sequences = self.sequence_order.clone();
        for sequence in sequences {
            let end = self.sequence_ends[&sequence];
            let completion = self.normal_completion(sequence)?;
            self.add_edge(end, completion);

            let instruction_count = self.local.block(sequence).instrs.len();
            for instruction_index in 0..instruction_count {
                let point = OriginalProgramPoint {
                    sequence,
                    instruction_index,
                };
                let node = self.point_nodes[&point];
                let next = self.next_node(sequence, instruction_index);
                let instruction = &self.local.block(sequence).instrs[instruction_index].0;

                match instruction {
                    Instr::Block(block) => self.add_edge(node, self.sequence_entry(block.seq)),
                    Instr::Loop(loop_) => self.add_edge(node, self.sequence_entry(loop_.seq)),
                    Instr::IfElse(if_else) => {
                        self.add_edge(node, self.sequence_entry(if_else.consequent));
                        self.add_edge(node, self.sequence_entry(if_else.alternative));
                    }
                    Instr::TryTable(try_table) => {
                        self.add_edge(node, self.sequence_entry(try_table.seq));
                    }
                    Instr::Try(try_) => self.add_edge(node, self.sequence_entry(try_.seq)),
                    Instr::Br(branch) => self.add_edge(node, self.label_target(branch.block)?),
                    Instr::BrIf(branch) => {
                        self.add_edge(node, self.label_target(branch.block)?);
                        self.add_edge(node, next);
                    }
                    Instr::BrTable(table) => {
                        for &target in table.blocks.iter() {
                            self.add_edge(node, self.label_target(target)?);
                        }
                        self.add_edge(node, self.label_target(table.default)?);
                    }
                    Instr::BrOnNull(branch) => {
                        self.add_edge(node, self.label_target(branch.block)?);
                        self.add_edge(node, next);
                    }
                    Instr::BrOnNonNull(branch) => {
                        self.add_edge(node, self.label_target(branch.block)?);
                        self.add_edge(node, next);
                    }
                    Instr::BrOnCast(branch) => {
                        self.add_edge(node, self.label_target(branch.block)?);
                        self.add_edge(node, next);
                    }
                    Instr::BrOnCastFail(branch) => {
                        self.add_edge(node, self.label_target(branch.block)?);
                        self.add_edge(node, next);
                    }
                    Instr::Call(_) | Instr::CallIndirect(_) | Instr::CallRef(_) => {
                        self.add_edge(node, next);
                        for target in self.exception_successors(node, None)? {
                            self.add_edge(node, target);
                        }
                    }
                    Instr::ReturnCall(_)
                    | Instr::ReturnCallIndirect(_)
                    | Instr::ReturnCallRef(_)
                    | Instr::Return(_) => self.add_edge(node, self.function_exit),
                    Instr::Throw(throw_) => {
                        for target in self.exception_successors(node, Some(throw_.tag))? {
                            self.add_edge(node, target);
                        }
                    }
                    Instr::ThrowRef(_) | Instr::Rethrow(_) => {
                        for target in self.exception_successors(node, None)? {
                            self.add_edge(node, target);
                        }
                    }
                    Instr::Unreachable(_) => {}
                    _ => self.add_edge(node, next),
                }
            }
        }

        let normal_successors: HashMap<NodeId, NodeId> = self
            .calls
            .iter()
            .filter_map(|call| {
                Some((
                    call.node,
                    self.next_node(call.point.sequence, call.point.instruction_index),
                ))
            })
            .collect();
        for call in &mut self.calls {
            call.normal_successor = normal_successors.get(&call.node).copied();
        }
        Ok(())
    }

    fn exception_successors(&self, node: NodeId, tag: Option<TagId>) -> Result<Vec<NodeId>> {
        let mut targets = BTreeSet::new();
        for region in self.nodes[node].active_exceptions.iter().rev() {
            match region {
                ExceptionRegion::TryTable(catches) => {
                    let mut catches_all = false;
                    for catch in catches {
                        let (matches_tag, is_all, label) = match catch {
                            TryTableCatch::Catch { tag: caught, label }
                            | TryTableCatch::CatchRef { tag: caught, label } => {
                                (tag.is_none_or(|tag| tag == *caught), false, *label)
                            }
                            TryTableCatch::CatchAll { label }
                            | TryTableCatch::CatchAllRef { label } => (true, true, *label),
                        };
                        if matches_tag {
                            targets.insert(self.label_target(label)?);
                            if tag.is_some() || is_all {
                                catches_all = true;
                                break;
                            }
                        }
                    }
                    if catches_all {
                        return Ok(targets.into_iter().collect());
                    }
                }
                ExceptionRegion::Legacy(catches) => {
                    let mut catches_all = false;
                    for catch in catches {
                        match catch {
                            LegacyCatch::Catch {
                                tag: caught,
                                handler,
                            } if tag.is_none_or(|tag| tag == *caught) => {
                                targets.insert(self.sequence_entry(*handler));
                                if tag.is_some() {
                                    catches_all = true;
                                    break;
                                }
                            }
                            LegacyCatch::CatchAll { handler } => {
                                targets.insert(self.sequence_entry(*handler));
                                catches_all = true;
                                break;
                            }
                            LegacyCatch::Catch { .. } | LegacyCatch::Delegate { .. } => {}
                        }
                    }
                    if catches_all {
                        return Ok(targets.into_iter().collect());
                    }
                }
            }
        }
        Ok(targets.into_iter().collect())
    }

    fn populate_predecessors(&mut self) {
        for node in 0..self.nodes.len() {
            let successors = self.nodes[node].successors.clone();
            for successor in successors {
                self.nodes[successor].predecessors.push(node);
            }
        }
    }
}

fn selected_call(
    instruction: &Instr,
    fork_path_targets: &HashSet<FunctionId>,
) -> Option<OriginalCallKind> {
    match instruction {
        Instr::Call(call) if fork_path_targets.contains(&call.func) => {
            Some(OriginalCallKind::Direct(call.func))
        }
        Instr::CallIndirect(call) => Some(OriginalCallKind::Indirect {
            table: call.table,
            ty: call.ty,
        }),
        Instr::CallRef(call) => Some(OriginalCallKind::Ref { ty: call.ty }),
        _ => None,
    }
}

fn collect_reference_locals(module: &Module, local: &LocalFunction) -> BTreeMap<LocalId, RefType> {
    struct Collector {
        locals: BTreeSet<LocalId>,
    }

    impl<'a> walrus::ir::Visitor<'a> for Collector {
        fn visit_local_id(&mut self, local: &LocalId) {
            self.locals.insert(*local);
        }
    }

    let mut collector = Collector {
        locals: local.args.iter().copied().collect(),
    };
    walrus::ir::dfs_in_order(&mut collector, local, local.entry_block());
    collector
        .locals
        .into_iter()
        .filter_map(|local| match module.locals.get(local).ty() {
            ValType::Ref(ty) => Some((local, ty)),
            _ => None,
        })
        .collect()
}

fn collect_scalar_locals(module: &Module, local: &LocalFunction) -> BTreeSet<LocalId> {
    struct Collector {
        locals: BTreeSet<LocalId>,
    }

    impl<'a> walrus::ir::Visitor<'a> for Collector {
        fn visit_local_id(&mut self, local: &LocalId) {
            self.locals.insert(*local);
        }
    }

    let mut collector = Collector {
        locals: local.args.iter().copied().collect(),
    };
    walrus::ir::dfs_in_order(&mut collector, local, local.entry_block());
    collector
        .locals
        .into_iter()
        .filter(|local| !matches!(module.locals.get(*local).ty(), ValType::Ref(_)))
        .collect()
}

/// Per-node liveness stored as dense bitsets over the tracked locals.  A
/// giant function can track thousands of scalar locals across tens of
/// thousands of CFG nodes; one `BTreeSet<LocalId>` per node at that scale
/// costs gigabytes, while one bit per tracked local costs megabytes.
struct LocalLiveness {
    tracked: Vec<LocalId>,
    words_per_node: usize,
    live_in: Vec<u64>,
    live_out: Vec<u64>,
}

impl LocalLiveness {
    fn live_in_set(&self, node: NodeId) -> BTreeSet<LocalId> {
        self.decode(&self.live_in[node * self.words_per_node..][..self.words_per_node])
    }

    fn live_out_set(&self, node: NodeId) -> BTreeSet<LocalId> {
        self.decode(&self.live_out[node * self.words_per_node..][..self.words_per_node])
    }

    fn decode(&self, words: &[u64]) -> BTreeSet<LocalId> {
        let mut set = BTreeSet::new();
        for (word_index, &word) in words.iter().enumerate() {
            let mut bits = word;
            while bits != 0 {
                let bit = bits.trailing_zeros() as usize;
                set.insert(self.tracked[word_index * 64 + bit]);
                bits &= bits - 1;
            }
        }
        set
    }
}

fn compute_local_liveness(
    cfg: &StructuredCfg<'_>,
    tracked_locals: &BTreeSet<LocalId>,
) -> LocalLiveness {
    let tracked: Vec<LocalId> = tracked_locals.iter().copied().collect();
    let bit_of: BTreeMap<LocalId, usize> = tracked
        .iter()
        .enumerate()
        .map(|(bit, &local)| (local, bit))
        .collect();
    let words_per_node = tracked.len().div_ceil(64);
    let uses_and_defs: Vec<(Option<usize>, Option<usize>)> = (0..cfg.nodes.len())
        .map(|node| {
            let (used, defined) = cfg.nodes[node]
                .point
                .map(|point| local_uses_and_defs(cfg.local, point, tracked_locals))
                .unwrap_or_default();
            (
                used.first().map(|local| bit_of[local]),
                defined.map(|local| bit_of[&local]),
            )
        })
        .collect();

    let mut live_in = vec![0u64; cfg.nodes.len() * words_per_node];
    let mut live_out = vec![0u64; cfg.nodes.len() * words_per_node];
    let mut next = vec![0u64; words_per_node];

    loop {
        let mut changed = false;
        for node in (0..cfg.nodes.len()).rev() {
            next.fill(0);
            for &successor in &cfg.nodes[node].successors {
                let successor_in = &live_in[successor * words_per_node..][..words_per_node];
                for (word, &successor_word) in next.iter_mut().zip(successor_in) {
                    *word |= successor_word;
                }
            }
            let out_words = &mut live_out[node * words_per_node..][..words_per_node];
            if out_words != next.as_slice() {
                out_words.copy_from_slice(&next);
                changed = true;
            }
            let (used, defined) = uses_and_defs[node];
            if let Some(bit) = defined {
                next[bit / 64] &= !(1u64 << (bit % 64));
            }
            if let Some(bit) = used {
                next[bit / 64] |= 1u64 << (bit % 64);
            }
            let in_words = &mut live_in[node * words_per_node..][..words_per_node];
            if in_words != next.as_slice() {
                in_words.copy_from_slice(&next);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    LocalLiveness {
        tracked,
        words_per_node,
        live_in,
        live_out,
    }
}

fn local_uses_and_defs(
    local: &LocalFunction,
    point: OriginalProgramPoint,
    tracked_locals: &BTreeSet<LocalId>,
) -> (BTreeSet<LocalId>, Option<LocalId>) {
    let instruction = &local.block(point.sequence).instrs[point.instruction_index].0;
    match instruction {
        Instr::LocalGet(get) if tracked_locals.contains(&get.local) => {
            (BTreeSet::from([get.local]), None)
        }
        Instr::LocalSet(set) if tracked_locals.contains(&set.local) => {
            (BTreeSet::new(), Some(set.local))
        }
        Instr::LocalTee(tee) if tracked_locals.contains(&tee.local) => {
            (BTreeSet::new(), Some(tee.local))
        }
        _ => (BTreeSet::new(), None),
    }
}

type NullState = BTreeMap<LocalId, ReferenceNullability>;

fn compute_nullability(
    module: &Module,
    local: &LocalFunction,
    cfg: &StructuredCfg<'_>,
    reference_locals: &BTreeMap<LocalId, RefType>,
) -> Vec<Option<NullState>> {
    let args: BTreeSet<LocalId> = local.args.iter().copied().collect();
    let initial: NullState = reference_locals
        .iter()
        .map(|(&local, ty)| {
            let state = if !args.contains(&local) && ty.nullable {
                ReferenceNullability::DefinitelyNull
            } else {
                ReferenceNullability::MaybeNonNull
            };
            (local, state)
        })
        .collect();
    let entry = cfg.sequence_entry(local.entry_block());
    let mut states = vec![None; cfg.nodes.len()];
    states[entry] = Some(initial);
    let mut queue = VecDeque::from([entry]);

    while let Some(node) = queue.pop_front() {
        let Some(input) = states[node].clone() else {
            continue;
        };
        let output = transfer_nullability(module, local, cfg, node, input, reference_locals);
        for &successor in &cfg.nodes[node].successors {
            let candidate = refine_nullability_edge(local, cfg, node, successor, output.clone());
            let changed = match &mut states[successor] {
                Some(existing) => join_null_states(existing, &candidate),
                slot @ None => {
                    *slot = Some(candidate);
                    true
                }
            };
            if changed {
                queue.push_back(successor);
            }
        }
    }
    states
}

fn transfer_nullability(
    module: &Module,
    local: &LocalFunction,
    cfg: &StructuredCfg<'_>,
    node: NodeId,
    mut state: NullState,
    reference_locals: &BTreeMap<LocalId, RefType>,
) -> NullState {
    let Some(point) = cfg.nodes[node].point else {
        return state;
    };
    let instruction = &local.block(point.sequence).instrs[point.instruction_index].0;
    let target = match instruction {
        Instr::LocalSet(set) if reference_locals.contains_key(&set.local) => Some(set.local),
        Instr::LocalTee(tee) if reference_locals.contains_key(&tee.local) => Some(tee.local),
        _ => None,
    };
    if let Some(target) = target {
        let value = classify_reference_assignment(module, local, cfg, node, &state);
        state.insert(target, value);
    }
    state
}

fn classify_reference_assignment(
    module: &Module,
    local: &LocalFunction,
    cfg: &StructuredCfg<'_>,
    node: NodeId,
    state: &NullState,
) -> ReferenceNullability {
    let point = cfg.nodes[node].point.expect("instruction node");
    if point.instruction_index == 0 {
        return ReferenceNullability::MaybeNonNull;
    }
    let producer_point = OriginalProgramPoint {
        sequence: point.sequence,
        instruction_index: point.instruction_index - 1,
    };
    let producer_node = cfg.point_nodes[&producer_point];
    // A catch or branch can land on the assignment with values that did not
    // come from the lexically previous instruction.  In that case syntax is
    // not provenance; retain the conservative state.
    if cfg.nodes[node].predecessors.as_slice() != [producer_node] {
        return ReferenceNullability::MaybeNonNull;
    }
    match &local.block(point.sequence).instrs[point.instruction_index - 1].0 {
        Instr::RefNull(_) => ReferenceNullability::DefinitelyNull,
        Instr::LocalGet(get) => state
            .get(&get.local)
            .copied()
            .unwrap_or(ReferenceNullability::MaybeNonNull),
        Instr::RefFunc(_)
        | Instr::RefI31(_)
        | Instr::StructNew(_)
        | Instr::StructNewDefault(_)
        | Instr::ArrayNew(_)
        | Instr::ArrayNewDefault(_)
        | Instr::ArrayNewFixed(_)
        | Instr::ArrayNewData(_)
        | Instr::ArrayNewElem(_) => ReferenceNullability::MaybeNonNull,
        Instr::GlobalGet(get) if matches!(module.globals.get(get.global).ty, ValType::Ref(_)) => {
            ReferenceNullability::MaybeNonNull
        }
        _ => ReferenceNullability::MaybeNonNull,
    }
}

fn refine_nullability_edge(
    local: &LocalFunction,
    cfg: &StructuredCfg<'_>,
    node: NodeId,
    successor: NodeId,
    mut state: NullState,
) -> NullState {
    let Some(point) = cfg.nodes[node].point else {
        return state;
    };
    let instruction = &local.block(point.sequence).instrs[point.instruction_index].0;
    let preceding_local = || {
        point.instruction_index.checked_sub(1).and_then(|index| {
            match &local.block(point.sequence).instrs[index].0 {
                Instr::LocalGet(get) => Some(get.local),
                _ => None,
            }
        })
    };
    match instruction {
        Instr::BrOnNull(branch) if successor == cfg.label_target(branch.block).ok().unwrap() => {
            if let Some(local) = preceding_local() {
                state.insert(local, ReferenceNullability::DefinitelyNull);
            }
        }
        Instr::BrOnNonNull(_)
            if successor == cfg.next_node(point.sequence, point.instruction_index) =>
        {
            if let Some(local) = preceding_local() {
                state.insert(local, ReferenceNullability::DefinitelyNull);
            }
        }
        Instr::BrIf(branch) => {
            if point.instruction_index >= 2
                && matches!(
                    local.block(point.sequence).instrs[point.instruction_index - 1].0,
                    Instr::RefIsNull(_)
                )
                && successor == cfg.label_target(branch.block).ok().unwrap()
            {
                if let Instr::LocalGet(get) =
                    &local.block(point.sequence).instrs[point.instruction_index - 2].0
                {
                    state.insert(get.local, ReferenceNullability::DefinitelyNull);
                }
            }
        }
        Instr::IfElse(if_else) => {
            if point.instruction_index >= 2
                && matches!(
                    local.block(point.sequence).instrs[point.instruction_index - 1].0,
                    Instr::RefIsNull(_)
                )
                && successor == cfg.sequence_entry(if_else.consequent)
            {
                if let Instr::LocalGet(get) =
                    &local.block(point.sequence).instrs[point.instruction_index - 2].0
                {
                    state.insert(get.local, ReferenceNullability::DefinitelyNull);
                }
            }
        }
        _ => {}
    }
    state
}

fn join_null_states(existing: &mut NullState, incoming: &NullState) -> bool {
    let mut changed = false;
    for (&local, &incoming) in incoming {
        let current = existing
            .get(&local)
            .copied()
            .unwrap_or(ReferenceNullability::MaybeNonNull);
        let joined = current.join(incoming);
        if joined != current {
            existing.insert(local, joined);
            changed = true;
        }
    }
    changed
}

fn annotate_stack_carryovers(module: &Module, local: &LocalFunction, calls: &mut [PendingCall]) {
    let mut by_point: BTreeMap<OriginalProgramPoint, usize> = calls
        .iter()
        .enumerate()
        .map(|(index, call)| (call.point, index))
        .collect();
    let mut seen = HashSet::new();
    scan_sequence_stack(
        module,
        local,
        local.entry_block(),
        calls,
        &mut by_point,
        &mut seen,
    );
}

fn scan_sequence_stack(
    module: &Module,
    local: &LocalFunction,
    sequence: InstrSeqId,
    calls: &mut [PendingCall],
    by_point: &mut BTreeMap<OriginalProgramPoint, usize>,
    seen: &mut HashSet<InstrSeqId>,
) {
    if !seen.insert(sequence) {
        return;
    }
    let mut stack = Some(sequence_params(module, local, sequence));
    for (instruction_index, (instruction, _)) in local.block(sequence).instrs.iter().enumerate() {
        let point = OriginalProgramPoint {
            sequence,
            instruction_index,
        };
        if let Some(&call_index) = by_point.get(&point) {
            let call = &mut calls[call_index];
            let signature = module.types.get(call.kind.signature(module));
            let consumed = signature.params().len() + call.kind.extra_stack_operands();
            match &stack {
                Some(stack) if stack.len() >= consumed => {
                    let carryovers = &stack[..stack.len() - consumed];
                    call.reference_carryovers = carryovers
                        .iter()
                        .enumerate()
                        .filter_map(|(index, ty)| match ty {
                            Some(ValType::Ref(ty)) => Some(ReferenceOperand { index, ty: *ty }),
                            _ => None,
                        })
                        .collect();
                    call.carryover_precision = if carryovers.iter().any(Option::is_none) {
                        CarryoverPrecision::ContainsUnknownSlots
                    } else {
                        CarryoverPrecision::Exact
                    };
                }
                _ => call.carryover_precision = CarryoverPrecision::Unavailable,
            }
        }

        stack = apply_stack_effect(module, local, instruction, stack);
        for child in nested_sequences(instruction) {
            scan_sequence_stack(module, local, child, calls, by_point, seen);
        }
    }
}

fn sequence_params(
    module: &Module,
    local: &LocalFunction,
    sequence: InstrSeqId,
) -> Vec<Option<ValType>> {
    match local.block(sequence).ty {
        InstrSeqType::MultiValue(ty) => module
            .types
            .get(ty)
            .params()
            .iter()
            .copied()
            .map(Some)
            .collect(),
        InstrSeqType::Simple(_) => Vec::new(),
    }
}

enum BoundedStackEffect {
    Delta {
        pops: usize,
        pushes: Vec<Option<ValType>>,
    },
    Terminator,
    Unknown,
}

fn apply_stack_effect(
    module: &Module,
    local: &LocalFunction,
    instruction: &Instr,
    stack: Option<Vec<Option<ValType>>>,
) -> Option<Vec<Option<ValType>>> {
    let mut stack = stack?;
    match bounded_stack_effect(module, local, instruction, &stack) {
        BoundedStackEffect::Delta { pops, pushes } if stack.len() >= pops => {
            stack.truncate(stack.len() - pops);
            stack.extend(pushes);
            Some(stack)
        }
        BoundedStackEffect::Delta { .. }
        | BoundedStackEffect::Terminator
        | BoundedStackEffect::Unknown => None,
    }
}

fn bounded_stack_effect(
    module: &Module,
    local: &LocalFunction,
    instruction: &Instr,
    pre_stack: &[Option<ValType>],
) -> BoundedStackEffect {
    use BoundedStackEffect::{Delta, Terminator, Unknown};
    let unknown = |pops, pushes| Delta {
        pops,
        pushes: vec![None; pushes],
    };
    let exact = |pops, pushes: Vec<ValType>| Delta {
        pops,
        pushes: pushes.into_iter().map(Some).collect(),
    };
    match instruction {
        Instr::Const(constant) => exact(
            0,
            vec![match constant.value {
                Value::I32(_) => ValType::I32,
                Value::I64(_) => ValType::I64,
                Value::F32(_) => ValType::F32,
                Value::F64(_) => ValType::F64,
                Value::V128(_) => ValType::V128,
            }],
        ),
        Instr::LocalGet(get) => exact(0, vec![module.locals.get(get.local).ty()]),
        Instr::LocalSet(_) | Instr::GlobalSet(_) | Instr::Drop(_) => exact(1, vec![]),
        Instr::LocalTee(tee) => exact(1, vec![module.locals.get(tee.local).ty()]),
        Instr::GlobalGet(get) => exact(0, vec![module.globals.get(get.global).ty]),
        Instr::RefNull(null) => exact(0, vec![ValType::Ref(null.ty)]),
        Instr::RefFunc(reference) => exact(
            0,
            vec![ValType::Ref(RefType {
                nullable: false,
                heap_type: HeapType::Concrete(module.funcs.get(reference.func).ty()),
            })],
        ),
        Instr::RefI31(_) => exact(
            1,
            vec![ValType::Ref(RefType {
                nullable: false,
                heap_type: HeapType::Abstract(AbstractHeapType::I31),
            })],
        ),
        Instr::RefAsNonNull(_) => {
            let ty = pre_stack.last().copied().flatten().map(|ty| match ty {
                ValType::Ref(mut reference) => {
                    reference.nullable = false;
                    ValType::Ref(reference)
                }
                scalar => scalar,
            });
            Delta {
                pops: 1,
                pushes: vec![ty],
            }
        }
        Instr::RefCast(cast) => exact(
            1,
            vec![ValType::Ref(RefType {
                nullable: cast.nullable,
                heap_type: cast.heap_type,
            })],
        ),
        Instr::AnyConvertExtern(_) => exact(1, vec![ValType::Ref(RefType::ANYREF)]),
        Instr::ExternConvertAny(_) => exact(1, vec![ValType::Ref(RefType::EXTERNREF)]),
        Instr::RefIsNull(_) | Instr::RefTest(_) => exact(1, vec![ValType::I32]),
        Instr::RefEq(_) => exact(2, vec![ValType::I32]),
        Instr::I31GetS(_) | Instr::I31GetU(_) => exact(1, vec![ValType::I32]),
        Instr::StructNew(new) => exact(
            module.types.get(new.ty).kind().unwrap_struct().fields.len(),
            vec![concrete_non_null_ref(new.ty)],
        ),
        Instr::StructNewDefault(new) => exact(0, vec![concrete_non_null_ref(new.ty)]),
        Instr::StructGet(get) => exact(
            1,
            vec![
                module.types.get(get.ty).kind().unwrap_struct().fields[get.field as usize]
                    .element_type
                    .unpack(),
            ],
        ),
        Instr::StructGetS(_) | Instr::StructGetU(_) => exact(1, vec![ValType::I32]),
        Instr::StructSet(_) => exact(2, vec![]),
        Instr::ArrayNew(new) => exact(2, vec![concrete_non_null_ref(new.ty)]),
        Instr::ArrayNewDefault(new) => exact(1, vec![concrete_non_null_ref(new.ty)]),
        Instr::ArrayNewFixed(new) => exact(new.len as usize, vec![concrete_non_null_ref(new.ty)]),
        Instr::ArrayNewData(new) => exact(2, vec![concrete_non_null_ref(new.ty)]),
        Instr::ArrayNewElem(new) => exact(2, vec![concrete_non_null_ref(new.ty)]),
        Instr::ArrayGet(get) => exact(
            2,
            vec![
                module
                    .types
                    .get(get.ty)
                    .kind()
                    .unwrap_array()
                    .field
                    .element_type
                    .unpack(),
            ],
        ),
        Instr::ArrayGetS(_) | Instr::ArrayGetU(_) => exact(2, vec![ValType::I32]),
        Instr::ArraySet(_) => exact(3, vec![]),
        Instr::ArrayLen(_) => exact(1, vec![ValType::I32]),
        Instr::ArrayFill(_) => exact(4, vec![]),
        Instr::ArrayCopy(_) => exact(5, vec![]),
        Instr::ArrayInitData(_) | Instr::ArrayInitElem(_) => exact(4, vec![]),
        Instr::TableGet(get) => exact(
            1,
            vec![ValType::Ref(module.tables.get(get.table).element_ty)],
        ),
        Instr::Call(call) => {
            let signature = module.types.get(module.funcs.get(call.func).ty());
            exact(signature.params().len(), signature.results().to_vec())
        }
        Instr::CallIndirect(call) => {
            let signature = module.types.get(call.ty);
            exact(signature.params().len() + 1, signature.results().to_vec())
        }
        Instr::CallRef(call) => {
            let signature = module.types.get(call.ty);
            exact(signature.params().len() + 1, signature.results().to_vec())
        }
        Instr::Block(block) => structured_effect(module, local, block.seq, 0),
        Instr::Loop(loop_) => structured_effect(module, local, loop_.seq, 0),
        Instr::IfElse(if_else) => structured_effect(module, local, if_else.consequent, 1),
        Instr::TryTable(try_table) => structured_effect(module, local, try_table.seq, 0),
        Instr::Try(try_) => structured_effect(module, local, try_.seq, 0),
        Instr::BrIf(_) => exact(1, vec![]),
        Instr::BrOnNull(_) => {
            let ty = pre_stack.last().copied().flatten().map(|ty| match ty {
                ValType::Ref(mut reference) => {
                    reference.nullable = false;
                    ValType::Ref(reference)
                }
                scalar => scalar,
            });
            Delta {
                pops: 1,
                pushes: vec![ty],
            }
        }
        Instr::BrOnNonNull(_) => exact(1, vec![]),
        Instr::BrOnCast(cast) => exact(
            1,
            vec![ValType::Ref(RefType {
                nullable: cast.from_nullable,
                heap_type: cast.from_heap_type,
            })],
        ),
        Instr::BrOnCastFail(cast) => exact(
            1,
            vec![ValType::Ref(RefType {
                nullable: cast.to_nullable,
                heap_type: cast.to_heap_type,
            })],
        ),
        Instr::Load(load) => exact(1, vec![load_type(load.kind)]),
        Instr::LoadSimd(_) => exact(1, vec![ValType::V128]),
        Instr::Store(_) | Instr::TableSet(_) => exact(2, vec![]),
        Instr::MemorySize(_) | Instr::TableSize(_) => exact(0, vec![ValType::I32]),
        Instr::MemoryGrow(_) => exact(1, vec![ValType::I32]),
        Instr::TableGrow(_) => exact(2, vec![ValType::I32]),
        Instr::Binop(_) => unknown(2, 1),
        Instr::Unop(unary) => exact(1, vec![unary_result_type(&unary.op)]),
        Instr::Select(select) => {
            let ty = select.ty.or_else(|| {
                pre_stack
                    .get(pre_stack.len().saturating_sub(3))
                    .copied()
                    .flatten()
            });
            Delta {
                pops: 3,
                pushes: vec![ty],
            }
        }
        Instr::TernOp(_) | Instr::V128Bitselect { .. } => exact(3, vec![ValType::V128]),
        Instr::AtomicRmw(rmw) => exact(2, vec![atomic_type(rmw.width)]),
        Instr::Cmpxchg(cmp) => exact(3, vec![atomic_type(cmp.width)]),
        Instr::AtomicNotify(_) => exact(2, vec![ValType::I32]),
        Instr::AtomicWait(_) => unknown(3, 1),
        Instr::MemoryFill(_)
        | Instr::MemoryCopy(_)
        | Instr::MemoryInit(_)
        | Instr::TableFill(_)
        | Instr::TableInit(_)
        | Instr::TableCopy(_) => exact(3, vec![]),
        Instr::DataDrop(_) | Instr::ElemDrop(_) | Instr::AtomicFence(_) => exact(0, vec![]),
        Instr::Return(_)
        | Instr::Unreachable(_)
        | Instr::Br(_)
        | Instr::BrTable(_)
        | Instr::ReturnCall(_)
        | Instr::ReturnCallIndirect(_)
        | Instr::ReturnCallRef(_)
        | Instr::Throw(_)
        | Instr::ThrowRef(_)
        | Instr::Rethrow(_) => Terminator,
        _ => Unknown,
    }
}

fn concrete_non_null_ref(ty: TypeId) -> ValType {
    ValType::Ref(RefType {
        nullable: false,
        heap_type: HeapType::Concrete(ty),
    })
}

fn structured_effect(
    module: &Module,
    local: &LocalFunction,
    sequence: InstrSeqId,
    extra_pops: usize,
) -> BoundedStackEffect {
    let (params, results) = sequence_params_results(module, local, sequence);
    BoundedStackEffect::Delta {
        pops: params.len() + extra_pops,
        pushes: results.into_iter().map(Some).collect(),
    }
}

fn sequence_params_results(
    module: &Module,
    local: &LocalFunction,
    sequence: InstrSeqId,
) -> (Vec<ValType>, Vec<ValType>) {
    match local.block(sequence).ty {
        InstrSeqType::Simple(None) => (Vec::new(), Vec::new()),
        InstrSeqType::Simple(Some(result)) => (Vec::new(), vec![result]),
        InstrSeqType::MultiValue(ty) => {
            let ty = module.types.get(ty);
            (ty.params().to_vec(), ty.results().to_vec())
        }
    }
}

fn load_type(kind: LoadKind) -> ValType {
    match kind {
        LoadKind::I32 { .. } | LoadKind::I32_8 { .. } | LoadKind::I32_16 { .. } => ValType::I32,
        LoadKind::I64 { .. }
        | LoadKind::I64_8 { .. }
        | LoadKind::I64_16 { .. }
        | LoadKind::I64_32 { .. } => ValType::I64,
        LoadKind::F32 => ValType::F32,
        LoadKind::F64 => ValType::F64,
        LoadKind::V128 => ValType::V128,
    }
}

fn unary_result_type(op: &UnaryOp) -> ValType {
    let name = format!("{op:?}");
    if name.starts_with("I32") || name == "I64Eqz" {
        ValType::I32
    } else if name.starts_with("I64") {
        ValType::I64
    } else if name.starts_with("F32") {
        ValType::F32
    } else if name.starts_with("F64") {
        ValType::F64
    } else {
        ValType::V128
    }
}

fn atomic_type(width: AtomicWidth) -> ValType {
    match width {
        AtomicWidth::I64 | AtomicWidth::I64_8 | AtomicWidth::I64_16 | AtomicWidth::I64_32 => {
            ValType::I64
        }
        AtomicWidth::I32 | AtomicWidth::I32_8 | AtomicWidth::I32_16 => ValType::I32,
    }
}

fn nested_sequences(instruction: &Instr) -> Vec<InstrSeqId> {
    match instruction {
        Instr::Block(block) => vec![block.seq],
        Instr::Loop(loop_) => vec![loop_.seq],
        Instr::IfElse(if_else) => vec![if_else.consequent, if_else.alternative],
        Instr::TryTable(try_table) => vec![try_table.seq],
        Instr::Try(try_) => {
            let mut sequences = vec![try_.seq];
            for catch in &try_.catches {
                match catch {
                    LegacyCatch::Catch { handler, .. } | LegacyCatch::CatchAll { handler } => {
                        sequences.push(*handler)
                    }
                    LegacyCatch::Delegate { .. } => {}
                }
            }
            sequences
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module_and_functions(
        wat: &str,
        caller: &str,
        targets: &[&str],
    ) -> (Module, FunctionId, HashSet<FunctionId>) {
        let bytes = wat::parse_str(wat).expect("wat parses");
        let module = Module::from_buffer(&bytes).expect("walrus parses");
        let find = |name: &str| {
            module
                .funcs
                .iter()
                .find(|function| function.name.as_deref() == Some(name))
                .unwrap_or_else(|| panic!("function `{name}` exists"))
                .id()
        };
        let caller = find(caller);
        let targets = targets.iter().map(|name| find(name)).collect();
        (module, caller, targets)
    }

    fn only_call(analysis: &FunctionReferenceAnalysis) -> &ReferenceCallSite {
        assert_eq!(analysis.call_sites.len(), 1);
        &analysis.call_sites[0]
    }

    #[test]
    fn dash_style_cleanup_exnref_is_dead_and_null_at_fork() {
        let (module, caller, targets) = module_and_functions(
            r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (tag $cleanup)
              (func $caller
                (local $scratch (ref null exn))
                (block $caught (result exnref)
                  (try_table (result exnref) (catch_all_ref $caught)
                    call $fork
                    drop
                    ref.null exn))
                local.set $scratch
                local.get $scratch
                throw_ref))
            "#,
            "caller",
            &["fork"],
        );
        let analysis = analyze_function_references(&module, caller, &targets).unwrap();
        let call = only_call(&analysis);
        let (&scratch, _) = analysis.reference_locals.iter().next().unwrap();
        assert!(!call.live_ref_locals_on_normal_return.contains(&scratch));
        assert!(!call.live_ref_locals_on_any_successor.contains(&scratch));
        assert_eq!(
            call.local_nullability_before_call[&scratch],
            ReferenceNullability::DefinitelyNull
        );
    }

    #[test]
    fn reference_used_after_fork_is_live() {
        let (module, caller, targets) = module_and_functions(
            r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (func $caller (param $value externref)
                call $fork
                drop
                local.get $value
                drop))
            "#,
            "caller",
            &["fork"],
        );
        let analysis = analyze_function_references(&module, caller, &targets).unwrap();
        let call = only_call(&analysis);
        let (&value, _) = analysis.reference_locals.iter().next().unwrap();
        assert!(call.live_ref_locals_on_normal_return.contains(&value));
        assert_eq!(
            call.local_nullability_before_call[&value],
            ReferenceNullability::MaybeNonNull
        );
    }

    #[test]
    fn reference_arguments_and_carryovers_are_marked_separately() {
        let (module, caller, targets) = module_and_functions(
            r#"
            (module
              (func $takes_ref (param externref) (result i32)
                i32.const 0)
              (func $fork (result i32)
                i32.const 0)
              (func $caller
                ref.null extern
                call $takes_ref
                drop
                ref.null extern
                call $fork
                drop
                drop))
            "#,
            "caller",
            &["takes_ref", "fork"],
        );
        let analysis = analyze_function_references(&module, caller, &targets).unwrap();
        assert_eq!(analysis.call_sites.len(), 2);
        assert_eq!(analysis.call_sites[0].id, OriginalCallSiteId(0));
        assert_eq!(analysis.call_sites[0].reference_arguments.len(), 1);
        assert!(analysis.call_sites[0].reference_carryovers.is_empty());
        assert!(analysis.call_sites[1].reference_arguments.is_empty());
        assert_eq!(analysis.call_sites[1].reference_carryovers.len(), 1);
        assert_eq!(
            analysis.call_sites[1].carryover_precision,
            CarryoverPrecision::Exact
        );
    }

    #[test]
    fn inline_struct_new_carryover_has_exact_concrete_type() {
        let (module, caller, targets) = module_and_functions(
            r#"
            (module
              (type $pair (struct (field i32) (field i32)))
              (func $fork (result i32)
                i32.const 0)
              (func $caller
                i32.const 23
                i32.const 42
                struct.new $pair
                call $fork
                drop
                drop))
            "#,
            "caller",
            &["fork"],
        );
        let analysis = analyze_function_references(&module, caller, &targets).unwrap();
        let call = only_call(&analysis);
        assert_eq!(call.carryover_precision, CarryoverPrecision::Exact);
        assert_eq!(call.reference_carryovers.len(), 1);
        let HeapType::Concrete(pair) = call.reference_carryovers[0].ty.heap_type else {
            panic!("struct.new must produce a concrete reference");
        };
        assert!(module.types.get(pair).kind().is_struct());
        assert!(!call.reference_carryovers[0].ty.nullable);
    }

    #[test]
    fn gc_reference_field_read_remains_an_exact_carryover() {
        let (module, caller, targets) = module_and_functions(
            r#"
            (module
              (type $pair (struct (field i32)))
              (type $holder (struct (field (ref null $pair))))
              (func $fork (result i32)
                i32.const 0)
              (func $caller (param $holder (ref $holder))
                local.get $holder
                struct.get $holder 0
                call $fork
                drop
                drop))
            "#,
            "caller",
            &["fork"],
        );
        let analysis = analyze_function_references(&module, caller, &targets).unwrap();
        let call = only_call(&analysis);
        assert_eq!(call.carryover_precision, CarryoverPrecision::Exact);
        assert_eq!(call.reference_carryovers.len(), 1);
        let reference = call.reference_carryovers[0].ty;
        assert!(reference.nullable);
        let HeapType::Concrete(pair) = reference.heap_type else {
            panic!("struct.get must preserve the field's concrete reference type");
        };
        assert!(module.types.get(pair).kind().is_struct());
    }

    #[test]
    fn branch_merge_and_null_test_refine_forward_state() {
        let (module, caller, targets) = module_and_functions(
            r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (func $caller (param $value externref) (param $condition i32)
                (local $merged externref)
                local.get $condition
                if
                  local.get $value
                  local.set $merged
                end
                local.get $merged
                ref.is_null
                if
                  call $fork
                  drop
                end))
            "#,
            "caller",
            &["fork"],
        );
        let analysis = analyze_function_references(&module, caller, &targets).unwrap();
        let call = only_call(&analysis);
        let merged = analysis
            .reference_locals
            .keys()
            .copied()
            .find(|local| {
                !module
                    .funcs
                    .get(caller)
                    .kind
                    .unwrap_local()
                    .args
                    .contains(local)
            })
            .unwrap();
        assert_eq!(
            call.local_nullability_before_call[&merged],
            ReferenceNullability::DefinitelyNull
        );
    }

    #[test]
    fn loop_backedge_participates_in_liveness() {
        let (module, caller, targets) = module_and_functions(
            r#"
            (module
              (import "kernel" "kernel_fork" (func $fork (result i32)))
              (func $caller (param $value externref)
                (loop $again
                  call $fork
                  drop
                  local.get $value
                  ref.is_null
                  br_if $again)))
            "#,
            "caller",
            &["fork"],
        );
        let analysis = analyze_function_references(&module, caller, &targets).unwrap();
        let call = only_call(&analysis);
        let (&value, _) = analysis.reference_locals.iter().next().unwrap();
        assert!(call.live_ref_locals_on_normal_return.contains(&value));
    }

    #[test]
    fn try_table_exception_edge_is_distinct_from_normal_return() {
        let (module, caller, targets) = module_and_functions(
            r#"
            (module
              (func $candidate)
              (func $caller (param $value externref)
                (block $done
                  (block $handler
                    (try_table (catch_all $handler)
                      call $candidate
                      br $done))
                  local.get $value
                  drop)))
            "#,
            "caller",
            &["candidate"],
        );
        let analysis = analyze_function_references(&module, caller, &targets).unwrap();
        let call = only_call(&analysis);
        let (&value, _) = analysis.reference_locals.iter().next().unwrap();
        assert!(!call.live_ref_locals_on_normal_return.contains(&value));
        assert!(call.live_ref_locals_on_any_successor.contains(&value));
    }
}
