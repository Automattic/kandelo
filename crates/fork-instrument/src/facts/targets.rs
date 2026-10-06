//! Indirect-call targets from compiler facts (the research tool `fpa`'s
//! `registry` mode with the rules `cancel cleanup-lexical sigaction-old
//! casts slots effective-types`, moved here from
//! `tools/fork-sink-research/fpa`, which is in git history at a3f0eb448).
//!
//! For every defined function and every Wasm signature of a `call_indirect`
//! in it, the union of the functions its call sites can call:
//!
//! - a site with a CFI type id (`icall`) reaches table functions of that type
//!   id, a virtual call (`vcall`) the functions in that vtable slot;
//! - a function the source converts to another function type, or that is
//!   stored where the program reads it back as another type (casts, punned
//!   records, per-slot untyped-pointer flow), also matches the types those
//!   conversions reach;
//! - a libc/libc++ registry dispatch site (`HUBS`) reaches only callbacks
//!   registered with that registry, when every registration is visible;
//! - a site without type facts, a function without facts, and a table
//!   function without type facts all fall back to matching by Wasm
//!   signature.
use super::side::{HUBS, Interner, IrFn, IrSite, REG_APIS, Side};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use walrus::ir::*;
use walrus::*;

/// The module's functions as the facts rules see them.
pub(crate) struct Wasm {
    pub(crate) names: Vec<String>,
    pub(crate) import: Vec<bool>,
    sig: Vec<u32>,
    in_table: Vec<bool>,
    direct: Vec<Vec<u32>>,
    pub(crate) indirect: Vec<Vec<u32>>,
    consts: Vec<Vec<i64>>,
    /// Table slot -> function, from active element segments with constant offsets.
    slots: HashMap<i64, u32>,
    by_name: HashMap<String, Vec<u32>>,
}

fn vt(t: ValType) -> &'static str {
    match t {
        ValType::I32 => "i32",
        ValType::I64 => "i64",
        ValType::F32 => "f32",
        ValType::F64 => "f64",
        ValType::V128 => "v128",
        _ => "ref",
    }
}

struct Calls<'a> {
    consts: &'a mut Vec<i64>,
    direct: &'a mut Vec<u32>,
    indirect: &'a mut Vec<TypeId>,
}
impl<'i> Visitor<'i> for Calls<'_> {
    fn visit_call(&mut self, i: &Call) {
        self.direct.push(i.func.index() as u32);
    }
    fn visit_return_call(&mut self, i: &ReturnCall) {
        self.direct.push(i.func.index() as u32);
    }
    fn visit_call_indirect(&mut self, i: &CallIndirect) {
        self.indirect.push(i.ty);
    }
    fn visit_return_call_indirect(&mut self, i: &ReturnCallIndirect) {
        self.indirect.push(i.ty);
    }
    fn visit_const(&mut self, i: &Const) {
        if let Value::I32(v) = i.value {
            self.consts.push(v as i64);
        }
    }
}

pub(crate) fn load_wasm(module: &Module, sigs: &mut Interner) -> Wasm {
    let n = module.funcs.iter().map(|f| f.id().index() + 1).max().unwrap_or(0);
    let mut w = Wasm {
        names: vec![String::new(); n],
        import: vec![false; n],
        sig: vec![0; n],
        in_table: vec![false; n],
        direct: vec![vec![]; n],
        indirect: vec![vec![]; n],
        consts: vec![vec![]; n],
        slots: HashMap::new(),
        by_name: HashMap::new(),
    };
    let sig_of = |m: &Module, t: TypeId, sigs: &mut Interner| {
        let ty = m.types.get(t);
        let p: Vec<_> = ty.params().iter().map(|&x| vt(x)).collect();
        let r: Vec<_> = ty.results().iter().map(|&x| vt(x)).collect();
        sigs.id(&format!("{}->{}", p.join(","), r.join(",")))
    };
    for f in module.funcs.iter() {
        let i = f.id().index();
        w.names[i] = f.name.clone().unwrap_or_else(|| format!("#{i}"));
        w.sig[i] = sig_of(module, f.ty(), sigs);
        match &f.kind {
            FunctionKind::Import(_) => w.import[i] = true,
            FunctionKind::Local(l) => {
                let mut ind = vec![];
                dfs_in_order(&mut Calls { consts: &mut w.consts[i], direct: &mut w.direct[i], indirect: &mut ind }, l, l.entry_block());
                w.indirect[i] = ind.into_iter().map(|t| sig_of(module, t, sigs)).collect();
            }
            _ => {}
        }
    }
    for e in module.elements.iter() {
        if let ElementKind::Active { offset: ConstExpr::Value(Value::I32(base)), .. } = &e.kind {
            if let ElementItems::Functions(v) = &e.items {
                for (k, f) in v.iter().enumerate() {
                    w.slots.insert(*base as i64 + k as i64, f.index() as u32);
                }
            }
        }
        if matches!(e.kind, ElementKind::Declared) {
            continue;
        }
        match &e.items {
            ElementItems::Functions(v) => v.iter().for_each(|f| w.in_table[f.index()] = true),
            ElementItems::Expressions(_, ex) => {
                for x in ex {
                    if let ConstExpr::RefFunc(f) = x {
                        w.in_table[f.index()] = true;
                    }
                }
            }
        }
    }
    for (i, nm) in w.names.iter().enumerate() {
        w.by_name.entry(nm.clone()).or_default().push(i as u32);
    }
    w
}

