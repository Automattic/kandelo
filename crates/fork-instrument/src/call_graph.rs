//! Call-graph discovery.
//!
//! Given a seed function (typically an imported async function like
//! `kernel.kernel_fork`), computes the set of functions in the module
//! that can transitively reach the seed via calls.
//!
//! Discovery follows direct calls and table-aware indirect calls. An
//! indirect call can only reach functions that may inhabit the same
//! table as that `call_indirect` instruction, with the same signature.

use std::collections::{HashMap, HashSet, VecDeque};

use walrus::ir::{
    self, dfs_in_order, BinaryOp, Call, Instr, InstrLocId, InstrSeqId, ReturnCall, TableCopy,
    TableFill, TableGrow, TableInit, TableSet, Visitor,
};
use walrus::{
    ConstExpr, ElementId, ElementItems, ElementKind, FunctionId, ImportKind, LocalFunction, Module,
    TableId, TypeId,
};

/// Look up a function by its qualified import name (e.g.
/// `"kernel.kernel_fork"`). Returns `None` if the module has no such
/// import or if the import exists but isn't a function.
pub fn find_import_func(module: &Module, qualified_name: &str) -> Option<FunctionId> {
    let (mod_name, field) = qualified_name.split_once('.')?;
    for import in module.imports.iter() {
        if import.module == mod_name && import.name == field {
            if let ImportKind::Function(id) = import.kind {
                return Some(id);
            }
        }
    }
    None
}

