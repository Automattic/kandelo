//! Call-graph discovery.
//!
//! Given a seed function (typically an imported async function like
//! `kernel.kernel_fork`), computes the set of functions in the module
//! that can transitively reach the seed via calls.
//!
//! Discovery follows direct calls, table-aware indirect calls, and typed
//! function-reference calls to a fixed point. Tail calls are transparent
//! edges: execution can reach the seed through them, but their eliminated
//! caller activation is not reported as live at the suspension point.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use anyhow::{Result, bail};
use walrus::ir::{
    self, BinaryOp, Call, Instr, InstrLocId, InstrSeqId, TableCopy, TableFill, TableGrow,
    TableInit, TableSet, Visitor, dfs_in_order,
};
use walrus::{
    ConstExpr, ElementId, ElementItems, ElementKind, FunctionId, ImportKind, LocalFunction, Module,
    TableId, TypeId,
};

/// Look up a function by its qualified import name (e.g.
/// `"kernel.kernel_fork"`). Returns `None` if the module has no such
/// import or if the import exists but isn't a function.
pub fn find_import_func(module: &Module, qualified_name: &str) -> Option<FunctionId> {
    find_import_funcs(module, qualified_name).into_iter().next()
}

/// Look up every function import with the qualified name.
///
/// WebAssembly permits more than one import declaration to use the same
/// module/name pair (including declarations with distinct function types).
/// Fork reachability must seed all of them: selecting only the first could
/// leave a live caller activation outside the continuation.
pub fn find_import_funcs(module: &Module, qualified_name: &str) -> Vec<FunctionId> {
    let Some((mod_name, field)) = qualified_name.split_once('.') else {
        return Vec::new();
    };
    let mut functions = Vec::new();
    for import in module.imports.iter() {
        if import.module == mod_name && import.name == field {
            if let ImportKind::Function(id) = import.kind {
                functions.push(id);
            }
        }
    }
    functions
}

/// Every function import in deterministic module order.
///
/// A dynamically linked side module can call back into the main image or a
/// different side module through any unresolved function import. The callee
/// may eventually fork even when this module does not itself import
/// `env.fork`, so side-boundary analysis uses all of these functions as roots.
pub fn imported_functions(module: &Module) -> Vec<FunctionId> {
    module
        .imports
        .iter()
        .filter_map(|import| match import.kind {
            ImportKind::Function(id) => Some(id),
            _ => None,
        })
        .collect()
}

fn is_dynamic_linker_function_import(module: &str, name: &str) -> bool {
    module == "env"
        && matches!(
            name,
            "__wasm_dlopen"
                | "__wasm_dlopen_main"
                | "__wasm_dlopen_prepare"
                | "__wasm_dlopen_next"
                | "__wasm_dlopen_commit"
                | "__wasm_dlsym"
                | "__wasm_dlclose"
                | "__wasm_dlerror"
        )
}

fn is_reentrant_dynamic_linker_function_import(module: &str, name: &str) -> bool {
    module == "env" && name == "__wasm_dlopen"
}

/// Legacy host dynamic-linker calls that can synchronously enter guest
/// side-module initialization code.
///
/// ABI 43's prepare/next/commit imports never enter Wasm. Its libc-owned
/// `call_indirect` is analyzed as the real cross-module suspension boundary.
pub fn dynamic_linker_imported_functions(module: &Module) -> Vec<FunctionId> {
    module
        .imports
        .iter()
        .filter_map(|import| {
            if !is_reentrant_dynamic_linker_function_import(
                &import.module,
                &import.name,
            ) {
                return None;
            }
            match import.kind {
                ImportKind::Function(id) => Some(id),
                _ => None,
            }
        })
        .collect()
}

/// The tail-call instruction that needs an ordinary resumable landing before
/// the fork transform can preserve that control-flow edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum TailCallKind {
    Direct,
    Indirect,
    Ref,
}

/// A suspension-capable tail-call site.
///
/// Tail calls do not contribute an activation to [`ReachingAnalysis::activations`].
/// They are reported separately for diagnostics and coverage. Replay preserves
/// them as tail calls and routes directly to the next committed activation,
/// rather than materializing a caller frame that did not exist at capture time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TailCallSite {
    pub caller: FunctionId,
    pub sequence: InstrSeqId,
    pub instruction_index: usize,
    pub kind: TailCallKind,
}

/// Semantic fork reachability plus tail sites that require transform work.
#[derive(Debug)]
pub struct ReachingAnalysis {
    /// Functions whose activations can still be live when `seed` executes.
    /// The seed itself is retained for the existing reporting contract.
    pub activations: HashSet<FunctionId>,
    /// Every function through which control can reach `seed`, including
    /// transparent tail callers whose activations do not survive.
    ///
    /// Instrumentation uses this set to recognize ordinary call sites that can
    /// suspend even when the lexical callee first traverses a tail-call chain.
    pub control_reachable: HashSet<FunctionId>,
    /// Tail edges on a path to the seed. Their caller activation has already
    /// been eliminated, so these sites are not implicitly activations.
    pub tail_call_landings: Vec<TailCallSite>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct ProgramPoint {
    sequence: InstrSeqId,
    instruction_index: usize,
}

/// Walks a single local function, collecting ordinary direct calls and table
/// operations. Dispatch and tail sites need lexical provenance, so they are
/// collected by [`collect_dispatch_calls`] below.
#[derive(Default)]
struct CollectCalls {
    direct: HashSet<FunctionId>,
    table_inits: Vec<(ElementId, TableId)>,
    table_copies: Vec<(TableId, TableId)>,
    dynamic_table_writes: HashSet<TableId>,
}

impl<'a> Visitor<'a> for CollectCalls {
    fn visit_call(&mut self, instr: &Call) {
        self.direct.insert(instr.func);
    }