// ---------------------------------------------------------------- edges
#[derive(Clone, Debug)]
enum Target {
    /// Indirect call of a Wasm signature. `typed` is the IR site with its
    /// type facts, or None when the site has no usable IR (signature
    /// fallback).
    Indirect { sig: u32, typed: Option<usize>, hub: Option<usize> },
}

#[derive(Clone, Debug)]
struct Edge {
    target: Target,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum View {
    NoIr,
    Mismatch,
    One,
    /// Bound to several definitions (same-named variants, such as a C++
    /// constructor's complete- and base-object bodies, or an ambiguous
    /// file-local name): the union of the matching ones.
    Many,
}

/// The rules the production analysis applies.
#[derive(Clone)]
pub(crate) struct Rules {
    /// pthread_cleanup_pop runs the handler its own lexical push installed
    /// (POSIX requires push/pop pairs in one lexical scope): the hub inside
    /// `_pthread_cleanup_pop` dispatches only to the caller's own handlers.
    pub(crate) cleanup_lexical: bool,
    /// Exact type matching except for functions the source shows may be
    /// called through another function type (conversion chains, punned
    /// records and per-slot untyped-pointer flow).
    pub(crate) casts: bool,
    /// Per-slot untyped-pointer flow in `casts`.
    pub(crate) slots: bool,
    /// Calls through an old-action `struct sigaction` global (plugin `O`
    /// facts) dispatch registered signal handlers only.
    pub(crate) sigaction_old: bool,
}

pub(crate) struct Graph<'a> {
    w: &'a Wasm,
    side: &'a Side,
    pub(crate) view: Vec<View>,
    /// CFI function type ids per function (None: no IR).
    fty: Vec<Option<HashSet<u32>>>,
    edges: Vec<Vec<Edge>>,
    irsites: Vec<&'a IrSite>,
    /// hub index -> [(callback type id, registries)]
    hubs: Vec<Vec<(u32, Vec<String>)>>,
    casts: bool,
    /// Per function: the CFI type ids it may be called through by the casts
    /// rules (None: not tainted), and its vtable slots.
    tainted: Vec<Option<HashSet<u32>>>,
    vslots: Vec<Option<&'a HashSet<(u32, i64)>>>,
    reg_unknown: HashMap<String, Vec<String>>,
    by_sig_table: HashMap<u32, Vec<u32>>,
    extra_registered: Vec<(String, String)>,
}

/// The function a local slot (`p:f:k`, `l:f:v`, `r:f`) belongs to.
fn slot_owner(n: &str) -> Option<&str> {
    if let Some(r) = n.strip_prefix("r:") {
        return Some(r);
    }
    let rest = n.strip_prefix("p:").or_else(|| n.strip_prefix("l:"))?;
    rest.rsplit_once(':').map(|(f, _)| f)
}