/// Walks a single local function, collecting every `Call` target
/// and every indirect-call site.
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

    fn visit_return_call(&mut self, instr: &ReturnCall) {
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

/// Per-function analysis: what it directly calls and what
/// indirect calls/table operations it uses.
struct FuncProfile {
    direct: HashSet<FunctionId>,
    indirect: HashSet<IndirectCall>,
    table_inits: Vec<(ElementId, TableId)>,
    table_copies: Vec<(TableId, TableId)>,
    dynamic_table_writes: HashSet<TableId>,
}

fn profile_functions(module: &Module) -> HashMap<FunctionId, FuncProfile> {
    let mut profiles = HashMap::new();
    for (id, func) in module.funcs.iter_local() {
        let mut collector = CollectCalls::default();
        dfs_in_order(&mut collector, func, func.entry_block());
        let indirect = collect_indirect_calls(func);
        profiles.insert(
            id,
            FuncProfile {
                direct: collector.direct,
                indirect,
                table_inits: collector.table_inits,
                table_copies: collector.table_copies,
                dynamic_table_writes: collector.dynamic_table_writes,
            },
        );
    }
    profiles
}

/// Build the reverse call graph: a map from callee to set of direct
/// callers. Only includes edges originating from local (non-imported)
/// functions, since imported functions have no body to scan.
pub fn build_reverse_call_graph(module: &Module) -> HashMap<FunctionId, HashSet<FunctionId>> {
    let mut reverse: HashMap<FunctionId, HashSet<FunctionId>> = HashMap::new();
    for (caller_id, profile) in profile_functions(module) {
        for callee in profile.direct {
            reverse.entry(callee).or_default().insert(caller_id);
        }
    }
    reverse
}

/// Compute the transitive closure of functions that reach `seed` via
/// direct calls. Result always includes `seed` itself.
pub fn direct_reaching_closure(module: &Module, seed: FunctionId) -> HashSet<FunctionId> {
    let reverse = build_reverse_call_graph(module);
    let mut result = HashSet::new();
    let mut queue = VecDeque::new();
    result.insert(seed);
    queue.push_back(seed);
    while let Some(f) = queue.pop_front() {
        if let Some(callers) = reverse.get(&f) {
            for &caller in callers {
                if result.insert(caller) {
                    queue.push_back(caller);
                }
            }
        }
    }
    result
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

fn collect_indirect_calls(func: &LocalFunction) -> HashSet<IndirectCall> {
    let mut calls = HashSet::new();
    collect_indirect_calls_seq(func, func.entry_block(), &mut calls);
    calls
}

fn collect_indirect_calls_seq(
    func: &LocalFunction,
    seq_id: InstrSeqId,
    calls: &mut HashSet<IndirectCall>,
) {
    let instrs = &func.block(seq_id).instrs;
    for (idx, (instr, _)) in instrs.iter().enumerate() {
        match instr {
            Instr::CallIndirect(call) => {
                calls.insert(IndirectCall {
                    table: call.table,
                    ty: call.ty,
                    index: infer_call_indirect_index(&instrs[..idx]),
                });
            }
            Instr::ReturnCallIndirect(call) => {
                calls.insert(IndirectCall {
                    table: call.table,
                    ty: call.ty,
                    index: infer_call_indirect_index(&instrs[..idx]),
                });
            }
            Instr::Block(ir::Block { seq }) | Instr::Loop(ir::Loop { seq }) => {
                collect_indirect_calls_seq(func, *seq, calls);
            }
            Instr::IfElse(ir::IfElse {
                consequent,
                alternative,
            }) => {
                collect_indirect_calls_seq(func, *consequent, calls);
                collect_indirect_calls_seq(func, *alternative, calls);
            }
            Instr::TryTable(ir::TryTable { seq, .. }) => {
                collect_indirect_calls_seq(func, *seq, calls);
            }
            Instr::Try(ir::Try { seq, catches }) => {
                collect_indirect_calls_seq(func, *seq, calls);
                for catch in catches {
                    match catch {
                        ir::LegacyCatch::Catch { handler, .. }
                        | ir::LegacyCatch::CatchAll { handler } => {
                            collect_indirect_calls_seq(func, *handler, calls);
                        }
                        ir::LegacyCatch::Delegate { .. } => {}
                    }
                }
            }
            _ => {}
        }
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

/// Check whether two type ids refer to structurally identical
/// function types (same params, same results). For modern wasm with
/// type indices the ids usually match exactly when two functions
/// share a signature, but we compare structurally to be robust to
/// modules where the same signature has multiple type-section entries.
fn types_match(module: &Module, a: TypeId, b: TypeId) -> bool {
    if a == b {
        return true;
    }
    let ta = module.types.get(a);
    let tb = module.types.get(b);
    ta.params() == tb.params() && ta.results() == tb.results()
}

const MAX_INDIRECT_DEPTH: u8 = 2;

/// Whether this module can resolve and invoke functions installed by Kandelo's
/// dynamic linker after static call-graph analysis has completed.
///
/// This predicate is also used when emitting the versioned fork capability
/// marker. Keep it as the single source of truth for both the conservative
/// closure below and the artifact claim consumed by the host runtime.
pub fn has_dynamic_linker_imports(module: &Module) -> bool {
    module.imports.iter().any(|import| {
        import.module == "env"
            && matches!(import.kind, ImportKind::Function(_))
            && matches!(
                import.name.as_str(),
                "__wasm_dlopen" | "__wasm_dlsym" | "__wasm_dlclose" | "__wasm_dlerror"
            )
    })
}

/// Compute the transitive closure of functions that reach `seed` via
/// direct calls, plus a bounded number of table/function-pointer dispatches.
///
/// A function `F` reaches `seed` if any of these hold:
///   (1) `F == seed`
///   (2) `F` directly calls some function `G` that reaches `seed`
///   (3) `F` executes `call_indirect` of type `T`, and some
///       function `G` of type `T` reaches `seed` and may inhabit the
///       same table that `F` indexes
///
/// Rule 3 is intentionally bounded. Functions discovered through indirect
/// edges still pull in their direct callers, but after `MAX_INDIRECT_DEPTH`
/// indirect hops they do not become new indirect roots. Depth 2 covers the
/// common C/POSIX callback cases plus QuickJS's C-function trampoline
/// (`JS_CallInternal -> js_call_c_function -> js_os_exec`) while avoiding
/// whole-runtime closure in dynamic interpreters where a generic dispatcher
/// can theoretically call thousands of same-table, same-signature callbacks.
pub fn reaching_closure(module: &Module, seed: FunctionId) -> HashSet<FunctionId> {
    let profiles = profile_functions(module);
    let table_targets = table_targets(module, &profiles);
    // A dlsym result can be installed into the main module's table only after
    // static analysis. Every call_indirect in a dlopen-capable main module is
    // therefore a possible boundary above a fork-capable side-module frame.
    // Keep this opt-in to the dynamic-linker imports so ordinary programs
    // retain the precise table-target closure below.
    let has_dynamic_linker_imports = has_dynamic_linker_imports(module);

    // Reverse direct-call graph: `callee -> set of callers`.
    let mut reverse_direct: HashMap<FunctionId, HashSet<FunctionId>> = HashMap::new();
    for (caller, profile) in &profiles {
        for callee in &profile.direct {
            reverse_direct.entry(*callee).or_default().insert(*caller);
        }
    }

    // Reverse indirect-call graph: `(table, call_indirect type T) ->
    // callers that index that table with type T`. We compare types
    // structurally (§types_match); TypeId is still stored and compared
    // at lookup time rather than forcing exact type-index equality.
    let indirect_callers: Vec<(IndirectCall, FunctionId)> = profiles
        .iter()
        .flat_map(|(caller, profile)| {
            profile
                .indirect
                .iter()
                .map(move |indirect| (*indirect, *caller))
        })
        .collect();

    // First compute the direct-only closure. Every function in this set
    // reaches the seed without crossing a function-pointer dispatch, so it
    // is safe to use as an indirect root below.
    let mut result = HashSet::new();
    let mut direct_queue = VecDeque::new();
    result.insert(seed);
    direct_queue.push_back(seed);
    while let Some(g) = direct_queue.pop_front() {
        if let Some(callers) = reverse_direct.get(&g) {
            for &caller in callers {
                if result.insert(caller) {
                    direct_queue.push_back(caller);
                }
            }
        }
    }

    let direct_roots = result.clone();
    let mut best_indirect_depth: HashMap<FunctionId, u8> =
        direct_roots.iter().map(|&id| (id, 0)).collect();
    let mut worklist: VecDeque<(FunctionId, u8)> = direct_roots.iter().map(|&id| (id, 0)).collect();

    fn enqueue(
        func: FunctionId,
        indirect_depth: u8,
        best_indirect_depth: &mut HashMap<FunctionId, u8>,
        result: &mut HashSet<FunctionId>,
        worklist: &mut VecDeque<(FunctionId, u8)>,
    ) {
        let should_enqueue = match best_indirect_depth.get(&func) {
            Some(&old_depth) => indirect_depth < old_depth,
            None => true,
        };
        if should_enqueue {
            best_indirect_depth.insert(func, indirect_depth);
            result.insert(func);
            worklist.push_back((func, indirect_depth));
        }
    }

    if has_dynamic_linker_imports {
        for (&caller, profile) in &profiles {
            if !profile.indirect.is_empty() {
                enqueue(
                    caller,
                    1,
                    &mut best_indirect_depth,
                    &mut result,
                    &mut worklist,
                );
            }
        }
    }

    while let Some((g, indirect_depth)) = worklist.pop_front() {
        // (2) Direct-reverse: who calls g directly?
        if let Some(callers) = reverse_direct.get(&g) {
            for &caller in callers {
                enqueue(
                    caller,
                    indirect_depth,
                    &mut best_indirect_depth,
                    &mut result,
                    &mut worklist,
                );
            }
        }

        // (3) Indirect-reverse: every function that does
        // `call_indirect` with g's signature against a table that can
        // contain g might be reaching g. Add those callers.
        if indirect_depth < MAX_INDIRECT_DEPTH {
            let g_ty = function_type_id(module, g);
            for &(indirect, caller) in &indirect_callers {
                if table_targets.table_can_dispatch(indirect, g)
                    && types_match(module, indirect.ty, g_ty)
                {
                    enqueue(
                        caller,
                        indirect_depth + 1,
                        &mut best_indirect_depth,
                        &mut result,
                        &mut worklist,
                    );
                }
            }
        }
    }

    result
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
