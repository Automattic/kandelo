// Typed fork-path reachability.
//
// Baseline (what wasm-fork-instrument does): a call_indirect of Wasm type W may
// reach any table function of type W. Typed: when a function's IR indirect call
// sites line up exactly (same Wasm signature multiset) with its Wasm
// call_indirect sites, its sites of type W may only reach table functions whose
// CFI type ids match (icall: function type id; vcall: class id + vtable slot).
// Untyped IR sites, functions without IR, and mismatched functions fall back to
// the baseline rule. Table functions with no type info stay reachable from
// every typed site of their Wasm type (sound mode), or only from fallback sites
// (optimistic mode: simulates also covering the C libraries).
use std::collections::{HashMap, HashSet, VecDeque};
use walrus::ir::*;
use walrus::*;

#[derive(Default, Clone)]
struct SigSummary { icall: HashSet<String>, vcall: HashSet<(String, u32)>, untyped: bool }

struct V<'a> { direct: &'a mut Vec<FunctionId>, ind: &'a mut Vec<TypeId> }
impl<'i, 'a> Visitor<'i> for V<'a> {
    fn visit_call(&mut self, i: &Call) { self.direct.push(i.func); }
    fn visit_return_call(&mut self, i: &ReturnCall) { self.direct.push(i.func); }
    fn visit_call_indirect(&mut self, i: &CallIndirect) { self.ind.push(i.ty); }
    fn visit_return_call_indirect(&mut self, i: &ReturnCallIndirect) { self.ind.push(i.ty); }
}

