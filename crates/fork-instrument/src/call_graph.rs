//! Call-graph discovery.
//!
//! Given a seed function (typically an imported async function like
//! `kernel.kernel_fork`), computes the set of functions in the module
//! that can transitively reach the seed via calls.
//!
//! Phase 2 implements **direct-call closure** only: `Call` instructions
//! whose target is another function in the module. Phase 3 will extend
//! this with indirect-call closure (enumerating `call_indirect` targets
//! by type signature + function-table membership).

use std::collections::{HashMap, HashSet, VecDeque};

use walrus::{ElementItems, FunctionId, ImportKind, Module, TypeId};
use walrus::ir::{Call, CallIndirect, Visitor, dfs_in_order};

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
/// and every `call_indirect` type index.
#[derive(Default)]
struct CollectCalls {
    direct: HashSet<FunctionId>,
    indirect_types: HashSet<TypeId>,
}

impl<'a> Visitor<'a> for CollectCalls {
    fn visit_call(&mut self, instr: &Call) {
        self.direct.insert(instr.func);
    }

    fn visit_call_indirect(&mut self, instr: &CallIndirect) {
        self.indirect_types.insert(instr.ty);
    }
}

/// Per-function analysis: what it directly calls and what
/// `call_indirect` type signatures it uses.
struct FuncProfile {
    direct: HashSet<FunctionId>,
    indirect_types: HashSet<TypeId>,
}

fn profile_functions(module: &Module) -> HashMap<FunctionId, FuncProfile> {
    let mut profiles = HashMap::new();
    for (id, func) in module.funcs.iter_local() {
        let mut collector = CollectCalls::default();
        dfs_in_order(&mut collector, func, func.entry_block());
        profiles.insert(
            id,
            FuncProfile {
                direct: collector.direct,
                indirect_types: collector.indirect_types,
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

/// Enumerate the set of functions that appear in *any* element
/// segment, meaning they are potential `call_indirect` targets.
///
/// Walks every element segment's items list; handles both the
/// `Functions(Vec<FunctionId>)` form (most common, produced by LLVM
/// for indirect-callable function tables) and the
/// `Expressions(RefType, Vec<InstrSeqId>)` form (used for typed
/// function references; we conservatively scan each init expression
/// for `ref.func` to extract the function id).
fn table_addressable_functions(module: &Module) -> HashSet<FunctionId> {
    let mut result = HashSet::new();

    for elem in module.elements.iter() {
        match &elem.items {
            ElementItems::Functions(ids) => {
                for id in ids {
                    result.insert(*id);
                }
            }
            ElementItems::Expressions(_ref_ty, init_exprs) => {
                // An init expression produces one value. For
                // function-ref element segments, LLVM emits
                // `ref.func $f`, which walrus stores as
                // `ConstExpr::RefFunc`.
                for expr in init_exprs {
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
                        // Other ConstExpr variants (Value, Global,
                        // RefNull) don't yield a concrete function.
                        _ => {}
                    }
                }
            }
        }
    }
    result
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

/// Compute the transitive closure of functions that reach `seed` via
/// direct or indirect calls.
///
/// A function `F` reaches `seed` if any of these hold:
///   (1) `F == seed`
///   (2) `F` directly calls some function `G` that reaches `seed`
///   (3) `F` executes `call_indirect` of type `T`, and some
///       table-addressable function `G` of type `T` reaches `seed`
///
/// The algorithm iterates a single worklist seeded with `seed`. For
/// each newly-added function `g`:
///   - add its direct callers (rule 2 in reverse)
///   - if `g` is table-addressable, add every function that uses
///     `call_indirect` of `g`'s signature (rule 3 in reverse)
///
/// Fixpoint when the worklist drains.
pub fn reaching_closure(module: &Module, seed: FunctionId) -> HashSet<FunctionId> {
    let profiles = profile_functions(module);
    let table_funcs = table_addressable_functions(module);

    // Reverse direct-call graph: `callee -> set of callers`.
    let mut reverse_direct: HashMap<FunctionId, HashSet<FunctionId>> = HashMap::new();
    for (caller, profile) in &profiles {
        for callee in &profile.direct {
            reverse_direct.entry(*callee).or_default().insert(*caller);
        }
    }

    // Reverse indirect-call graph: `call_indirect type T -> set of
    // callers that use call_indirect with type T`. We compare types
    // structurally (§types_match); the map is keyed by the caller's
    // TypeId and we do an outer structural compare per lookup.
    let indirect_callers_by_type: Vec<(TypeId, FunctionId)> = profiles
        .iter()
        .flat_map(|(caller, profile)| {
            profile
                .indirect_types
                .iter()
                .map(move |ty| (*ty, *caller))
        })
        .collect();

    let mut result = HashSet::new();
    let mut worklist: VecDeque<FunctionId> = VecDeque::new();
    result.insert(seed);
    worklist.push_back(seed);

    while let Some(g) = worklist.pop_front() {
        // (2) Direct-reverse: who calls g directly?
        if let Some(callers) = reverse_direct.get(&g) {
            for &caller in callers {
                if result.insert(caller) {
                    worklist.push_back(caller);
                }
            }
        }

        // (3) Indirect-reverse: if g is table-addressable, every
        // function that does `call_indirect` with g's signature might
        // be reaching g. Add those callers.
        //
        // An imported function has no TypeId accessible the same way,
        // so we skip the indirect reverse for imports.
        if !table_funcs.contains(&g) {
            continue;
        }
        if matches!(module.funcs.get(g).kind, walrus::FunctionKind::Import(_)) {
            continue;
        }
        let g_ty = function_type_id(module, g);
        for &(caller_ty, caller) in &indirect_callers_by_type {
            if types_match(module, caller_ty, g_ty) && result.insert(caller) {
                worklist.push_back(caller);
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