/// Edges (site, callee, caller, from) feeding each direct call's result
/// slot from its own arguments, per the callee's pass-through summary.
fn pass_through_edges(side: &Side) -> Vec<(String, String, String, String)> {
    let mut preds: HashMap<&str, Vec<&str>> = HashMap::new();
    for (a, b) in &side.slot_edges {
        preds.entry(b.as_str()).or_default().push(a.as_str());
    }
    let mut site_of: HashMap<&str, (&str, &str)> = HashMap::new();
    for (site, callee, caller) in &side.call_sites {
        site_of.insert(site.as_str(), (callee.as_str(), caller.as_str()));
    }
    // A function has a known body when the plugin declared its return slot.
    let known: HashSet<&str> = side.slot_links.iter().filter(|(_, k, _)| k == "ret").map(|(_, _, f)| f.as_str()).collect();
    // Summary per function: the parameters that reach its return value, and
    // the other sources (globals, fields, origins it creates, results of
    // unknown callees) that do. A call site's result takes its own
    // arguments for the former and the sources themselves for the latter,
    // never the shared r:<f> slot, which merges every caller's arguments.
    let mut summ: HashMap<&str, (HashSet<u32>, HashSet<String>)> = HashMap::new();
    let args = |site: &str, k: Option<u32>| -> Vec<&str> {
        side.call_args
            .get(site)
            .map(|v| v.iter().filter(|(i, _)| k.is_none_or(|k| *i == k)).map(|(_, s)| s.as_str()).collect())
            .unwrap_or_default()
    };
    // Iterate in a fixed order so the fixpoint is deterministic.
    let mut known_sorted: Vec<&str> = known.iter().copied().collect();
    known_sorted.sort_unstable();
    loop {
        let mut changed = false;
        for &f in &known_sorted {
            let mut params: HashSet<u32> = HashSet::new();
            let mut others: HashSet<String> = HashSet::new();
            let start = format!("r:{f}");
            let mut seen: HashSet<String> = HashSet::new();
            let mut work: Vec<String> = preds.get(start.as_str()).map(|v| v.iter().map(|x| x.to_string()).collect()).unwrap_or_default();
            while let Some(x) = work.pop() {
                if !seen.insert(x.clone()) {
                    continue;
                }
                if let Some((callee, caller)) = site_of.get(x.as_str()) {
                    if *caller != f {
                        others.insert(x.clone());
                        continue;
                    }
                    if known.contains(callee) {
                        if let Some((ps, os)) = summ.get(callee) {
                            for &k in ps {
                                work.extend(args(&x, Some(k)).into_iter().map(|s| s.to_string()));
                            }
                            others.extend(os.iter().cloned());
                        }
                    } else {
                        work.extend(args(&x, None).into_iter().map(|s| s.to_string()));
                        others.insert(format!("r:{callee}"));
                    }
                    continue;
                }
                match (x.strip_prefix("p:"), slot_owner(&x)) {
                    (Some(rest), Some(owner)) if owner == f => {
                        if let Some(k) = rest.rsplit_once(':').and_then(|(_, k)| k.parse().ok()) {
                            params.insert(k);
                        }
                    }
                    (None, Some(owner)) if owner == f && x.starts_with("l:") => {
                        work.extend(preds.get(x.as_str()).into_iter().flatten().map(|s| s.to_string()));
                    }
                    _ => {
                        others.insert(x.clone());
                    }
                }
            }
            let e = summ.entry(f).or_default();
            if !params.is_subset(&e.0) || !others.is_subset(&e.1) {
                e.0.extend(params);
                e.1.extend(others);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut out = vec![];
    for (site, callee, caller) in &side.call_sites {
        let mut push = |from: &str| out.push((site.clone(), callee.clone(), caller.clone(), from.to_string()));
        if known.contains(callee.as_str()) {
            if let Some((ps, os)) = summ.get(callee.as_str()) {
                for &k in ps {
                    for a in args(site, Some(k)) {
                        push(a);
                    }
                }
                for o in os {
                    push(o);
                }
            }
        } else {
            // No facts for the callee: it may return any argument, or
            // anything it can reach.
            for a in args(site, None) {
                push(a);
            }
            push(&format!("r:{callee}"));
        }
    }
    out
}

/// Per-slot propagation of untyped-pointer origins (see KandeloFnCasts.cpp,
/// "slots"). Returns extra conversion starts per function and extra
/// type-to-type conversions, given the conversion reach computed so far
/// (functions reached through casts also receive indirect-call arguments of
/// the types they reach).
/// The slot graph's round-independent part: plugin edges and call-site
/// result edges, with interned slot names.
struct SlotGraph {
    ids: HashMap<String, u32>,
    names: Vec<String>,
    succ: Vec<Vec<u32>>,
}

fn slot_graph(side: &Side, pass: &[(String, String, String, String)]) -> SlotGraph {
    let mut g = SlotGraph { ids: HashMap::new(), names: vec![], succ: vec![] };
    let mut id = |s: &str, g: &mut SlotGraph| -> u32 {
        if let Some(&i) = g.ids.get(s) {
            return i;
        }
        let i = g.names.len() as u32;
        g.names.push(s.to_string());
        g.ids.insert(s.to_string(), i);
        g.succ.push(vec![]);
        i
    };
    for (a, b) in &side.slot_edges {
        let (x, y) = (id(a, &mut g), id(b, &mut g));
        g.succ[x as usize].push(y);
    }
    // Call-site results: which parameters of each function reach its return
    // value through its own locals and calls, and whether anything else (a
    // global, a field, an origin it creates) does.
    for (site, _callee, _caller, from) in pass {
        let (x, y) = (id(from, &mut g), id(site, &mut g));
        g.succ[x as usize].push(y);
    }
    g
}

/// The slot edges for `slot_links`: function f of type T has its parameter k
/// fed by every indirect call of type T, and of every type its conversions
/// reach (`reach`); its result reaches the results of those calls.
///
/// WHY a join slot per reach set: a reach set can hold thousands of types
/// (every type GLib's `GCallback` is cast back to), and the functions with
/// one share a few such sets. Linking each function to each type it reaches
/// took billions of edges on GTK programs. One join slot per distinct
/// (reach set, k) carries the same origins in edges that grow with the
/// distinct sets: `pt:u:k -> join -> p:f:k`, and `r:f -> join -> rt:u`.
fn link_slots(side: &Side, reach: &Reach, tys: &Interner, edge: &mut impl FnMut(&str, &str)) {
    let mut joins: HashMap<(&[u32], &str), String> = HashMap::new();
    for (t, k, fname) in &side.slot_links {
        let ret = k == "ret";
        let (tail, head) = if ret { (format!("r:{fname}"), format!("rt:{t}")) } else { (format!("pt:{t}:{k}"), format!("p:{fname}:{k}")) };
        edge(&tail, &head);
        let Some(r) = reach.get(fname).filter(|r| !r.is_empty()) else { continue };
        let join = joins.entry((r.as_slice(), k.as_str())).or_default();
        if join.is_empty() {
            // '#' starts no slot name the plugin writes.
            *join = format!("#join:{fname}:{k}");
            for &u in r {
                let u = &tys.names[u as usize];
                if ret {
                    edge(join, &format!("rt:{u}"));
                } else {
                    edge(&format!("pt:{u}:{k}"), join);
                }
            }
        }
        if ret {
            edge(&tail, join);
        } else {
            edge(join, &head);
        }
    }
}

fn slot_flow(side: &Side, base: &SlotGraph, reach: &Reach, tys: &Interner) -> (HashMap<String, HashSet<String>>, HashMap<String, HashSet<String>>) {
    // Round edges on top of the base graph; new slot names get ids after it.
    let mut ids: HashMap<String, u32> = HashMap::new();
    let mut names: Vec<String> = vec![];
    let mut extra: HashMap<u32, Vec<u32>> = HashMap::new();
    let nb = base.names.len() as u32;
    let id = |s: &str, ids: &mut HashMap<String, u32>, names: &mut Vec<String>| -> u32 {
        if let Some(&i) = base.ids.get(s).or_else(|| ids.get(s)) {
            return i;
        }
        let i = nb + names.len() as u32;
        names.push(s.to_string());
        ids.insert(s.to_string(), i);
        i
    };
    link_slots(side, reach, tys, &mut |a, b| {
        let (x, y) = (id(a, &mut ids, &mut names), id(b, &mut ids, &mut names));
        extra.entry(x).or_default().push(y);
    });
    let name_of = |i: u32| -> &str { if i < nb { base.names[i as usize].as_str() } else { names[(i - nb) as usize].as_str() } };
    // Propagate origin sets (least fixpoint of set union), moving only the
    // origins a slot has newly gained.
    let n = nb as usize + names.len();
    let mut orig: Vec<HashSet<u32>> = vec![HashSet::new(); n];
    let mut pending: Vec<Vec<u32>> = vec![vec![]; n];
    let mut queued = vec![false; n];
    let mut work: VecDeque<u32> = VecDeque::new();
    for i in 0..n as u32 {
        if name_of(i).starts_with('@') {
            orig[i as usize].insert(i);
            pending[i as usize].push(i);
            queued[i as usize] = true;
            work.push_back(i);
        }
    }
    while let Some(x) = work.pop_front() {
        queued[x as usize] = false;
        let delta = std::mem::take(&mut pending[x as usize]);
        let from_base: &[u32] = if x < nb { &base.succ[x as usize] } else { &[] };
        let from_round: &[u32] = extra.get(&x).map(|v| v.as_slice()).unwrap_or(&[]);
        for &y in from_base.iter().chain(from_round) {
            let (oy, py) = (&mut orig[y as usize], &mut pending[y as usize]);
            for &o in &delta {
                if oy.insert(o) {
                    py.push(o);
                }
            }
            if !py.is_empty() && !queued[y as usize] {
                queued[y as usize] = true;
                work.push_back(y);
            }
        }
    }
    let lookup = |slot: &str| base.ids.get(slot).or_else(|| ids.get(slot)).copied();
    let at = |slot: &str| -> Vec<&str> { lookup(slot).map(|i| orig[i as usize].iter().map(|&o| name_of(o)).collect()).unwrap_or_default() };
    // Functions stored in a record (and in records it embeds); function
    // types of a record's fields (and of records it embeds).
    let closure = |r: &str| -> Vec<String> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut st = vec![r.to_string()];
        while let Some(x) = st.pop() {
            if seen.insert(x.clone()) {
                if let Some(ns) = side.rec_nested.get(&x) {
                    st.extend(ns.iter().cloned());
                }
            }
        }
        seen.into_iter().collect()
    };
    let fns_memo: std::cell::RefCell<HashMap<String, std::rc::Rc<Vec<String>>>> = Default::default();
    let types_memo: std::cell::RefCell<HashMap<String, std::rc::Rc<Vec<String>>>> = Default::default();
    let fns_in = |r: &str| -> std::rc::Rc<Vec<String>> {
        if let Some(v) = fns_memo.borrow().get(r) {
            return v.clone();
        }
        let v = std::rc::Rc::new(closure(r).iter().flat_map(|x| side.ast_g.get(x).into_iter().flatten().cloned()).collect::<Vec<_>>());
        fns_memo.borrow_mut().insert(r.to_string(), v.clone());
        v
    };
    let types_in = |r: &str| -> std::rc::Rc<Vec<String>> {
        if let Some(v) = types_memo.borrow().get(r) {
            return v.clone();
        }
        let v = std::rc::Rc::new(closure(r).iter().flat_map(|x| side.rec_fn_types.get(x).into_iter().flatten().cloned()).collect::<Vec<_>>());
        types_memo.borrow_mut().insert(r.to_string(), v.clone());
        v
    };
    let mut starts: HashMap<String, HashSet<String>> = HashMap::new();
    let mut z: HashMap<String, HashSet<String>> = HashMap::new();
    // C's effective-type rule: in a unit compiled with strict aliasing, the
    // compiler itself assumes a struct is never read through an unrelated
    // struct type, so such read-backs cannot be relied on by a correct
    // program and are not modelled; in units compiled with
    // -fno-strict-aliasing they are.
    let eff = side.effective_types;
    for (slot, s_rec, _) in side.slot_reads_rec.iter().filter(|(_, _, rel)| !eff || *rel) {
        for o in at(slot) {
            if let Some(r) = o.strip_prefix("@rec:") {
                if r != s_rec {
                    let ts = types_in(s_rec);
                    for f in fns_in(r).iter() {
                        starts.entry(f.clone()).or_default().extend(ts.iter().cloned());
                    }
                }
            }
        }
    }
    for (slot, u) in &side.slot_reads_fn {
        for o in at(slot) {
            if let Some(f) = o.strip_prefix("@fn:") {
                starts.entry(f.to_string()).or_default().insert(u.clone());
            } else if let Some(t) = o.strip_prefix("@ty:") {
                if t != u {
                    z.entry(t.to_string()).or_default().insert(u.clone());
                }
            }
        }
    }
    for (slot, u, _) in side.slot_reads_mem.iter().filter(|(_, _, rel)| !eff || *rel) {
        for o in at(slot) {
            if let Some(r) = o.strip_prefix("@rec:") {
                for f in fns_in(r).iter() {
                    starts.entry(f.clone()).or_default().insert(u.clone());
                }
            }
        }
    }
    (starts, z)
}

/// Functions that may be called through a function type other than their
/// own, and the types they may be called through.
/// Per function: the types (ids in the returned interner, sorted) it may be
/// called through other than its own declared type's exact match.
type Reach = HashMap<String, Vec<u32>>;

fn tainted_fns(side: &Side, slots: bool) -> (Interner, Reach) {
    let mut tys = Interner::default();
    if !slots {
        let r = tainted_fns1(side, &mut tys, &HashMap::new(), &HashMap::new());
        return (tys, r);
    }
    // Iterate: slot flow depends on what conversions reach, and adds to it.
    let pass = pass_through_edges(side);
    let base = slot_graph(side, &pass);
    drop(pass);
    let mut reach = tainted_fns1(side, &mut tys, &HashMap::new(), &HashMap::new());
    for _ in 0..4 {
        let (st, z) = slot_flow(side, &base, &reach, &tys);
        let next = tainted_fns1(side, &mut tys, &st, &z);
        let changed = next != reach;
        reach = next;
        if !changed {
            break;
        }
    }
    (tys, reach)
}

fn tainted_fns1(side: &Side, tys: &mut Interner, extra_starts: &HashMap<String, HashSet<String>>, extra_z: &HashMap<String, HashSet<String>>) -> Reach {
    // Value conversions between types: T -> U.
    let mut z: HashMap<u32, Vec<u32>> = HashMap::new();
    for (t, us) in side.ast_z.iter().chain(extra_z) {
        let a = tys.id(t);
        let e: Vec<u32> = us.iter().map(|u| tys.id(u)).collect();
        z.entry(a).or_default().extend(e);
    }
    // Conversion starts per function: direct conversions, and the types its
    // record is punned to.
    let mut starts: HashMap<&str, Vec<u32>> = HashMap::new();
    for (f, ts) in side.ast_w.iter().chain(extra_starts) {
        let e: Vec<u32> = ts.iter().map(|t| tys.id(t)).collect();
        starts.entry(f.as_str()).or_default().extend(e);
    }
    for (r, tos) in &side.ast_h {
        let e: Vec<u32> = tos.iter().map(|t| tys.id(t)).collect();
        for f in side.ast_g.get(r).map(|v| v.iter()).into_iter().flatten() {
            starts.entry(f.as_str()).or_default().extend(e.iter().copied());
        }
    }
    // A function's own types: its source-level type and its CFI type ids.
    let mut own: HashMap<&str, Vec<u32>> = HashMap::new();
    for (f, ts) in &side.ast_qtype {
        let e: Vec<u32> = ts.iter().map(|t| tys.id(t)).collect();
        own.entry(f.as_str()).or_default().extend(e);
    }
    for (f, ids) in &side.fn_types {
        let e: Vec<u32> = ids.iter().map(|&i| tys.id(&side.ids.names[i as usize])).collect();
        own.entry(f.as_str()).or_default().extend(e);
    }
    // A function of type T also reaches whatever a T-typed value is
    // converted to.
    let star = tys.get("*");
    let zfrom: HashSet<u32> = z.keys().copied().filter(|k| Some(*k) != star).collect();
    let mut fns: HashSet<&str> = starts.keys().copied().collect();
    for (f, ts) in &own {
        if ts.iter().any(|t| zfrom.contains(t)) {
            fns.insert(f);
        }
    }
    // Every type reachable from one type along conversions, memoized.
    let mut memo: HashMap<u32, std::rc::Rc<Vec<u32>>> = HashMap::new();
    let mut closure_of = |t: u32| -> std::rc::Rc<Vec<u32>> {
        if let Some(v) = memo.get(&t) {
            return v.clone();
        }
        let mut seen: HashSet<u32> = HashSet::new();
        let mut work = vec![t];
        while let Some(x) = work.pop() {
            if seen.insert(x) {
                if let Some(nx) = z.get(&x) {
                    work.extend(nx.iter().copied());
                }
            }
        }
        let mut v: Vec<u32> = seen.into_iter().collect();
        v.sort_unstable();
        let v = std::rc::Rc::new(v);
        memo.insert(t, v.clone());
        v
    };
    let mut out = HashMap::new();
    for f in fns {
        let mut r: Vec<u32> = vec![];
        for &t in starts.get(f).into_iter().flatten().chain(own.get(f).into_iter().flatten()) {
            r.extend(closure_of(t).iter().copied());
        }
        r.sort_unstable();
        r.dedup();
        out.insert(f.to_string(), r);
    }
    out
}

/// `cands[f]`: the definitions bound to function `f` (empty: no facts).
pub(crate) fn build_graph<'a>(w: &'a Wasm, side: &'a Side, cands: &[Vec<&'a IrFn>], rules: &Rules) -> Graph<'a> {
    let n = w.names.len();
    let mut g = Graph {
        w,
        side,
        view: vec![View::NoIr; n],
        fty: vec![None; n],
        edges: vec![vec![]; n],
        irsites: vec![],
        hubs: vec![],
        casts: rules.casts,
        tainted: vec![None; n],
        vslots: w.names.iter().map(|name| side.vslots.get(name)).collect(),
        reg_unknown: side.reg_unknown.clone(),
        by_sig_table: HashMap::new(),
        extra_registered: vec![],
    };
    if rules.casts {
        // A reach entry that is no interned type id matches no call site.
        let (tys, tainted) = tainted_fns(side, rules.slots);
        for (f, name) in w.names.iter().enumerate() {
            if let Some(reach) = tainted.get(name) {
                g.tainted[f] = Some(reach.iter().filter_map(|&t| side.ids.get(&tys.names[t as usize])).collect());
            }
        }
    }
    for f in 0..n {
        if w.in_table[f] {
            g.by_sig_table.entry(w.sig[f]).or_default().push(f as u32);
        }
    }
    // Registries become unknown when code without facts registers, or when
    // a registration API is itself address-taken in the final link.
    for f in 0..n {
        if w.import[f] {
            continue;
        }
        let has_ir = !cands[f].is_empty();
        if !has_ir && w.names[f].starts_with(".Lregister_call_dtors") {
            // LLVM's WebAssemblyLowerGlobalDtors synthesizes this function
            // after IR: it registers this object's `.Lcall_dtors*` with
            // __cxa_atexit. Check that every table slot it names holds one.
            let ok = w.direct[f].iter().all(|&c| w.names[c as usize] == "__cxa_atexit")
                && w.consts[f].iter().all(|v| w.slots.get(v).is_none_or(|&t| w.names[t as usize].starts_with(".Lcall_dtors")));
            if ok {
                for v in &w.consts[f] {
                    if let Some(&t) = w.slots.get(v) {
                        g.extra_registered.push(("exit".to_string(), w.names[t as usize].clone()));
                    }
                }
                continue;
            }
        }
        for &c in &w.direct[f] {
            for &(api, _, _, reg) in REG_APIS {
                if w.names[c as usize] == api && !has_ir {
                    g.reg_unknown.entry(reg.into()).or_default().push(format!("registered by {} (no IR)", w.names[f]));
                }
            }
        }
    }
    for f in 0..n {
        if !w.in_table[f] {
            continue;
        }
        for &(api, _, _, reg) in REG_APIS {
            if w.names[f] == api {
                g.reg_unknown.entry(reg.into()).or_default().push(format!("{api} is address-taken"));
            }
        }
    }
    let call_dtors_type = side.ids.get("_ZTSFvPvE");
    for f in 0..n {
        if w.import[f] {
            continue;
        }
        let name = &w.names[f];
        let mut wsigs: Vec<u32> = w.indirect[f].clone();
        wsigs.sort();
        if !cands[f].is_empty() {
            g.fty[f] = Some(cands[f].iter().flat_map(|v| v.types.iter().copied()).collect());
        } else if let (true, Some(t)) = (name.starts_with(".Lcall_dtors"), call_dtors_type) {
            // Synthesized by LLVM's WebAssemblyLowerGlobalDtors as
            // `void call_dtors(void*)`; only ever registered with __cxa_atexit.
            g.fty[f] = Some([t].into_iter().collect());
        }
        // The facts describe this body only if its indirect call sites have
        // the same Wasm signatures.
        let chosen: Vec<&IrFn> = cands[f]
            .iter()
            .copied()
            .filter(|v| {
                let mut s: Vec<u32> = v.sites.iter().filter(|s| s.direct.is_none()).map(|s| s.sig.unwrap_or(u32::MAX)).collect();
                s.sort();
                s == wsigs
            })
            .collect();
        g.view[f] = match (cands[f].len(), chosen.len()) {
            (0, _) => View::NoIr,
            (_, 0) => View::Mismatch,
            (1, 1) => View::One,
            _ => View::Many,
        };
        let mut edges = vec![];
        if !chosen.is_empty() {
            // Registry hubs are bound to one definition only.
            let single = g.view[f] == View::One;
            for v in &chosen {
                let hub_entries: Vec<usize> = (0..HUBS.len())
                    .filter(|&h| {
                        let (m, hf, _, _) = HUBS[h];
                        single && (hf == "*" || *name == hf) && side.modules.names[v.module as usize].ends_with(m)
                    })
                    .collect();
                for s in &v.sites {
                    let Some(sig) = s.sig else { continue };
                    if s.direct.is_some() {
                        continue;
                    }
                    let gi = g.irsites.len();
                    g.irsites.push(s);
                    let entries: Vec<(u32, Vec<String>)> = hub_entries
                        .iter()
                        .filter_map(|&h| {
                            let tid = side.ids.get(HUBS[h].2)?;
                            s.icall.contains(&tid).then(|| (tid, HUBS[h].3.iter().map(|x| x.to_string()).collect()))
                        })
                        .collect();
                    // A call through an old-action global dispatches an
                    // already-registered signal handler.
                    let entries = match &s.origin {
                        Some((k, gname)) if rules.sigaction_old && entries.is_empty() && k == "global" && side.oldact_globals.contains(gname) => {
                            s.icall.iter().map(|&id| (id, vec!["signal".to_string()])).collect()
                        }
                        _ => entries,
                    };
                    let hub_ix = if entries.is_empty() {
                        None
                    } else {
                        g.hubs.push(entries);
                        Some(g.hubs.len() - 1)
                    };
                    edges.push(Edge { target: Target::Indirect { sig, typed: Some(gi), hub: hub_ix } });
                }
            }
        } else {
            let mut s2: Vec<u32> = wsigs.clone();
            s2.dedup();
            for sig in s2 {
                edges.push(Edge { target: Target::Indirect { sig, typed: None, hub: None } });
            }
        }
        if rules.cleanup_lexical && name == "_pthread_cleanup_pop" {
            // Its dispatch is resolved per caller (`cleanup_pairs`).
            edges.clear();
        }
        g.edges[f] = edges;
    }
    g
}