fn vt(t: ValType) -> &'static str {
    match t { ValType::I32 => "i32", ValType::I64 => "i64", ValType::F32 => "f32", ValType::F64 => "f64", ValType::V128 => "v128", _ => "ref" }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let m = Module::from_file(&args[1]).unwrap();
    let side = std::fs::read_to_string(&args[2]).unwrap();
    let mode = args.get(3).cloned().unwrap_or_default();
    let optimistic = mode == "optimistic" || mode == "lower";
    let lower = mode == "lower";
    let allow = |k: &str| std::env::var(format!("ALLOW_{}", k)).is_ok();
    // Optional: indirect sites inside these functions reach nothing (models a
    // precise callback registry for libc hubs; an optimistic bound).
    let hub_block: HashSet<String> = std::env::var("HUBS").ok()
        .map(|p| std::fs::read_to_string(p).unwrap().lines().map(String::from).collect()).unwrap_or_default();
    // Optional: only these functions' fallback edges are admitted.
    let fallback_only: Option<HashSet<String>> = std::env::var("FALLBACK_ONLY").ok()
        .map(|p| std::fs::read_to_string(p).unwrap().lines().map(String::from).collect());

    // ---- sidecar
    // defs: name -> list of (sig multiset sorted, per-sig summary)
    let mut fn_types: HashMap<String, HashSet<String>> = HashMap::new();
    let mut vslots: HashMap<String, HashSet<(String, u32)>> = HashMap::new();
    let mut defs: HashMap<String, Vec<(Vec<String>, HashMap<String, SigSummary>)>> = HashMap::new();
    let mut cur: Vec<(usize, String, String)> = vec![]; // (siteidx, sig, kind...)
    let mut ir_callees: HashMap<String, HashSet<String>> = HashMap::new();
    // Callback registries: registry -> functions registered with it.
    let mut registered: HashMap<String, HashSet<String>> = HashMap::new();
    let mut reg_unknown: HashSet<String> = HashSet::new();
    for line in side.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        match f[0] {
            "T" => { fn_types.entry(f[1].into()).or_default().insert(f[2].into()); }
            "V" => { vslots.entry(f[1].into()).or_default().insert((f[2].into(), f[3].parse().unwrap_or(0))); }
            "C" => { ir_callees.entry(f[1].into()).or_default().insert(f[2].into()); }
            "R" => {
                if f[2] == "*" { reg_unknown.insert(f[1].to_string()); }
                else { registered.entry(f[1].to_string()).or_default().insert(f[2].to_string()); }
            }
            "S" => { cur.push((f[2].parse().unwrap(), f[3].into(), f[4..].join("\t"))); }
            "D" => {
                let n: usize = f[2].parse().unwrap();
                let mut sigs: Vec<String> = vec![String::new(); n];
                let mut per: HashMap<String, SigSummary> = HashMap::new();
                for (i, sig, kind) in cur.drain(..) {
                    if i < n { sigs[i] = sig.clone(); }
                    let e = per.entry(sig).or_default();
                    let k: Vec<&str> = kind.split('\t').collect();
                    match k[0] {
                        "icall" => { e.icall.insert(k[1].into()); }
                        "vcall" => { e.vcall.insert((k[1].into(), k[2].parse().unwrap_or(0))); }
                        _ => { e.untyped = true; }
                    }
                }
                sigs.sort();
                defs.entry(f[1].into()).or_default().push((sigs, per));
            }
            _ => {}
        }
    }

    // ---- wasm
    let name = |f: FunctionId| m.funcs.get(f).name.clone().unwrap_or_default();
    let sig_of = |t: TypeId| { let ty = m.types.get(t);
        format!("{}->{}", ty.params().iter().map(|&p| vt(p)).collect::<Vec<_>>().join(","), ty.results().iter().map(|&p| vt(p)).collect::<Vec<_>>().join(",")) };
    let mut in_table: HashSet<FunctionId> = HashSet::new();
    for e in m.elements.iter() {
        match &e.items {
            ElementItems::Functions(v) => in_table.extend(v.iter().copied()),
            ElementItems::Expressions(_, ex) => for x in ex { if let ConstExpr::RefFunc(f) = x { in_table.insert(*f); } },
        }
    }
    let mut rev_direct: HashMap<FunctionId, Vec<FunctionId>> = HashMap::new();
    // callers[W] = list of (G, summary-or-fallback)
    let mut callers: HashMap<String, Vec<(FunctionId, Option<SigSummary>)>> = HashMap::new();
    let (mut n_local, mut n_typed, mut n_noir, mut n_mismatch, mut n_with_ind) = (0, 0, 0, 0, 0);
    for f in m.funcs.iter() {
        let FunctionKind::Local(l) = &f.kind else { continue };
        n_local += 1;
        let (mut direct, mut ind) = (vec![], vec![]);
        dfs_in_order(&mut V { direct: &mut direct, ind: &mut ind }, l, l.entry_block());
        for d in direct { rev_direct.entry(d).or_default().push(f.id()); }
        if ind.is_empty() { continue; }
        n_with_ind += 1;
        let mut wsigs: Vec<String> = ind.iter().map(|&t| sig_of(t)).collect();
        wsigs.sort();
        let nm = name(f.id());
        let exact = defs.get(&nm).and_then(|ds| ds.iter().find(|(s, _)| *s == wsigs)).map(|(_, p)| p.clone());
        // Inlining differs between the analysis compile and the shipped
        // compile: explain each wasm call_indirect signature by the function's
        // own IR sites or those of IR functions it calls directly (depth 4).
        let chosen: Option<HashMap<String, SigSummary>> = exact.or_else(|| {
            if !defs.contains_key(&nm) { return None; }
            let mut per: HashMap<String, SigSummary> = HashMap::new();
            let mut seen_n: HashSet<String> = HashSet::new();
            let mut frontier = vec![nm.clone()];
            for _ in 0..5 {
                let mut next = vec![];
                for n in frontier {
                    if !seen_n.insert(n.clone()) { continue; }
                    for (_, p) in defs.get(&n).into_iter().flatten() {
                        for (w, sm) in p {
                            let e = per.entry(w.clone()).or_default();
                            e.icall.extend(sm.icall.iter().cloned());
                            e.vcall.extend(sm.vcall.iter().cloned());
                            e.untyped |= sm.untyped;
                        }
                    }
                    if !defs.contains_key(&n) {
                        // Callee without IR (e.g. a C library): unknown sites.
                        per.entry("*".into()).or_default().untyped = true;
                    }
                    for c in ir_callees.get(&n).into_iter().flatten() { next.push(c.clone()); }
                }
                frontier = next;
            }
            let ok = wsigs.iter().all(|w| per.contains_key(w));
            if ok { Some(per) } else { None }
        });
        let chosen = chosen.as_ref().map(|p| ((), p));
        if chosen.is_some() { n_typed += 1 } else if defs.contains_key(&nm) {
            n_mismatch += 1;
            if std::env::var("DUMP").is_ok() { eprintln!("MISMATCH\t{}\twasm={:?}\tir={:?}", nm, wsigs, defs[&nm].iter().map(|d| d.0.clone()).collect::<Vec<_>>()); }
        } else { n_noir += 1; if std::env::var("DUMP").is_ok() { eprintln!("NOIR\t{}", nm); } }
        let mut uniq: Vec<String> = wsigs.clone(); uniq.dedup();
        for w in uniq {
            let s = chosen.map(|(_, per)| per.get(&w).cloned().unwrap_or_default());
            callers.entry(w).or_default().push((f.id(), s));
        }
    }
    // libc / libc++ dispatch sites for standard callback registries:
    // (dispatching function, callback type id, registry).
    let hub_table: &[(&str, &str, &str)] = &[
        ("__pthread_exit", "_ZTSFvPvE", "tsd"), ("__pthread_exit", "_ZTSFvPvE", "cleanup"),
        ("__pthread_tsd_run_dtors", "_ZTSFvPvE", "tsd"),
        ("_pthread_cleanup_pop", "_ZTSFvPvE", "cleanup"),
        ("__funcs_on_exit", "_ZTSFvPvE", "exit"),
        ("__cxxabiv1::(anonymous namespace)::run_dtors(void*)", "_ZTSFvPvE", "exit"),
        ("__pthread_once_full", "_ZTSFvvE", "once"), ("call", "_ZTSFvvE", "once"),
        ("start", "_ZTSFPvS_E", "thread"), ("start_c11", "_ZTSFiPvE", "thread"),
        ("bsearch", "_ZTSFiPKvS0_E", "cmp"), ("wrapper_cmp", "_ZTSFiPKvS0_E", "cmp"),
        ("sift_down", "_ZTSFiPKvS0_PvE", "cmp"),
        ("__fork_handler", "_ZTSFvvE", "atfork"),
        ("std::__terminate(void (*)())", "_ZTSFvvE", "terminate"),
        ("std::__unexpected(void (*)())", "_ZTSFvvE", "unexpected"),
        ("operator new(unsigned long)", "_ZTSFvvE", "new_handler"),
        ("operator new(unsigned long, std::align_val_t)", "_ZTSFvvE", "new_handler"),
    ];
    let mut hubs: HashMap<String, Vec<(String, String)>> = HashMap::new();
    if std::env::var("NO_REGISTRIES").is_err() {
        for (h, t, r) in hub_table { hubs.entry(h.to_string()).or_default().push((t.to_string(), r.to_string())); }
    }
    // A registration made by code we have no side file for is invisible:
    // the registry becomes unknown (sound fallback to type matching).
    let reg_callees: &[(&str, &str)] = &[
        ("pthread_key_create", "tsd"), ("__pthread_key_create", "tsd"),
        ("atexit", "exit"), ("__cxa_atexit", "exit"), ("at_quick_exit", "exit"),
        ("__cxa_thread_atexit", "exit"), ("__cxa_thread_atexit_impl", "exit"),
        ("pthread_once", "once"), ("__pthread_once", "once"), ("call_once", "once"),
        ("pthread_create", "thread"), ("__pthread_create", "thread"), ("thrd_create", "thread"),
        ("qsort", "cmp"), ("qsort_r", "cmp"), ("__qsort_r", "cmp"), ("bsearch", "cmp"),
        ("_pthread_cleanup_push", "cleanup"), ("pthread_atfork", "atfork"),
        ("std::set_terminate(void (*)())", "terminate"), ("std::set_unexpected(void (*)())", "unexpected"),
        ("std::set_new_handler(void (*)())", "new_handler"),
    ];
    for f in m.funcs.iter() {
        let FunctionKind::Local(l) = &f.kind else { continue };
        let nm = name(f.id());
        if defs.contains_key(&nm) { continue; }
        let (mut direct, mut ind) = (vec![], vec![]);
        dfs_in_order(&mut V { direct: &mut direct, ind: &mut ind }, l, l.entry_block());
        for d in direct {
            let dn = name(d);
            for (c, r) in reg_callees { if dn == *c { reg_unknown.insert(r.to_string()); } }
        }
    }
    // Optional optimistic bound for flow-based analysis: function-pointer
    // (icall) edges only within one library.
    let same_lib: HashMap<String, String> = std::env::var("SAME_LIB").ok().map(|p| std::fs::read_to_string(p).unwrap()
        .lines().filter_map(|l| l.split_once('\t')).map(|(a, b)| (a.to_string(), b.split('/').next().unwrap_or(b).to_string())).collect()).unwrap_or_default();
    if let Ok(v) = std::env::var("IGNORE_UNKNOWN") { for r in v.split(',') { reg_unknown.remove(r); } }
    println!("registries: {} known, unknown: {:?}", registered.len(), reg_unknown);
    let typed_info = |f: FunctionId| { let n = name(f); fn_types.contains_key(&n) || vslots.contains_key(&n) };
    let tab_total = in_table.len();
    let tab_typed = in_table.iter().filter(|&&f| typed_info(f)).count();
    println!("local functions {n_local}; with call_indirect {n_with_ind}: typed {n_typed}, IR mismatch {n_mismatch}, no IR {n_noir}");
    println!("table functions {tab_total}: with type info {tab_typed}");

    let seeds: Vec<FunctionId> = m.imports.iter().filter_map(|i| match i.kind {
        ImportKind::Function(f) if i.module == "kernel" && i.name == "kernel_fork" => Some(f), _ => None }).collect();

    let mut parent: std::cell::RefCell<HashMap<FunctionId, (FunctionId, &'static str)>> = Default::default();
    let run = |typed: bool| -> HashSet<FunctionId> {
        parent.borrow_mut().clear();
        let mut seen: HashSet<FunctionId> = seeds.iter().copied().collect();
        let mut q: VecDeque<FunctionId> = seeds.iter().copied().collect();
        let mut fallback_done: HashSet<String> = HashSet::new();
        while let Some(f) = q.pop_front() {
            for &c in rev_direct.get(&f).into_iter().flatten() { if seen.insert(c) { parent.borrow_mut().insert(c, (f, "direct")); q.push_back(c); } }
            if !in_table.contains(&f) { continue; }
            let w = sig_of(m.funcs.get(f).ty());
            let Some(cs) = callers.get(&w) else { continue };
            let fname = name(f);
            let ft = fn_types.get(&fname);
            let fv = vslots.get(&fname);
            let f_untyped = ft.is_none() && fv.is_none();
            let first = fallback_done.insert(w.clone());
            for (g, s) in cs {
                if seen.contains(g) { continue; }
                if typed && hub_block.contains(&name(*g)) { continue; }
                let _ = first;
                let (hit, why): (bool, &'static str) = match (typed, s) {
                    (false, _) => (true, "signature"),
                    (true, None) => (!lower || (allow("FALLBACK") && fallback_only.as_ref().map_or(true, |s| s.contains(&name(*g)))), "fallback-fn"),
                    (true, Some(s)) => {
                        let hub = hubs.get(&name(*g));
                        // Registry-typed sites in a hub reach only registered callbacks.
                        let reg_ids: HashSet<&str> = hub.map(|v| v.iter().map(|(t, _)| t.as_str()).collect()).unwrap_or_default();
                        let reg_hit = hub.map_or(false, |v| v.iter().any(|(t, r)| s.icall.contains(t)
                            && ft.map_or(true, |ts| ts.contains(t))
                            && (reg_unknown.contains(r) || registered.get(r).map_or(false, |set| set.contains(&fname)))));
                        let non_reg_icall = s.icall.iter().any(|x| !reg_ids.contains(x.as_str()) && ft.map_or(false, |t| t.contains(x)));
                        if hub.is_some() && reg_hit { (true, "registry") }
                        else if hub.is_some() && non_reg_icall { (true, "icall-type") }
                        else if hub.is_some() && s.untyped && (!lower || allow("UNTYPED_SITE")) { (true, "untyped-site") }
                        else if hub.is_some() && s.vcall.is_empty() { (false, "") }
                        else if ft.map_or(false, |t| s.icall.iter().any(|x| t.contains(x)))
                            && (same_lib.is_empty() || same_lib.get(&fname).zip(same_lib.get(&name(*g))).map_or(true, |(a, b)| a == b)) { (true, "icall-type") }
                        else if fv.map_or(false, |v| s.vcall.iter().any(|x| v.contains(x))) { (true, "vcall-slot") }
                        else if s.untyped && (!lower || allow("UNTYPED_SITE")) { (true, "untyped-site") }
                        else if f_untyped && (!optimistic || allow("UNTYPED_TARGET")) { (true, "untyped-target") }
                        else { (false, "") }
                    }
                };
                if hit && seen.insert(*g) { parent.borrow_mut().insert(*g, (f, why)); q.push_back(*g); }
            }
        }
        seen
    };
    let base = run(false);
    let typed = run(true);
    if let Ok(p) = std::env::var("DUMP_SET") {
        let mut names: Vec<String> = typed.iter().map(|&f| name(f)).collect();
        names.sort(); names.dedup();
        std::fs::write(p, names.join("\n") + "\n").unwrap();
    }
    // Edge-kind census and sample explanations for the typed run.
    let par = parent.borrow();
    let mut kinds: HashMap<&str, usize> = HashMap::new();
    for (_, (_, k)) in par.iter() { *kinds.entry(k).or_default() += 1; }
    println!("edge kinds that admitted functions: {:?}", kinds);
    for pat in ["TT_RunIns", "QWidget::event(", "xmlParseDocument", "QQuickShape::updatePolish", "hb_shape_plan_execute", "QFusionStyle::drawControl"] {
        if let Some(f) = typed.iter().find(|&&f| name(f).contains(pat)) {
            println!("\nwhy {}:", name(*f).chars().take(100).collect::<String>());
            let mut cur = *f; let mut d = 0;
            while let Some(&(p, k)) = par.get(&cur) {
                println!("   [{}] {}", k, name(p).chars().take(110).collect::<String>());
                cur = p; d += 1; if d > 25 { println!("   ..."); break; }
            }
        }
    }
    println!("baseline (signature) closure: {}", base.len());
    println!("typed closure (mode={}): {}", if mode.is_empty() { "sound" } else { &mode }, typed.len());
}