    fn visit_table_init(&mut self, instr: &TableInit) {
        self.table_inits.push((instr.elem, instr.table));
    }

    fn visit_table_copy(&mut self, instr: &TableCopy) {
        self.table_copies.push((instr.src, instr.dst));
    }

    fn visit_table_set(&mut self, instr: &TableSet) {
        self.dynamic_table_writes.insert(instr.table);
    }

    fn visit_table_fill(&mut self, instr: &TableFill) {
        self.dynamic_table_writes.insert(instr.table);
    }

    fn visit_table_grow(&mut self, instr: &TableGrow) {
        self.dynamic_table_writes.insert(instr.table);
    }
}

/// Per-function analysis: activation-preserving calls, transparent tail calls,
/// and table operations.
struct FuncProfile {
    direct: HashSet<FunctionId>,
    indirect: HashSet<IndirectCall>,
    refs: HashSet<RefCall>,
    tail_direct: Vec<(FunctionId, ProgramPoint)>,
    tail_indirect: Vec<(IndirectCall, ProgramPoint)>,
    tail_refs: Vec<(RefCall, ProgramPoint)>,
    table_inits: Vec<(ElementId, TableId)>,
    table_copies: Vec<(TableId, TableId)>,
    dynamic_table_writes: HashSet<TableId>,
}

fn profile_functions(module: &Module) -> HashMap<FunctionId, FuncProfile> {
    let mut profiles = HashMap::new();
    for (id, func) in module.funcs.iter_local() {
        let mut collector = CollectCalls::default();
        dfs_in_order(&mut collector, func, func.entry_block());
        let dispatch = collect_dispatch_calls(func);
        profiles.insert(
            id,
            FuncProfile {
                direct: collector.direct,
                indirect: dispatch.indirect,
                refs: dispatch.refs,
                tail_direct: dispatch.tail_direct,
                tail_indirect: dispatch.tail_indirect,
                tail_refs: dispatch.tail_refs,
                table_inits: collector.table_inits,
                table_copies: collector.table_copies,
                dynamic_table_writes: collector.dynamic_table_writes,
            },
        );
    }
    profiles
}

/// Build the reverse activation graph for ordinary direct calls.
///
/// Tail calls are intentionally absent: their caller frame no longer exists
/// while the callee executes. Use [`analyze_reaching_closure`] when transparent
/// tail traversal is also required.
pub fn build_reverse_call_graph(module: &Module) -> HashMap<FunctionId, HashSet<FunctionId>> {
    let mut reverse: HashMap<FunctionId, HashSet<FunctionId>> = HashMap::new();
    for (caller_id, profile) in profile_functions(module) {
        for callee in profile.direct {
            reverse.entry(callee).or_default().insert(caller_id);
        }
    }
    reverse
}

/// Compute the surviving activation closure through direct and direct-tail
/// calls. A tail caller is traversed so its own ordinary callers can be found,
/// but is not itself reported unless another non-tail path keeps one of its
/// activations live. Result always includes `seed` itself.
pub fn direct_reaching_closure(module: &Module, seed: FunctionId) -> HashSet<FunctionId> {
    let profiles = profile_functions(module);
    let mut reverse: HashMap<FunctionId, HashSet<FunctionId>> = HashMap::new();
    let mut reverse_tail: HashMap<FunctionId, HashSet<FunctionId>> = HashMap::new();
    for (caller, profile) in &profiles {
        for &callee in &profile.direct {
            reverse.entry(callee).or_default().insert(*caller);
        }
        for &(callee, _) in &profile.tail_direct {
            reverse_tail.entry(callee).or_default().insert(*caller);
        }
    }

    let mut activations = HashSet::new();
    let mut reachable = HashSet::new();
    let mut queue = VecDeque::new();
    activations.insert(seed);
    reachable.insert(seed);
    queue.push_back(seed);
    while let Some(f) = queue.pop_front() {
        if let Some(callers) = reverse.get(&f) {
            for &caller in callers {
                activations.insert(caller);
                if reachable.insert(caller) {
                    queue.push_back(caller);
                }
            }
        }
        if let Some(callers) = reverse_tail.get(&f) {
            for &caller in callers {
                if reachable.insert(caller) {
                    queue.push_back(caller);
                }
            }
        }
    }
    activations
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct IndirectCall {
    table: TableId,
    ty: TypeId,
    index: IndexProof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum IndexProof {
    Const(i32),
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct RefCall {
    ty: TypeId,
    target: RefTargetProof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum RefTargetProof {
    Func(FunctionId),
    Null,
    Unknown,
}

#[derive(Default)]
struct DispatchCalls {
    indirect: HashSet<IndirectCall>,
    refs: HashSet<RefCall>,
    tail_direct: Vec<(FunctionId, ProgramPoint)>,
    tail_indirect: Vec<(IndirectCall, ProgramPoint)>,
    tail_refs: Vec<(RefCall, ProgramPoint)>,
}

fn collect_dispatch_calls(func: &LocalFunction) -> DispatchCalls {
    let mut calls = DispatchCalls::default();
    collect_dispatch_calls_seq(func, func.entry_block(), &mut calls);
    calls
}

fn collect_dispatch_calls_seq(func: &LocalFunction, seq_id: InstrSeqId, calls: &mut DispatchCalls) {
    let instrs = &func.block(seq_id).instrs;
    for (idx, (instr, _)) in instrs.iter().enumerate() {
        let point = ProgramPoint {
            sequence: seq_id,
            instruction_index: idx,
        };
        match instr {
            Instr::CallIndirect(call) => {
                calls.indirect.insert(IndirectCall {
                    table: call.table,
                    ty: call.ty,
                    index: infer_call_indirect_index(&instrs[..idx]),
                });
            }
            Instr::ReturnCallIndirect(call) => {
                calls.tail_indirect.push((
                    IndirectCall {
                        table: call.table,
                        ty: call.ty,
                        index: infer_call_indirect_index(&instrs[..idx]),
                    },
                    point,
                ));
            }
            Instr::CallRef(call) => {
                calls.refs.insert(RefCall {
                    ty: call.ty,
                    target: infer_call_ref_target(&instrs[..idx]),
                });
            }
            Instr::ReturnCallRef(call) => {
                calls.tail_refs.push((
                    RefCall {
                        ty: call.ty,
                        target: infer_call_ref_target(&instrs[..idx]),
                    },
                    point,
                ));
            }
            Instr::ReturnCall(call) => {
                calls.tail_direct.push((call.func, point));
            }
            Instr::Block(ir::Block { seq }) | Instr::Loop(ir::Loop { seq }) => {
                collect_dispatch_calls_seq(func, *seq, calls);
            }
            Instr::IfElse(ir::IfElse {
                consequent,
                alternative,
            }) => {
                collect_dispatch_calls_seq(func, *consequent, calls);
                collect_dispatch_calls_seq(func, *alternative, calls);
            }
            Instr::TryTable(ir::TryTable { seq, .. }) => {
                collect_dispatch_calls_seq(func, *seq, calls);
            }
            Instr::Try(ir::Try { seq, catches }) => {
                collect_dispatch_calls_seq(func, *seq, calls);
                for catch in catches {
                    match catch {
                        ir::LegacyCatch::Catch { handler, .. }
                        | ir::LegacyCatch::CatchAll { handler } => {
                            collect_dispatch_calls_seq(func, *handler, calls);
                        }
                        ir::LegacyCatch::Delegate { .. } => {}
                    }
                }
            }
            _ => {}
        }
    }
}

fn infer_call_ref_target(prefix: &[(Instr, InstrLocId)]) -> RefTargetProof {
    infer_ref_expr(prefix, prefix.len())
        .map(|(proof, _)| proof)
        .unwrap_or(RefTargetProof::Unknown)
}

fn infer_ref_expr(instrs: &[(Instr, InstrLocId)], end: usize) -> Option<(RefTargetProof, usize)> {
    if end == 0 {
        return None;
    }

    let idx = end - 1;
    match &instrs[idx].0 {
        Instr::RefFunc(reference) => Some((RefTargetProof::Func(reference.func), idx)),
        Instr::RefNull(_) => Some((RefTargetProof::Null, idx)),
        // These instructions preserve the identity of the single reference
        // operand. Recovering through them avoids whole-signature fallback for
        // the common typed-ref lowering without pretending local/global values
        // have lexical provenance.
        Instr::RefAsNonNull(_) | Instr::RefCast(_) => infer_ref_expr(instrs, idx),
        _ => Some((RefTargetProof::Unknown, idx)),
    }
}

fn infer_call_indirect_index(prefix: &[(Instr, InstrLocId)]) -> IndexProof {
    infer_i32_expr(prefix, prefix.len())
        .map(|(proof, _)| proof)
        .unwrap_or(IndexProof::Unknown)
}

fn infer_i32_expr(instrs: &[(Instr, InstrLocId)], end: usize) -> Option<(IndexProof, usize)> {
    if end == 0 {
        return None;
    }

    let idx = end - 1;
    match &instrs[idx].0 {
        Instr::Const(ir::Const {
            value: ir::Value::I32(value),
        }) => Some((IndexProof::Const(*value), idx)),
        Instr::Binop(ir::Binop { op }) if matches!(op, BinaryOp::I32Add | BinaryOp::I32Sub) => {
            let (rhs, rhs_start) = infer_i32_expr(instrs, idx)?;
            let (lhs, lhs_start) = infer_i32_expr(instrs, rhs_start)?;
            let proof = match (lhs, rhs, op) {
                (IndexProof::Const(a), IndexProof::Const(b), BinaryOp::I32Add) => {
                    IndexProof::Const(a.wrapping_add(b))
                }
                (IndexProof::Const(a), IndexProof::Const(b), BinaryOp::I32Sub) => {
                    IndexProof::Const(a.wrapping_sub(b))
                }
                _ => IndexProof::Unknown,
            };
            Some((proof, lhs_start))
        }
        _ => Some((IndexProof::Unknown, idx)),
    }
}

/// Extract concrete function references from an element segment's item list.
fn element_functions(items: &ElementItems) -> HashSet<FunctionId> {
    let mut result = HashSet::new();

    match items {
        ElementItems::Functions(ids) => {
            for id in ids {
                result.insert(*id);
            }
        }
        ElementItems::Expressions(_ref_ty, init_exprs) => {
            // An init expression produces one value. For function-ref
            // element segments, LLVM emits `ref.func $f`, which walrus
            // stores as `ConstExpr::RefFunc`.
            for expr in init_exprs {
                result.extend(const_expr_functions(expr));
            }
        }
    }

    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ElementItemRef {
    Func(FunctionId),
    Null,
    Unknown,
}

fn element_item_refs(items: &ElementItems) -> Vec<ElementItemRef> {
    match items {
        ElementItems::Functions(ids) => ids.iter().copied().map(ElementItemRef::Func).collect(),
        ElementItems::Expressions(_ref_ty, init_exprs) => {
            init_exprs.iter().map(const_expr_ref).collect()
        }
    }
}

fn const_expr_ref(expr: &ConstExpr) -> ElementItemRef {
    match expr {
        ConstExpr::RefFunc(f) => ElementItemRef::Func(*f),
        ConstExpr::RefNull(_) => ElementItemRef::Null,
        ConstExpr::Extended(ops) if ops.len() == 1 => match ops[0] {
            walrus::ConstOp::RefFunc(f) => ElementItemRef::Func(f),
            walrus::ConstOp::RefNull(_) => ElementItemRef::Null,
            _ => ElementItemRef::Unknown,
        },
        _ => ElementItemRef::Unknown,
    }
}

fn const_expr_functions(expr: &walrus::ConstExpr) -> HashSet<FunctionId> {
    let mut result = HashSet::new();
    match expr {
        walrus::ConstExpr::RefFunc(f) => {
            result.insert(*f);
        }
        walrus::ConstExpr::Extended(ops) => {
            for op in ops {
                if let walrus::ConstOp::RefFunc(f) = op {
                    result.insert(*f);
                }
            }
        }
        // Other ConstExpr variants (Value, Global, RefNull) don't yield
        // a concrete function.
        _ => {}
    }
    result
}

#[derive(Default)]
struct TableTargets {
    known_slots: HashMap<TableId, HashMap<u32, HashSet<FunctionId>>>,
    known_slot_funcs: HashMap<TableId, HashSet<FunctionId>>,
    unknown_slots: HashMap<TableId, HashSet<u32>>,
    known_table_funcs: HashMap<TableId, HashSet<FunctionId>>,
    unknown_tables: HashSet<TableId>,
}

impl TableTargets {
    fn table_can_dispatch(&self, call: IndirectCall, func: FunctionId) -> bool {
        if self.unknown_tables.contains(&call.table) {
            return true;
        }

        match call.index {
            IndexProof::Const(index) => {
                let slot = index as u32;
                self.known_slots
                    .get(&call.table)
                    .and_then(|slots| slots.get(&slot))
                    .is_some_and(|funcs| funcs.contains(&func))
                    || self
                        .unknown_slots
                        .get(&call.table)
                        .is_some_and(|slots| slots.contains(&slot))
                    || self
                        .known_table_funcs
                        .get(&call.table)
                        .is_some_and(|funcs| funcs.contains(&func))
            }
            IndexProof::Unknown => {
                self.known_slot_funcs
                    .get(&call.table)
                    .is_some_and(|funcs| funcs.contains(&func))
                    || self
                        .unknown_slots
                        .get(&call.table)
                        .is_some_and(|slots| !slots.is_empty())
                    || self
                        .known_table_funcs
                        .get(&call.table)
                        .is_some_and(|funcs| funcs.contains(&func))
            }
        }
    }

    fn add_slot_func(&mut self, table: TableId, slot: u32, func: FunctionId) {
        self.known_slots
            .entry(table)
            .or_default()
            .entry(slot)
            .or_default()
            .insert(func);
        self.known_slot_funcs.entry(table).or_default().insert(func);
    }

    fn add_unknown_slot(&mut self, table: TableId, slot: u32) {
        self.unknown_slots.entry(table).or_default().insert(slot);
    }

    fn add_table_func(&mut self, table: TableId, func: FunctionId) {
        self.known_table_funcs
            .entry(table)
            .or_default()
            .insert(func);
    }

    fn add_table_funcs(&mut self, table: TableId, funcs: impl IntoIterator<Item = FunctionId>) {
        self.known_table_funcs
            .entry(table)
            .or_default()
            .extend(funcs);
    }

    fn table_funcs_from_any_slot(&self, table: TableId) -> HashSet<FunctionId> {
        self.known_slot_funcs
            .get(&table)
            .cloned()
            .unwrap_or_default()
    }
}

fn const_expr_i32(expr: &ConstExpr) -> Option<i32> {
    match expr {
        ConstExpr::Value(walrus::ir::Value::I32(value)) => Some(*value),
        ConstExpr::Extended(ops) => {
            let mut stack = Vec::new();
            for op in ops {
                match op {
                    walrus::ConstOp::I32Const(value) => stack.push(*value),
                    walrus::ConstOp::I32Add => {
                        let rhs = stack.pop()?;
                        let lhs = stack.pop()?;
                        stack.push(lhs.wrapping_add(rhs));
                    }
                    walrus::ConstOp::I32Sub => {
                        let rhs = stack.pop()?;
                        let lhs = stack.pop()?;
                        stack.push(lhs.wrapping_sub(rhs));
                    }
                    walrus::ConstOp::I32Mul => {
                        let rhs = stack.pop()?;
                        let lhs = stack.pop()?;
                        stack.push(lhs.wrapping_mul(rhs));
                    }
                    _ => return None,
                }
            }
            match stack.as_slice() {
                [value] => Some(*value),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Enumerate possible `call_indirect` targets per table.
///
/// Active element segments populate exactly one table and are the common LLVM
/// function-pointer-table case. Passive segments are not table-addressable by
/// themselves; they become possible targets only for tables that the module
/// initializes from that segment with `table.init`. Declared segments never
/// initialize a table, so they are intentionally ignored here.
///
/// Dynamic table writes (`table.set`, `table.fill`, `table.grow`) can place
/// references this static pass cannot recover. For those tables we preserve
/// soundness by treating the table as unknown, so any matching-signature
/// function may be a target. `table.copy` propagates known and unknown target
/// sets from source to destination.
fn table_targets(module: &Module, profiles: &HashMap<FunctionId, FuncProfile>) -> TableTargets {
    let mut targets = TableTargets::default();
    let mut passive_table_inits: HashMap<ElementId, HashSet<TableId>> = HashMap::new();
    let mut table_copies = Vec::new();

    for profile in profiles.values() {
        for &(elem, table) in &profile.table_inits {
            passive_table_inits.entry(elem).or_default().insert(table);
        }
        table_copies.extend(profile.table_copies.iter().copied());
        targets
            .unknown_tables
            .extend(profile.dynamic_table_writes.iter().copied());
    }

    for table in module.tables.iter() {
        if let Some(init) = &table.init {
            targets.add_table_funcs(table.id(), const_expr_functions(init));
        }
    }

    for elem in module.elements.iter() {
        let items = element_item_refs(&elem.items);
        match &elem.kind {
            ElementKind::Active { table, offset } => {
                let Some(base_slot) = const_expr_i32(offset).map(|n| n as u32) else {
                    targets.add_table_funcs(*table, element_functions(&elem.items));
                    if items.iter().any(|item| *item == ElementItemRef::Unknown) {
                        targets.unknown_tables.insert(*table);
                    }
                    continue;
                };
                for (idx, item) in items.iter().enumerate() {
                    let Some(slot) = base_slot.checked_add(idx as u32) else {
                        targets.unknown_tables.insert(*table);
                        continue;
                    };
                    match item {
                        ElementItemRef::Func(func) => targets.add_slot_func(*table, slot, *func),
                        ElementItemRef::Null => {}
                        ElementItemRef::Unknown => targets.add_unknown_slot(*table, slot),
                    }
                }
            }
            ElementKind::Passive => {
                if let Some(tables) = passive_table_inits.get(&elem.id()) {
                    for &table in tables {
                        for item in &items {
                            match item {
                                ElementItemRef::Func(func) => targets.add_table_func(table, *func),
                                ElementItemRef::Null => {}
                                ElementItemRef::Unknown => {
                                    targets.unknown_tables.insert(table);
                                }
                            }
                        }
                    }
                }
            }
            ElementKind::Declared => {}
        }
    }

    let mut changed = true;
    while changed {
        changed = false;
        for &(src, dst) in &table_copies {
            if targets.unknown_tables.contains(&src) && targets.unknown_tables.insert(dst) {
                changed = true;
            }

            if targets
                .unknown_slots
                .get(&src)
                .is_some_and(|slots| !slots.is_empty())
                && targets.unknown_tables.insert(dst)
            {
                changed = true;
            }

            let mut src_funcs = targets
                .known_table_funcs
                .get(&src)
                .cloned()
                .unwrap_or_default();
            src_funcs.extend(targets.table_funcs_from_any_slot(src));
            if !src_funcs.is_empty() {
                let dst_funcs = targets.known_table_funcs.entry(dst).or_default();
                let old_len = dst_funcs.len();
                dst_funcs.extend(src_funcs);
                if dst_funcs.len() != old_len {
                    changed = true;
                }
            }
        }
    }

    targets
}

/// A function's signature, used for comparing against `call_indirect`
/// type indices. Walrus stores each function's type as a `TypeId` on
/// the function itself; looking up the `Type` lets us get its
/// parameters and results.
fn function_type_id(module: &Module, id: FunctionId) -> TypeId {
    module.funcs.get(id).ty()
}

/// Check whether two type ids refer to structurally identical function types.
///
/// Type ids usually match when two functions share a signature, but separate
/// type-section entries can encode the same non-recursive signature.
fn types_match(module: &Module, a: TypeId, b: TypeId) -> bool {
    if a == b {
        return true;
    }
    let ta = module.types.get(a);
    let tb = module.types.get(b);
    ta.params() == tb.params() && ta.results() == tb.results()
}

/// Whether `candidate` can satisfy a dispatch instruction expecting
/// `expected`.
///
/// Typed function references allow a function type to be a declared subtype
/// of the call's expected type. Structural equality remains accepted for
/// duplicate non-recursive type-section entries, matching the historical
/// call-indirect behavior.
fn function_type_is_subtype(module: &Module, candidate: TypeId, expected: TypeId) -> bool {
    let mut current = Some(candidate);
    let mut seen = HashSet::new();
    while let Some(ty) = current {
        if !seen.insert(ty) {
            // Valid Wasm cannot contain a supertype cycle. Keep malformed
            // internal modules finite rather than turning graph discovery into
            // an unbounded walk.
            return false;
        }
        if types_match(module, ty, expected) {
            return true;
        }
        current = module.types.get(ty).supertype;
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FunctionSignature {
    params: Vec<walrus::ValType>,
    results: Vec<walrus::ValType>,
}

fn function_signature(module: &Module, ty: TypeId) -> FunctionSignature {
    let ty = module.types.get(ty);
    FunctionSignature {
        params: ty.params().to_vec(),
        results: ty.results().to_vec(),
    }
}

fn compatible_dispatch_types(
    module: &Module,
    candidate: TypeId,
    dispatch_types_by_signature: &HashMap<FunctionSignature, Vec<TypeId>>,
) -> Vec<TypeId> {
    let mut compatible = HashSet::new();
    let mut current = Some(candidate);
    let mut seen = HashSet::new();
    while let Some(ty) = current {
        if !seen.insert(ty) {
            break;
        }
        if let Some(expected_types) =
            dispatch_types_by_signature.get(&function_signature(module, ty))
        {
            compatible.extend(expected_types.iter().copied());
        }
        current = module.types.get(ty).supertype;
    }
    compatible.into_iter().collect()
}

/// Whether this module can resolve and invoke functions installed by Kandelo's
/// dynamic linker after static call-graph analysis has completed.
///
/// This predicate is also used when emitting the versioned fork capability
/// marker. Keep it as the single source of truth for both the conservative
/// closure below and the artifact claim consumed by the host runtime.
pub fn has_dynamic_linker_imports(module: &Module) -> bool {
    module.imports.iter().any(|import| {
        matches!(import.kind, ImportKind::Function(_))
            && is_dynamic_linker_function_import(&import.module, &import.name)
    })
}

/// Compute semantic fork reachability to a fixed point.
///
/// A function activation `F` can be live at `seed` if any of these hold:
///   (1) `F == seed`
///   (2) `F` ordinarily calls a function whose execution reaches `seed`
///   (3) `F` executes `call_indirect` that can dispatch to such a function
///   (4) `F` executes `call_ref` whose proven or type-compatible target can
///       reach `seed`
///
/// Direct, indirect, and reference edges participate in one worklist until it
/// reaches a fixed point. `return_call*` edges make their callers
/// control-reachable but not activation-live; traversal continues through
/// those transparent nodes so an older ordinary caller is still discovered.
pub fn analyze_reaching_closure(module: &Module, seed: FunctionId) -> ReachingAnalysis {
    analyze_reaching_closure_from_seeds(module, [seed], has_dynamic_linker_imports(module))
}

/// Compute semantic fork reachability from every supplied suspension boundary.
///
/// `external_dynamic_dispatch` means an unresolved `call_indirect` or
/// `call_ref` may enter another module that can fork. This is true for
/// dlopen-capable main modules and for every dynamically linked side module.
/// It broadens instrumentation only; ordinary valid Wasm is never rejected.
pub fn analyze_reaching_closure_from_seeds(
    module: &Module,
    seeds: impl IntoIterator<Item = FunctionId>,
    external_dynamic_dispatch: bool,
) -> ReachingAnalysis {
    let profiles = profile_functions(module);
    let table_targets = table_targets(module, &profiles);

    // Reverse ordinary and transparent direct-call graphs.
    let mut reverse_direct: HashMap<FunctionId, HashSet<FunctionId>> = HashMap::new();
    let mut reverse_tail_direct: HashMap<FunctionId, Vec<(FunctionId, ProgramPoint)>> =
        HashMap::new();
    for (caller, profile) in &profiles {
        for callee in &profile.direct {
            reverse_direct.entry(*callee).or_default().insert(*caller);
        }
        for &(callee, point) in &profile.tail_direct {
            reverse_tail_direct
                .entry(callee)
                .or_default()
                .push((*caller, point));
        }
    }

    // Index dynamic dispatch sites by their expected type. Compatibility is
    // computed once per reached candidate type rather than rescanning every
    // site for every function.
    let mut indirect_callers: HashMap<TypeId, Vec<(IndirectCall, FunctionId)>> = HashMap::new();
    let mut tail_indirect_callers: HashMap<TypeId, Vec<(IndirectCall, FunctionId, ProgramPoint)>> =
        HashMap::new();
    let mut unknown_ref_callers: HashMap<TypeId, HashSet<FunctionId>> = HashMap::new();
    let mut tail_unknown_ref_callers: HashMap<TypeId, Vec<(FunctionId, ProgramPoint)>> =
        HashMap::new();
    let mut precise_ref_callers: HashMap<FunctionId, Vec<(TypeId, FunctionId)>> = HashMap::new();
    let mut tail_precise_ref_callers: HashMap<FunctionId, Vec<(TypeId, FunctionId, ProgramPoint)>> =
        HashMap::new();
    let mut dispatch_types = HashSet::new();

    for (&caller, profile) in &profiles {
        for &indirect in &profile.indirect {
            dispatch_types.insert(indirect.ty);
            indirect_callers
                .entry(indirect.ty)
                .or_default()
                .push((indirect, caller));
        }
        for &(indirect, point) in &profile.tail_indirect {
            dispatch_types.insert(indirect.ty);
            tail_indirect_callers
                .entry(indirect.ty)
                .or_default()
                .push((indirect, caller, point));
        }
        for &reference in &profile.refs {
            dispatch_types.insert(reference.ty);
            match reference.target {
                RefTargetProof::Func(target) => precise_ref_callers
                    .entry(target)
                    .or_default()
                    .push((reference.ty, caller)),
                RefTargetProof::Null => {}
                RefTargetProof::Unknown => {
                    unknown_ref_callers
                        .entry(reference.ty)
                        .or_default()
                        .insert(caller);
                }
            }
        }
        for &(reference, point) in &profile.tail_refs {
            dispatch_types.insert(reference.ty);
            match reference.target {
                RefTargetProof::Func(target) => tail_precise_ref_callers
                    .entry(target)
                    .or_default()
                    .push((reference.ty, caller, point)),
                RefTargetProof::Null => {}
                RefTargetProof::Unknown => tail_unknown_ref_callers
                    .entry(reference.ty)
                    .or_default()
                    .push((caller, point)),
            }
        }
    }
    let mut dispatch_types_by_signature: HashMap<FunctionSignature, Vec<TypeId>> = HashMap::new();
    for &ty in &dispatch_types {
        dispatch_types_by_signature
            .entry(function_signature(module, ty))
            .or_default()
            .push(ty);
    }

    let mut activations = HashSet::new();
    let mut control_reachable = HashSet::new();
    let mut tail_call_landings = HashSet::new();
    let mut worklist = VecDeque::new();
    for seed in seeds {
        activations.insert(seed);
        if control_reachable.insert(seed) {
            worklist.push_back(seed);
        }
    }

    fn discover(
        caller: FunctionId,
        activation_survives: bool,
        activations: &mut HashSet<FunctionId>,
        control_reachable: &mut HashSet<FunctionId>,
        worklist: &mut VecDeque<FunctionId>,
    ) {
        if activation_survives {
            activations.insert(caller);
        }
        if control_reachable.insert(caller) {
            worklist.push_back(caller);
        }
    }

    if external_dynamic_dispatch {
        for (&caller, profile) in &profiles {
            if !profile.indirect.is_empty() {
                discover(
                    caller,
                    true,
                    &mut activations,
                    &mut control_reachable,
                    &mut worklist,
                );
            }
            if profile
                .refs
                .iter()
                .any(|reference| reference.target == RefTargetProof::Unknown)
            {
                // WHY: a funcref received from another module has no local
                // FunctionId. Treat the call site itself as the boundary so
                // the live caller is activation-owned before control crosses
                // the instance boundary.
                discover(
                    caller,
                    true,
                    &mut activations,
                    &mut control_reachable,
                    &mut worklist,
                );
            }
            for &(_, point) in &profile.tail_indirect {
                // A side-module function installed after instrumentation is
                // not present in any static target set. A tail dispatch can
                // still reach its fork path, but the caller frame is gone.
                tail_call_landings.insert(TailCallSite {
                    caller,
                    sequence: point.sequence,
                    instruction_index: point.instruction_index,
                    kind: TailCallKind::Indirect,
                });
                discover(
                    caller,
                    false,
                    &mut activations,
                    &mut control_reachable,
                    &mut worklist,
                );
            }
            for &(reference, point) in &profile.tail_refs {
                if reference.target != RefTargetProof::Unknown {
                    continue;
                }
                tail_call_landings.insert(TailCallSite {
                    caller,
                    sequence: point.sequence,
                    instruction_index: point.instruction_index,
                    kind: TailCallKind::Ref,
                });
                discover(
                    caller,
                    false,
                    &mut activations,
                    &mut control_reachable,
                    &mut worklist,
                );
            }
        }
    }

    let mut compatible_type_cache: HashMap<TypeId, Vec<TypeId>> = HashMap::new();
    while let Some(g) = worklist.pop_front() {
        // Ordinary direct callers retain an activation.
        if let Some(callers) = reverse_direct.get(&g) {
            for &caller in callers {
                discover(
                    caller,
                    true,
                    &mut activations,
                    &mut control_reachable,
                    &mut worklist,
                );
            }
        }

        // A true tail caller is a transparent control-flow node. Record the
        // exact site for selective lowering, and continue walking through it
        // without claiming that its eliminated frame survives.
        if let Some(callers) = reverse_tail_direct.get(&g) {
            for &(caller, point) in callers {
                tail_call_landings.insert(TailCallSite {
                    caller,
                    sequence: point.sequence,
                    instruction_index: point.instruction_index,
                    kind: TailCallKind::Direct,
                });
                discover(
                    caller,
                    false,
                    &mut activations,
                    &mut control_reachable,
                    &mut worklist,
                );
            }
        }

        let g_ty = function_type_id(module, g);

        // A statically proven ref.func target does not need the all-compatible
        // fallback. The type check remains explicit so hand-built walrus
        // modules cannot manufacture an impossible edge.
        if let Some(callers) = precise_ref_callers.get(&g) {
            for &(expected, caller) in callers {
                if function_type_is_subtype(module, g_ty, expected) {
                    discover(
                        caller,
                        true,
                        &mut activations,
                        &mut control_reachable,
                        &mut worklist,
                    );
                }
            }
        }
        if let Some(callers) = tail_precise_ref_callers.get(&g) {
            for &(expected, caller, point) in callers {
                if function_type_is_subtype(module, g_ty, expected) {
                    tail_call_landings.insert(TailCallSite {
                        caller,
                        sequence: point.sequence,
                        instruction_index: point.instruction_index,
                        kind: TailCallKind::Ref,
                    });
                    discover(
                        caller,
                        false,
                        &mut activations,
                        &mut control_reachable,
                        &mut worklist,
                    );
                }
            }
        }

        let compatible_types = compatible_type_cache.entry(g_ty).or_insert_with(|| {
            compatible_dispatch_types(module, g_ty, &dispatch_types_by_signature)
        });
        for expected in compatible_types.iter().copied() {
            if let Some(callers) = indirect_callers.get(&expected) {
                for &(indirect, caller) in callers {
                    if table_targets.table_can_dispatch(indirect, g) {
                        discover(
                            caller,
                            true,
                            &mut activations,
                            &mut control_reachable,
                            &mut worklist,
                        );
                    }
                }
            }
            if let Some(callers) = tail_indirect_callers.get(&expected) {
                for &(indirect, caller, point) in callers {
                    if table_targets.table_can_dispatch(indirect, g) {
                        tail_call_landings.insert(TailCallSite {
                            caller,
                            sequence: point.sequence,
                            instruction_index: point.instruction_index,
                            kind: TailCallKind::Indirect,
                        });
                        discover(
                            caller,
                            false,
                            &mut activations,
                            &mut control_reachable,
                            &mut worklist,
                        );
                    }
                }
            }
            if let Some(callers) = unknown_ref_callers.get(&expected) {
                for &caller in callers {
                    discover(
                        caller,
                        true,
                        &mut activations,
                        &mut control_reachable,
                        &mut worklist,
                    );
                }
            }
            if let Some(callers) = tail_unknown_ref_callers.get(&expected) {
                for &(caller, point) in callers {
                    tail_call_landings.insert(TailCallSite {
                        caller,
                        sequence: point.sequence,
                        instruction_index: point.instruction_index,
                        kind: TailCallKind::Ref,
                    });
                    discover(
                        caller,
                        false,
                        &mut activations,
                        &mut control_reachable,
                        &mut worklist,
                    );
                }
            }
        }
    }

    let mut tail_call_landings: Vec<_> = tail_call_landings.into_iter().collect();
    tail_call_landings.sort_by_key(|site| {
        (
            site.caller.index(),
            site.sequence.index(),
            site.instruction_index,
            site.kind,
        )
    });
    ReachingAnalysis {
        activations,
        control_reachable,
        tail_call_landings,
    }
}

/// Lower only fork-reaching tail calls to ordinary calls followed by `return`.
///
/// This is the bridge between semantic analysis and frame instrumentation:
/// analysis first reports the caller as eliminated, this pass creates a real
/// resumable landing at the suspension-capable edge, and a second analysis
/// then includes that newly materialized activation. Tail calls outside
/// `sites` retain their original stack and performance semantics.
///
/// `sites` must come from [`analyze_reaching_closure`] for this module before
/// any other mutation. Stale or mismatched instruction kinds fail explicitly.
pub fn lower_tail_call_landings(module: &mut Module, sites: &[TailCallSite]) -> Result<()> {
    let mut grouped: BTreeMap<FunctionId, BTreeMap<InstrSeqId, Vec<TailCallSite>>> =
        BTreeMap::new();
    let mut unique = HashSet::new();
    for &site in sites {
        if unique.insert(site) {
            grouped
                .entry(site.caller)
                .or_default()
                .entry(site.sequence)
                .or_default()
                .push(site);
        }
    }

    for (caller, sequences) in grouped {
        let caller_name = func_display_name(module, caller);
        let function = module.funcs.get_mut(caller);
        let walrus::FunctionKind::Local(local) = &mut function.kind else {
            bail!(
                "tail-call landing for `{caller_name}` names an imported \
                 function; reachability metadata is stale"
            );
        };

        for (sequence, mut sequence_sites) in sequences {
            // Inserting after a site shifts later indexes only. Descending
            // mutation preserves every original program point in this seq.
            sequence_sites.sort_by_key(|site| std::cmp::Reverse(site.instruction_index));
            let instrs = &mut local.block_mut(sequence).instrs;
            for site in sequence_sites {
                let Some((instruction, location)) = instrs.get(site.instruction_index).cloned()
                else {
                    bail!(
                        "tail-call landing for `{caller_name}` points past the \
                         end of sequence {:?}; reachability metadata is stale",
                        sequence
                    );
                };

                let (replacement, actual_kind) = match instruction {
                    Instr::ReturnCall(call) => (
                        Instr::Call(ir::Call { func: call.func }),
                        TailCallKind::Direct,
                    ),
                    Instr::ReturnCallIndirect(call) => (
                        Instr::CallIndirect(ir::CallIndirect {
                            ty: call.ty,
                            table: call.table,
                        }),
                        TailCallKind::Indirect,
                    ),
                    Instr::ReturnCallRef(call) => (
                        Instr::CallRef(ir::CallRef { ty: call.ty }),
                        TailCallKind::Ref,
                    ),
                    other => {
                        bail!(
                            "tail-call landing for `{caller_name}` points at \
                             non-tail instruction {other:?}; reachability \
                             metadata is stale"
                        );
                    }
                };
                if actual_kind != site.kind {
                    bail!(
                        "tail-call landing for `{caller_name}` expected {:?} \
                         but found {actual_kind:?}; reachability metadata is stale",
                        site.kind
                    );
                }

                instrs.splice(
                    site.instruction_index..=site.instruction_index,
                    [
                        (replacement, location),
                        (Instr::Return(ir::Return {}), location),
                    ],
                );
            }
        }
    }
    Ok(())
}

/// Compute the set of activation-live functions that need fork frame
/// instrumentation. Use [`analyze_reaching_closure`] when the transform also
/// needs the exact suspension-capable tail sites.
pub fn reaching_closure(module: &Module, seed: FunctionId) -> HashSet<FunctionId> {
    analyze_reaching_closure(module, seed).activations
}

/// Human-readable name for a function, for logging and JSON output.
/// Uses the function's own `name` field if set (preserved from the
/// wasm name section); otherwise synthesizes `func[N]` from the
/// function's index.
pub fn func_display_name(module: &Module, id: FunctionId) -> String {
    let func = module.funcs.get(id);
    if let Some(name) = &func.name {
        name.clone()
    } else {
        // Fall back to a stable synthetic label.
        format!("func#{:?}", id)
    }
}

/// A classification of a discovered function for JSON output.
#[derive(Debug)]
pub struct FuncEntry {
    pub name: String,
    pub is_import: bool,
}

/// Summarize a set of function IDs as sorted `FuncEntry` records.
/// Sorting is stable across runs so that diff-based validation works.
pub fn summarize(module: &Module, ids: &HashSet<FunctionId>) -> Vec<FuncEntry> {
    let mut entries: Vec<FuncEntry> = ids
        .iter()
        .map(|&id| {
            let func = module.funcs.get(id);
            FuncEntry {
                name: func_display_name(module, id),
                is_import: matches!(func.kind, walrus::FunctionKind::Import(_)),
            }
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}