impl Graph<'_> {
    fn registered(&self, r: &str, tn: &str) -> bool {
        self.reg_unknown.contains_key(r)
            || self.side.registered.get(r).is_some_and(|set| set.contains(tn))
            || self.extra_registered.iter().any(|(rr, n)| rr == r && n == tn)
    }

    fn admit(&self, e: &Edge, t: u32) -> bool {
        let Target::Indirect { sig, typed, hub } = &e.target;
        if self.w.sig[t as usize] != *sig || !self.w.in_table[t as usize] {
            return false;
        }
        // Signature fallback: a caller without usable facts.
        let Some(gi) = typed else { return true };
        let s = self.irsites[*gi];
        if s.untyped {
            return true;
        }
        let tn = &self.w.names[t as usize];
        let ft = self.fty[t as usize].as_ref();
        let fv = self.vslots[t as usize];
        // Signature fallback: a target without type facts.
        if ft.is_none() && fv.is_none() {
            return true;
        }
        if self.casts && hub.is_none() && !s.icall.is_empty() {
            if let Some(reach) = &self.tainted[t as usize] {
                if s.icall.iter().any(|id| reach.contains(id)) {
                    return true;
                }
            }
        }
        if let Some(ft) = ft {
            for id in &s.icall {
                if !ft.contains(id) {
                    continue;
                }
                if let Some(h) = hub {
                    if let Some((_, regs)) = self.hubs[*h].iter().find(|(t, _)| t == id) {
                        if regs.iter().any(|r| self.registered(r, tn)) {
                            return true;
                        }
                        continue;
                    }
                }
                return true;
            }
        }
        if let Some(fv) = fv {
            if s.vcall.iter().any(|x| fv.contains(x)) {
                return true;
            }
        }
        false
    }

    /// Per (function, Wasm signature of a call_indirect in it): the union of
    /// targets every site of that signature admits. Functions without usable
    /// facts fall back to the signature rule inside `admit`, so the union is
    /// never narrower than the facts justify.
    pub(crate) fn export_targets(&self, sigs: &Interner) -> Vec<(u32, String, Vec<u32>)> {
        let w = self.w;
        let mut out = vec![];
        for f in 0..w.names.len() {
            if w.import[f] || w.indirect[f].is_empty() {
                continue;
            }
            let mut by_sig: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();
            for &s in &w.indirect[f] {
                by_sig.entry(s).or_default();
            }
            for e in &self.edges[f] {
                let Target::Indirect { sig, .. } = &e.target;
                let set = by_sig.entry(*sig).or_default();
                for &t in self.by_sig_table.get(sig).map(|v| v.as_slice()).unwrap_or(&[]) {
                    if self.admit(e, t) {
                        set.insert(t);
                    }
                }
            }
            for (s, t) in by_sig {
                out.push((f as u32, sigs.names[s as usize].clone(), t.into_iter().collect()));
            }
        }
        out
    }

    /// Per caller of `_pthread_cleanup_pop` with facts: the handlers its own
    /// `pthread_cleanup_push` calls install.
    pub(crate) fn cleanup_pairs(&self) -> Vec<(String, Vec<String>)> {
        let w = self.w;
        let mut out = vec![];
        for f in 0..w.names.len() {
            if w.import[f] || !w.direct[f].iter().any(|&c| w.names[c as usize] == "_pthread_cleanup_pop") {
                continue;
            }
            if !matches!(self.view[f], View::One | View::Many) {
                continue;
            }
            let hs: Vec<String> = self.side.reg_by_fn.get(&("cleanup".to_string(), w.names[f].clone())).map(|v| v.iter().cloned().collect()).unwrap_or_default();
            out.push((w.names[f].clone(), hs));
        }
        out
    }
}

