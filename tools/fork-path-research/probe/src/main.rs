// Why is a function on the fork path? Rebuild the reverse call graph with
// direct edges and type-matched call_indirect edges (the same soundness rule
// the instrumenter uses), then report: direct-only vs full closure size, which
// indirect signature types drag in the most callers, and for each such type the
// first fork-reaching function of that type (the "witness") plus its chain.
use std::collections::{HashMap, HashSet, VecDeque};
use walrus::ir::*;
use walrus::*;

#[derive(Default)]
struct Calls { direct: Vec<FunctionId>, indirect: Vec<TypeId> }
struct V<'a> { c: &'a mut Calls }
impl<'i, 'a> Visitor<'i> for V<'a> {
    fn visit_call(&mut self, i: &Call) { self.c.direct.push(i.func); }
    fn visit_return_call(&mut self, i: &ReturnCall) { self.c.direct.push(i.func); }
    fn visit_call_indirect(&mut self, i: &CallIndirect) { self.c.indirect.push(i.ty); }
    fn visit_return_call_indirect(&mut self, i: &ReturnCallIndirect) { self.c.indirect.push(i.ty); }
}

fn main() {
    let path = std::env::args().nth(1).unwrap();
    let m = Module::from_file(&path).unwrap();
    let name = |f: FunctionId| m.funcs.get(f).name.clone().unwrap_or_else(|| format!("#{}", f.index()));
    let mut calls: HashMap<FunctionId, Calls> = HashMap::new();
    for f in m.funcs.iter() {
        if let FunctionKind::Local(l) = &f.kind {
            let mut c = Calls::default();
            dfs_in_order(&mut V { c: &mut c }, l, l.entry_block());
            calls.insert(f.id(), c);
        }
    }
    // Address-taken functions (table members), grouped by type.
    let mut in_table: HashSet<FunctionId> = HashSet::new();
    for e in m.elements.iter() {
        match &e.items {
            ElementItems::Functions(v) => in_table.extend(v.iter().copied()),
            ElementItems::Expressions(_, exprs) => for ex in exprs {
                if let ConstExpr::RefFunc(f) = ex { in_table.insert(*f); }
            },
        }
    }
    let ty_of = |f: FunctionId| m.funcs.get(f).ty();
    let mut rev_direct: HashMap<FunctionId, Vec<FunctionId>> = HashMap::new();
    let mut rev_indirect: HashMap<TypeId, Vec<FunctionId>> = HashMap::new();
    for (caller, c) in &calls {
        for &d in &c.direct { rev_direct.entry(d).or_default().push(*caller); }
        let tys: HashSet<TypeId> = c.indirect.iter().copied().collect();
        for t in tys { rev_indirect.entry(t).or_default().push(*caller); }
    }
    let seeds: Vec<FunctionId> = m.imports.iter().filter_map(|i| match i.kind {
        ImportKind::Function(f) if i.module == "kernel" && i.name == "kernel_fork" => Some(f), _ => None }).collect();
    println!("functions={} local={} table-members={} seeds={}", m.funcs.iter().count(), calls.len(), in_table.len(), seeds.len());
    for &s in &seeds { for c in rev_direct.get(&s).into_iter().flatten() { println!("  direct caller of fork: {}", name(*c)); } }

    let closure = |use_indirect: bool| {
        let mut seen: HashSet<FunctionId> = seeds.iter().copied().collect();
        let mut parent: HashMap<FunctionId, (FunctionId, bool)> = HashMap::new();
        let mut type_witness: Vec<(TypeId, FunctionId)> = vec![];
        let mut tainted: HashSet<TypeId> = HashSet::new();
        let mut q: VecDeque<FunctionId> = seeds.iter().copied().collect();
        while let Some(f) = q.pop_front() {
            for &c in rev_direct.get(&f).into_iter().flatten() {
                if seen.insert(c) { parent.insert(c, (f, false)); q.push_back(c); }
            }
            if use_indirect && in_table.contains(&f) {
                let t = ty_of(f);
                if tainted.insert(t) {
                    type_witness.push((t, f));
                    for &c in rev_indirect.get(&t).into_iter().flatten() {
                        if seen.insert(c) { parent.insert(c, (f, true)); q.push_back(c); }
                    }
                }
            }
        }
        (seen, parent, type_witness)
    };
    let (direct, _, _) = closure(false);
    let (full, parent, witnesses) = closure(true);
    println!("direct-only closure={}  full closure={}", direct.len(), full.len());
    // Rank tainted types by how many callers their call_indirect sites have.
    let mut ranked: Vec<_> = witnesses.iter().map(|&(t, w)| (rev_indirect.get(&t).map_or(0, |v| v.len()), t, w)).collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    for (n, t, w) in ranked.iter().take(12) {
        let ty = m.types.get(*t);
        println!("\n{} functions call_indirect type {:?}->{:?}; witness: {}", n, ty.params(), ty.results(), name(*w));
        let mut cur = *w; let mut depth = 0;
        while let Some(&(next, via_ind)) = parent.get(&cur) {
            println!("    {} {}", if via_ind { "~>" } else { "->" }, name(next).chars().take(140).collect::<String>());
            cur = next; depth += 1; if depth > 14 { println!("    ..."); break; }
        }
    }

    // ---- Experiment: seal self-contained C libraries -------------------
    // Indirect-call sites inside a sealed library may only target functions
    // of the same library (what a field-sensitive function-pointer analysis
    // would likely prove for these libraries). Also report which libraries
    // the baseline fork-path set comes from.
    let lib_of: HashMap<String, String> = std::env::args().nth(2).map(|p| {
        std::fs::read_to_string(p).unwrap().lines().filter_map(|l| {
            let (a, b) = l.split_once('\t')?; Some((a.to_string(), b.to_string()))
        }).collect()
    }).unwrap_or_default();
    let lib = |f: FunctionId| -> String {
        let n = name(f);
        lib_of.get(&n).or_else(|| lib_of.get(n.rsplit_once('_').map(|x| x.0).unwrap_or(&n))).cloned().unwrap_or_else(|| "?".into())
    };
    let mut per_lib: HashMap<String, (usize, usize)> = HashMap::new();
    for f in calls.keys() { let e = per_lib.entry(lib(*f)).or_default(); e.1 += 1; if full.contains(f) { e.0 += 1; } }
    let mut pl: Vec<_> = per_lib.into_iter().collect(); pl.sort_by(|a, b| b.1.0.cmp(&a.1.0));
    println!("\nfork-path functions by library (on path / total):");
    for (l, (a, t)) in pl.iter().take(25) { println!("  {:>6} / {:<6} {}", a, t, l); }
    let sealed_re = ["freetype/", "harfbuzz/", "libpng/", "zlib/", "libxml2/", "libiconv/", "BundledLibjpeg", "fontconfig/", "libxkbcommon/", "Pcre2", "expat/"];
    let is_sealed = |l: &str| sealed_re.iter().any(|s| l.contains(s));
    let mut seen: HashSet<FunctionId> = seeds.iter().copied().collect();
    let mut q: VecDeque<FunctionId> = seeds.iter().copied().collect();
    let mut t_any: HashSet<TypeId> = HashSet::new();
    let mut t_lib: HashSet<(TypeId, String)> = HashSet::new();
    while let Some(f) = q.pop_front() {
        for &c in rev_direct.get(&f).into_iter().flatten() { if seen.insert(c) { q.push_back(c); } }
        if in_table.contains(&f) {
            let t = ty_of(f); let lf = lib(f);
            let first_any = t_any.insert(t);
            let first_lib = t_lib.insert((t, lf.clone()));
            for &c in rev_indirect.get(&t).into_iter().flatten() {
                let lc = lib(c);
                let ok = if is_sealed(&lc) { first_lib && lc == lf } else { first_any };
                if ok && seen.insert(c) { q.push_back(c); }
            }
        }
    }
    println!("\nsealed-C-libraries closure = {} (baseline {})", seen.len(), full.len());

    // ---- Experiment: which fork call sites seed the cascade? ------------
    let fork_fn: Vec<FunctionId> = calls.keys().copied().filter(|f| name(*f) == "fork").collect();
    let mut fork_callers: Vec<FunctionId> = vec![];
    for &s in seeds.iter().chain(fork_fn.iter()) {
        for c in rev_direct.get(&s).into_iter().flatten() { if !fork_fn.contains(c) { fork_callers.push(*c); } }
    }
    fork_callers.sort(); fork_callers.dedup();
    println!("\nsites that call fork/kernel_fork directly:");
    for c in &fork_callers { println!("  {} (address-taken: {})", name(*c), in_table.contains(c)); }
    let run = |drop: &HashSet<FunctionId>| -> usize {
        let mut seen: HashSet<FunctionId> = seeds.iter().copied().collect();
        let mut q: VecDeque<FunctionId> = seeds.iter().copied().collect();
        let mut tainted: HashSet<TypeId> = HashSet::new();
        while let Some(f) = q.pop_front() {
            for &c in rev_direct.get(&f).into_iter().flatten() {
                if (seeds.contains(&f) || fork_fn.contains(&f)) && drop.contains(&c) { continue; }
                if seen.insert(c) { q.push_back(c); }
            }
            if in_table.contains(&f) && tainted.insert(ty_of(f)) {
                for &c in rev_indirect.get(&ty_of(f)).into_iter().flatten() { if seen.insert(c) { q.push_back(c); } }
            }
        }
        seen.len()
    };
    for keep in &fork_callers {
        let drop: HashSet<FunctionId> = fork_callers.iter().copied().filter(|c| c != keep).collect();
        println!("  only {} forks -> closure {}", name(*keep), run(&drop));
    }
}
