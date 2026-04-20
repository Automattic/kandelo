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

use walrus::{FunctionId, ImportKind, Module};
use walrus::ir::{Call, Visitor, dfs_in_order};

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

/// Walks a single local function, collecting every `Call` target it
/// makes. Does not (yet) walk `call_indirect` — that's Phase 3.
struct CollectCalls {
    out: HashSet<FunctionId>,
}

impl<'a> Visitor<'a> for CollectCalls {
    fn visit_call(&mut self, instr: &Call) {
        self.out.insert(instr.func);
    }
}

/// Build the reverse call graph: a map from callee to set of direct
/// callers. Only includes edges originating from local (non-imported)
/// functions, since imported functions have no body to scan.
pub fn build_reverse_call_graph(module: &Module) -> HashMap<FunctionId, HashSet<FunctionId>> {
    let mut reverse: HashMap<FunctionId, HashSet<FunctionId>> = HashMap::new();
    for (caller_id, func) in module.funcs.iter_local() {
        let mut collector = CollectCalls {
            out: HashSet::new(),
        };
        dfs_in_order(&mut collector, func, func.entry_block());
        for callee in collector.out {
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