/// Names and Wasm parameter types of the module's defined functions, in
/// index order.
pub(crate) fn defined_functions(module: &Module) -> Vec<(u32, String, &[ValType])> {
    let mut v: Vec<(u32, String, &[ValType])> = module
        .funcs
        .iter()
        .filter(|f| matches!(f.kind, FunctionKind::Local(_)))
        .map(|f| (f.id().index() as u32, f.name.clone().unwrap_or_default(), module.types.params(f.ty())))
        .collect();
    v.sort_by_key(|x| x.0);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Per function: (name, own type ids, linked parameters, reached types).
    fn fixture(fns: &[(&str, &[&str], &[&str], &[&str])]) -> (Side, Reach, Interner) {
        let (mut side, mut reach, mut tys) = (Side::default(), Reach::new(), Interner::default());
        for &(f, own, ks, reached) in fns {
            for t in own {
                for k in ks {
                    side.slot_links.push((t.to_string(), k.to_string(), f.to_string()));
                }
            }
            let mut r: Vec<u32> = reached.iter().map(|u| tys.id(u)).collect();
            r.sort_unstable();
            reach.insert(f.to_string(), r);
        }
        (side, reach, tys)
    }

    fn link_edges(side: &Side, reach: &Reach, tys: &Interner) -> Vec<(String, String)> {
        let mut out = vec![];
        link_slots(side, reach, tys, &mut |a, b| out.push((a.to_string(), b.to_string())));
        out
    }

    /// The plugin slots each plugin slot feeds, through any join slots.
    fn feeds(edges: &[(String, String)]) -> BTreeSet<(String, String)> {
        let mut succ: HashMap<&str, Vec<&str>> = HashMap::new();
        for (a, b) in edges {
            succ.entry(a).or_default().push(b);
        }
        let mut out = BTreeSet::new();
        for &from in succ.keys().filter(|a| !a.starts_with('#')) {
            let mut work = vec![from];
            let mut seen = HashSet::new();
            while let Some(x) = work.pop() {
                for &y in succ.get(x).into_iter().flatten() {
                    if !seen.insert(y) {
                        continue;
                    }
                    if y.starts_with('#') {
                        work.push(y);
                    } else {
                        out.insert((from.to_string(), y.to_string()));
                    }
                }
            }
        }
        out
    }

    /// The same flow with every reached type linked to the function directly.
    fn direct_feeds(side: &Side, reach: &Reach, tys: &Interner) -> BTreeSet<(String, String)> {
        let mut out = BTreeSet::new();
        for (t, k, f) in &side.slot_links {
            let reached = reach.get(f).into_iter().flatten().map(|&u| tys.names[u as usize].as_str());
            for u in std::iter::once(t.as_str()).chain(reached) {
                out.insert(if k == "ret" { (format!("r:{f}"), format!("rt:{u}")) } else { (format!("pt:{u}:{k}"), format!("p:{f}:{k}")) });
            }
        }
        out
    }

    #[test]
    fn join_slots_carry_the_same_flow_as_direct_links() {
        let abc: &[&str] = &["A", "B", "C"];
        let (side, reach, tys) = fixture(&[
            // Two own type ids (exact and generalized), like the plugin writes.
            ("f1", &["F", "F.generalized"], &["0", "ret"], abc),
            ("f2", &["G"], &["0", "1", "ret"], abc),
            ("f3", &["H"], &["0"], &["B", "C"]),
            ("f4", &["F"], &["0", "1"], &[]),
            ("f5", &["A"], &["1"], abc),
        ]);
        assert_eq!(feeds(&link_edges(&side, &reach, &tys)), direct_feeds(&side, &reach, &tys));
    }

    #[test]
    fn functions_sharing_a_reach_set_share_its_edges() {
        // GLib's case: every function cast through GCallback reaches every
        // type GCallback is cast back to.
        let types: Vec<String> = (0..300).map(|i| format!("T{i}")).collect();
        let types: Vec<&str> = types.iter().map(String::as_str).collect();
        let fns: Vec<(String, String)> = (0..300).map(|i| (format!("f{i}"), format!("F{i}"))).collect();
        let own: Vec<[&str; 1]> = fns.iter().map(|(_, t)| [t.as_str()]).collect();
        let spec: Vec<(&str, &[&str], &[&str], &[&str])> =
            fns.iter().zip(&own).map(|((f, _), own)| (f.as_str(), &own[..], &["0"][..], &types[..])).collect();
        let (side, reach, tys) = fixture(&spec);
        let edges = link_edges(&side, &reach, &tys);
        // Per function its own link and one from the join slot, plus one per
        // reached type into the join slot; direct links would be 300 * 301.
        assert_eq!(edges.len(), 300 + 300 + 300);
        assert_eq!(feeds(&edges), direct_feeds(&side, &reach, &tys));
    }
}
