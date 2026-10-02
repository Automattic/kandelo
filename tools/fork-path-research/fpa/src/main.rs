//! fpa: fork-path analysis research tool.
//!
//! Computes the set of functions that may be on the call stack when
//! `kernel.kernel_fork` runs, under several edge-admission rules, so their
//! precision can be compared on real programs. The baseline is the
//! instrumenter's own analysis (`fork_instrument::call_graph`); every refined
//! rule admits a subset of the baseline's edges.
//!
//! Inputs: an unoptimized linked module with a name section (the same link
//! the instrumenter sees, before `wasm-opt`) and the concatenated
//! KandeloCallTypes v2 side files of every object linked into it.
//!
//! Rules (cumulative):
//!   signature  call_indirect may reach any table function of its Wasm type
//!   typed      sites with CFI type ids reach only functions of that type id
//!              (icall) or in that vtable slot (vcall); untyped sites and
//!              functions without IR fall back to `signature`
//!   registry   libc/libc++ registry dispatch sites reach only callbacks
//!              registered with that registry, when every registration is
//!              visible
//!   const      a call that passes a constant (or a constant-context
//!              parameter) into a parameter the callee compares reaches only
//!              the callee's call sites that stay reachable for that value
//!
//! Soundness assumptions are reported, never hidden; see the README.
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::Write as _;
use walrus::ir::*;
use walrus::*;

// ---------------------------------------------------------------- interning
#[derive(Default)]
struct Interner {
    map: HashMap<String, u32>,
    names: Vec<String>,
}
impl Interner {
    fn id(&mut self, s: &str) -> u32 {
        if let Some(&i) = self.map.get(s) {
            return i;
        }
        let i = self.names.len() as u32;
        self.names.push(s.to_string());
        self.map.insert(s.to_string(), i);
        i
    }
    fn get(&self, s: &str) -> Option<u32> {
        self.map.get(s).copied()
    }
}

// ---------------------------------------------------------------- side files
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
enum Arg {
    C { w: u32, v: u64 },
    P(u32),
}

#[derive(Default, Clone, Debug)]
struct IrSite {
    direct: Option<String>,
    sig: Option<u32>,
    icall: Vec<u32>,
    vcall: Vec<(u32, i64)>,
    untyped: bool,
    args: Vec<(u32, Arg)>,
}

#[derive(Default, Clone, Debug)]
struct IrFn {
    module: u32,
    types: Vec<u32>,
    sites: Vec<IrSite>,
    /// param -> (width, [(value | None for `*`, sorted reachable sites)])
    k: BTreeMap<u32, (u32, Vec<(Option<u64>, Vec<u32>)>)>,
}

/// Registration APIs: (demangled wasm name, mangled symbol, callback arg, registry).
const REG_APIS: &[(&str, &str, u32, &str)] = &[
    ("pthread_key_create", "pthread_key_create", 1, "tsd"),
    ("__pthread_key_create", "__pthread_key_create", 1, "tsd"),
    ("atexit", "atexit", 0, "exit"),
    ("__cxa_atexit", "__cxa_atexit", 0, "exit"),
    ("at_quick_exit", "at_quick_exit", 0, "exit"),
    ("__cxa_thread_atexit", "__cxa_thread_atexit", 0, "exit"),
    ("__cxa_thread_atexit_impl", "__cxa_thread_atexit_impl", 0, "exit"),
    ("pthread_once", "pthread_once", 1, "once"),
    ("__pthread_once", "__pthread_once", 1, "once"),
    ("call_once", "call_once", 1, "once"),
    ("pthread_create", "pthread_create", 2, "thread"),
    ("__pthread_create", "__pthread_create", 2, "thread"),
    ("thrd_create", "thrd_create", 1, "thread"),
    ("qsort", "qsort", 3, "cmp"),
    ("qsort_r", "qsort_r", 3, "cmp"),
    ("__qsort_r", "__qsort_r", 3, "cmp"),
    ("bsearch", "bsearch", 4, "cmp"),
    ("_pthread_cleanup_push", "_pthread_cleanup_push", 1, "cleanup"),
    ("pthread_atfork", "pthread_atfork", 0, "atfork"),
    ("signal", "signal", 1, "signal"),
    ("bsd_signal", "bsd_signal", 1, "signal"),
    ("sigset", "sigset", 1, "signal"),
    ("std::set_terminate(void (*)())", "_ZSt13set_terminatePFvvE", 0, "terminate"),
    ("std::set_unexpected(void (*)())", "_ZSt14set_unexpectedPFvvE", 0, "unexpected"),
    ("std::set_new_handler(void (*)())", "_ZSt15set_new_handlerPFvvE", 0, "new_handler"),
];

/// Registry dispatch sites, bound to the defining source file (module id
/// suffix) so an unrelated function with the same name is never treated as a
/// hub. Each entry was checked against the musl / libc++abi source.
/// (module suffix, function, callback type id, registries)
const HUBS: &[(&str, &str, &str, &[&str])] = &[
    // pthread_exit runs cleanup handlers and (inlined) TSD destructors.
    ("thread/pthread_create.c", "__pthread_exit", "_ZTSFvPvE", &["tsd", "cleanup"]),
    ("thread/pthread_key_create.c", "__pthread_tsd_run_dtors", "_ZTSFvPvE", &["tsd"]),
    ("thread/pthread_cleanup_push.c", "_pthread_cleanup_pop", "_ZTSFvPvE", &["cleanup"]),
    // __cxa_atexit(func, arg) handlers; atexit(f) registers `call` with f.
    ("exit/atexit.c", "__funcs_on_exit", "_ZTSFvPvE", &["exit"]),
    ("exit/atexit.c", "call", "_ZTSFvvE", &["exit"]),
    ("exit/at_quick_exit.c", "__funcs_on_quick_exit", "_ZTSFvvE", &["exit"]),
    ("cxa_thread_atexit.cpp", "__cxxabiv1::(anonymous namespace)::run_dtors(void*)", "_ZTSFvPvE", &["exit"]),
    ("thread/pthread_once.c", "__pthread_once_full", "_ZTSFvvE", &["once"]),
    ("thread/pthread_create.c", "start", "_ZTSFPvS_E", &["thread"]),
    ("thread/pthread_create.c", "start_c11", "_ZTSFiPvE", &["thread"]),
    ("stdlib/qsort_nr.c", "wrapper_cmp", "_ZTSFiPKvS0_E", &["cmp"]),
    ("stdlib/qsort.c", "sift_down", "_ZTSFiPKvS0_PvE", &["cmp"]),
    ("stdlib/bsearch.c", "bsearch", "_ZTSFiPKvS0_E", &["cmp"]),
    ("thread/pthread_atfork.c", "__fork_handler", "_ZTSFvvE", &["atfork"]),
    ("cxa_handlers.cpp", "std::__terminate(void (*)())", "_ZTSFvvE", &["terminate"]),
    ("cxa_handlers.cpp", "std::__unexpected(void (*)())", "_ZTSFvvE", &["unexpected"]),
    ("new.cpp", "operator new(unsigned long)", "_ZTSFvvE", &["new_handler"]),
    ("new.cpp", "operator new(unsigned long, std::align_val_t)", "_ZTSFvvE", &["new_handler"]),
];

#[derive(Default)]
struct Side {
    modules: Interner,
    ids: Interner,
    /// Name-keyed definitions (legacy --side mode only).
    defs: HashMap<String, Vec<IrFn>>,
    /// Per loaded side file: function name -> definitions in that object.
    objects: Vec<HashMap<String, Vec<IrFn>>>,
    loaded: HashMap<String, usize>,
    fn_types: HashMap<String, HashSet<u32>>,
    vslots: HashMap<String, HashSet<(u32, i64)>>,
    registered: HashMap<String, HashSet<String>>,
    reg_unknown: HashMap<String, Vec<String>>,
}

fn load_side(path: &str, sigs: &mut Interner) -> Side {
    let mut side = Side::default();
    side.parse(path, sigs, false);
    side
}

impl Side {
    /// Load one side file once; returns its object index.
    fn object(&mut self, path: &str, sigs: &mut Interner) -> usize {
        if let Some(&i) = self.loaded.get(path) {
            return i;
        }
        self.objects.push(HashMap::new());
        let i = self.objects.len() - 1;
        self.loaded.insert(path.to_string(), i);
        self.parse(path, sigs, true);
        i
    }

    fn parse(&mut self, path: &str, sigs: &mut Interner, per_object: bool) {
    let side = self;
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut module = side.modules.id("?");
    let mut cur: Option<(String, IrFn)> = None;
    let mut versions_ok = true;
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        let site = |cur: &mut Option<(String, IrFn)>, i: &str| -> usize {
            let i: usize = i.parse().unwrap();
            let fnr = &mut cur.as_mut().expect("record outside function").1;
            if fnr.sites.len() <= i {
                fnr.sites.resize(i + 1, IrSite::default());
            }
            i
        };
        match f[0] {
            "#kandelo-calltypes" => versions_ok &= f.get(1) == Some(&"2"),
            "M" => module = side.modules.id(f[1]),
            "F" => cur = Some((f[1].to_string(), IrFn { module, ..Default::default() })),
            "T" => {
                let id = side.ids.id(f[2]);
                side.fn_types.entry(f[1].into()).or_default().insert(id);
                if let Some((_, fnr)) = cur.as_mut() {
                    fnr.types.push(id);
                }
            }
            "V" => {
                let id = side.ids.id(f[2]);
                side.vslots.entry(f[1].into()).or_default().insert((id, f[3].parse().unwrap()));
            }
            "C" => {
                let i = site(&mut cur, f[2]);
                cur.as_mut().unwrap().1.sites[i].direct = Some(f[3].to_string());
            }
            "S" => {
                let i = site(&mut cur, f[2]);
                let sig = sigs.id(f[3]);
                let k = match f[4] {
                    "icall" => Some((0, side.ids.id(f[5]), 0)),
                    "vcall" => Some((1, side.ids.id(f[5]), f[6].parse::<i64>().unwrap())),
                    _ => None,
                };
                let s = &mut cur.as_mut().unwrap().1.sites[i];
                s.sig = Some(sig);
                match k {
                    Some((0, id, _)) => s.icall.push(id),
                    Some((_, id, off)) => s.vcall.push((id, off)),
                    None => s.untyped = true,
                }
            }
            "A" => {
                let i = site(&mut cur, f[2]);
                let a = if f[4] == "c" {
                    Arg::C { w: f[5].parse().unwrap(), v: f[6].parse().unwrap() }
                } else {
                    Arg::P(f[5].parse().unwrap())
                };
                cur.as_mut().unwrap().1.sites[i].args.push((f[3].parse().unwrap(), a));
            }
            "K" => {
                let p: u32 = f[2].parse().unwrap();
                let w: u32 = f[3].parse().unwrap();
                let v = if f[4] == "*" { None } else { Some(f[4].parse::<u64>().unwrap()) };
                let list: Vec<u32> = f
                    .get(5)
                    .map(|s| s.split(',').filter(|x| !x.is_empty()).map(|x| x.parse().unwrap()).collect())
                    .unwrap_or_default();
                let e = cur.as_mut().unwrap().1.k.entry(p).or_insert((w, vec![]));
                e.1.push((v, list));
            }
            "D" => {
                let (name, mut fnr) = cur.take().expect("D outside function");
                let n: usize = f[3].parse().unwrap();
                if fnr.sites.len() < n {
                    fnr.sites.resize(n, IrSite::default());
                }
                if per_object {
                    side.objects.last_mut().unwrap().entry(name).or_default().push(fnr);
                } else {
                    side.defs.entry(name).or_default().push(fnr);
                }
            }
            "R" => match f[2] {
                "*" => side.reg_unknown.entry(f[1].into()).or_default().push("non-constant callback".into()),
                "?" => side.reg_unknown.entry(f[1].into()).or_default().push("registration API address escapes".into()),
                s if s.starts_with('%') => {
                    // A forwarder: ignorable only when the enclosing function is
                    // itself a registration API of this registry at that argument.
                    let n: u32 = s[1..].parse().unwrap();
                    let ok = REG_APIS.iter().any(|&(_, m, a, r)| m == f[3] && a == n && r == f[1]);
                    if !ok {
                        side.reg_unknown.entry(f[1].into()).or_default().push(format!("forwarder {}", f[3]));
                    }
                }
                name => {
                    side.registered.entry(f[1].into()).or_default().insert(name.to_string());
                }
            },
            _ => {}
        }
    }
    assert!(versions_ok, "{path}: not a KandeloCallTypes v2 side file");
    }
}

// ---------------------------------------------------------------- wasm
struct Wasm {
    names: Vec<String>,
    import: Vec<bool>,
    sig: Vec<u32>,
    in_table: Vec<bool>,
    direct: Vec<Vec<u32>>,
    indirect: Vec<Vec<u32>>,
    tail_calls: usize,
    call_refs: usize,
    seeds: Vec<u32>,
    dyn_link: bool,
    module: Module,
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
    direct: &'a mut Vec<u32>,
    indirect: &'a mut Vec<TypeId>,
    tail: &'a mut usize,
    refs: &'a mut usize,
}
impl<'i, 'a> Visitor<'i> for Calls<'a> {
    fn visit_call(&mut self, i: &Call) {
        self.direct.push(i.func.index() as u32);
    }
    fn visit_return_call(&mut self, i: &ReturnCall) {
        self.direct.push(i.func.index() as u32);
        *self.tail += 1;
    }
    fn visit_call_indirect(&mut self, i: &CallIndirect) {
        self.indirect.push(i.ty);
    }
    fn visit_return_call_indirect(&mut self, i: &ReturnCallIndirect) {
        self.indirect.push(i.ty);
        *self.tail += 1;
    }
    fn visit_call_ref(&mut self, _: &CallRef) {
        *self.refs += 1;
    }
}

fn load_wasm(path: &str, sigs: &mut Interner) -> Wasm {
    let module = Module::from_file(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let n = module.funcs.iter().map(|f| f.id().index() + 1).max().unwrap_or(0);
    let mut w = Wasm {
        names: vec![String::new(); n],
        import: vec![false; n],
        sig: vec![0; n],
        in_table: vec![false; n],
        direct: vec![vec![]; n],
        indirect: vec![vec![]; n],
        tail_calls: 0,
        call_refs: 0,
        seeds: vec![],
        dyn_link: fork_instrument::call_graph::has_dynamic_linker_imports(&module),
        module: Module::default(),
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
        w.sig[i] = sig_of(&module, f.ty(), sigs);
        match &f.kind {
            FunctionKind::Import(_) => w.import[i] = true,
            FunctionKind::Local(l) => {
                let mut ind = vec![];
                dfs_in_order(
                    &mut Calls { direct: &mut w.direct[i], indirect: &mut ind, tail: &mut w.tail_calls, refs: &mut w.call_refs },
                    l,
                    l.entry_block(),
                );
                w.indirect[i] = ind.into_iter().map(|t| sig_of(&module, t, sigs)).collect();
            }
            _ => {}
        }
    }
    for e in module.elements.iter() {
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
    w.seeds = fork_instrument::call_graph::find_import_funcs(&module, "kernel.kernel_fork")
        .into_iter()
        .map(|f| f.index() as u32)
        .collect();
    w.module = module;
    w
}

// ---------------------------------------------------------------- binding
/// Members of an `ar` archive (GNU or BSD format): (name, bytes).
fn ar_members(path: &str) -> Vec<(String, Vec<u8>)> {
    let Ok(b) = std::fs::read(path) else { return vec![] };
    if !b.starts_with(b"!<arch>\n") {
        return vec![];
    }
    let mut out = vec![];
    let mut names: Vec<u8> = vec![];
    let mut off = 8;
    while off + 60 <= b.len() {
        let h = &b[off..off + 60];
        let field = |a: usize, z: usize| String::from_utf8_lossy(&h[a..z]).trim().to_string();
        let size: usize = field(48, 58).parse().unwrap_or(0);
        let mut data = off + 60;
        let mut end = data + size;
        let raw = field(0, 16);
        let name = if raw == "//" {
            names = b[data..end].to_vec();
            String::new()
        } else if raw == "/" || raw == "/SYM64/" || raw.starts_with("__.SYMDEF") {
            String::new()
        } else if let Some(n) = raw.strip_prefix("#1/") {
            let n: usize = n.parse().unwrap_or(0);
            let nm = String::from_utf8_lossy(&b[data..data + n]).trim_end_matches('\0').to_string();
            data += n;
            nm
        } else if let Some(o) = raw.strip_prefix('/').and_then(|x| x.parse::<usize>().ok()) {
            let rest = &names[o.min(names.len())..];
            let e = rest.iter().position(|&c| c == b'\n').unwrap_or(rest.len());
            String::from_utf8_lossy(&rest[..e]).trim_end_matches('/').to_string()
        } else {
            raw.trim_end_matches('/').to_string()
        };
        end = end.min(b.len());
        if !name.is_empty() && !name.starts_with("__.SYMDEF") {
            out.push((name, b[data..end].to_vec()));
        }
        off = off + 60 + size;
        off += off % 2;
    }
    out
}

fn sha256_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// One CODE entry of a wasm-ld map: (input file, symbol names).
fn map_code_entries(path: &str) -> Vec<(String, Vec<String>)> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut out: Vec<(String, Vec<String>)> = vec![];
    let mut in_code = false;
    for line in text.lines() {
        let t = line.trim_start();
        let mut it = t.splitn(4, ' ').filter(|x| !x.is_empty());
        let _ = it.next();
        // Columns: Addr Off Size, then a gap whose width tells the level.
        let cols: Vec<&str> = t.split_whitespace().take(3).collect();
        if cols.len() < 3 {
            continue;
        }
        let after = {
            let mut rest = t;
            for c in &cols {
                let p = rest.find(c).unwrap() + c.len();
                rest = &rest[p..];
            }
            rest
        };
        let gap = after.len() - after.trim_start().len();
        let item = after.trim_start();
        if gap == 1 {
            in_code = item == "CODE";
            continue;
        }
        if !in_code {
            continue;
        }
        if gap < 14 {
            let input = match item.rfind(":(") {
                Some(p) => item[..p].to_string(),
                None => item.to_string(),
            };
            out.push((input, vec![]));
        } else if let Some(last) = out.last_mut() {
            last.1.push(item.to_string());
        }
    }
    out
}

struct BindInputs {
    map: String,
    inputs: Option<String>,
    side_dir: String,
    aliases: Option<String>,
}

/// Bind every defined wasm function to the side-file definitions of the
/// exact object that supplied its code.
fn bind<'s>(w: &Wasm, bi: &BindInputs, side: &'s mut Side, sigs: &mut Interner) -> Vec<Vec<(usize, String)>> {
    let entries = map_code_entries(&bi.map);
    let locals: Vec<usize> = (0..w.names.len()).filter(|&i| !w.import[i]).collect();
    assert_eq!(entries.len(), locals.len(), "map CODE entries vs defined functions");
    let loose: HashMap<String, String> = bi
        .inputs
        .as_ref()
        .map(|p| {
            std::fs::read_to_string(p)
                .unwrap()
                .lines()
                .filter_map(|l| {
                    let f: Vec<&str> = l.split('\t').collect();
                    (f.len() >= 2 && f[1] != "-").then(|| (f[0].to_string(), f[1].to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut aliases: HashMap<(String, String), Vec<String>> = HashMap::new();
    if let Some(p) = &bi.aliases {
        for l in std::fs::read_to_string(p).unwrap().lines() {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() == 3 {
                let v = if f[0] == "glue" { f[2].to_string() } else { format!("{}/{}.calltypes", bi.side_dir, f[2]) };
                aliases.entry((f[0].to_string(), f[1].to_string())).or_default().push(v);
            }
        }
    }
    let mut ar_cache: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut per_input: HashMap<String, Vec<String>> = HashMap::new();
    let mut how: HashMap<&'static str, usize> = HashMap::new();
    let mut out = vec![vec![]; w.names.len()];
    let exists = |p: &str| std::path::Path::new(p).exists();
    for (k, (input, syms)) in entries.iter().enumerate() {
        let f = locals[k];
        let sides = per_input.entry(input.clone()).or_insert_with(|| {
            let base = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
            if input.starts_with('<') {
                *how.entry("internal").or_default() += 1;
                return vec![];
            }
            if let (true, Some(open)) = (input.ends_with(')'), input.rfind('(')) {
                let (ar, mem) = (&input[..open], &input[open + 1..input.len() - 1]);
                let members = ar_cache.entry(ar.to_string()).or_insert_with(|| {
                    ar_members(ar).into_iter().map(|(n, b)| (n, sha256_hex(&b))).collect()
                });
                let exact: Vec<String> = members
                    .iter()
                    .filter(|(n, _)| n == mem)
                    .map(|(_, h)| format!("{}/{h}.calltypes", bi.side_dir))
                    .filter(|p| exists(p))
                    .collect();
                if !exact.is_empty() {
                    *how.entry("archive-sha").or_default() += 1;
                    return exact;
                }
                if let Some(v) = aliases.get(&(base(ar), mem.to_string())) {
                    *how.entry("archive-alias").or_default() += 1;
                    return v.clone();
                }
                *how.entry("archive-none").or_default() += 1;
                return vec![];
            }
            if let Some(h) = loose.get(input) {
                let p = format!("{}/{h}.calltypes", bi.side_dir);
                if exists(&p) {
                    *how.entry("loose-sha").or_default() += 1;
                    return vec![p];
                }
            }
            let b = base(input);
            for g in ["channel_syscall", "compiler_rt", "cxxrt", "dlopen"] {
                if b.starts_with(&format!("{g}-")) {
                    if let Some(v) = aliases.get(&("glue".to_string(), g.to_string())) {
                        *how.entry("glue-alias").or_default() += 1;
                        return v.clone();
                    }
                }
            }
            if let Some(v) = aliases.get(&("loose".to_string(), b)) {
                *how.entry("loose-alias").or_default() += 1;
                return v.clone();
            }
            *how.entry("loose-none").or_default() += 1;
            vec![]
        });
        let mut names = vec![w.names[f].clone()];
        names.extend(syms.iter().cloned());
        for sp in sides.clone() {
            let oi = side.object(&sp, sigs);
            out[f].push((oi, names.iter().find(|n| side.objects[oi].contains_key(*n)).cloned().unwrap_or_default()));
        }
    }
    let mut hv: Vec<_> = how.into_iter().collect();
    hv.sort();
    eprintln!("binding: inputs by method {hv:?}; side files loaded {}", side.objects.len());
    let mut missing: Vec<(String, usize)> = vec![];
    let mut cnt: HashMap<&str, usize> = HashMap::new();
    for (k, (input, _)) in entries.iter().enumerate() {
        if out[locals[k]].iter().all(|(_, n)| n.is_empty()) {
            *cnt.entry(input.as_str()).or_default() += 1;
        }
    }
    for (i, c) in cnt {
        missing.push((i.to_string(), c));
    }
    missing.sort_by(|a, b| b.1.cmp(&a.1));
    let total: usize = missing.iter().map(|x| x.1).sum();
    eprintln!("functions without IR: {total}; top inputs:");
    for (i, c) in missing.iter().take(12) {
        eprintln!("  {c:>6}  {}", trunc(i, 140));
    }
    out
}

// ---------------------------------------------------------------- edges
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Signature,
    Typed,
    Registry,
}

#[derive(Clone, Debug)]
enum Target {
    Direct(u32),
    /// Indirect call of a Wasm signature. `site` is the IR site with its type
    /// facts, or None when the site has no usable IR (signature fallback).
    Indirect { sig: u32, typed: Option<usize>, hub: Option<usize> },
}

#[derive(Clone, Debug)]
struct Edge {
    /// IR site index for path-condition checks (single-variant functions).
    site: Option<u32>,
    /// IR site providing types and args, in `irsites` (global table).
    ir: Option<usize>,
    target: Target,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum View {
    NoIr,
    Mismatch,
    One(usize),
    Many,
}

struct Graph<'a> {
    w: &'a Wasm,
    side: &'a Side,
    /// Chosen IR variant per function.
    view: Vec<View>,
    view_fn: Vec<Option<&'a IrFn>>,
    /// CFI function type ids per function (None: no IR).
    fty: Vec<Option<HashSet<u32>>>,
    edges: Vec<Vec<Edge>>,
    irsites: Vec<&'a IrSite>,
    /// hub index -> registries
    hub_regs: Vec<Vec<String>>,
    hub_type: Vec<u32>,
    reg_unknown: HashMap<String, Vec<String>>,
    by_sig_table: HashMap<u32, Vec<u32>>,
}

fn build_graph<'a>(w: &'a Wasm, side: &'a Side, cands: &[Vec<&'a IrFn>]) -> Graph<'a> {
    let n = w.names.len();
    let mut g = Graph {
        w,
        side,
        view: vec![View::NoIr; n],
        view_fn: vec![None; n],
        fty: vec![None; n],
        edges: vec![vec![]; n],
        irsites: vec![],
        hub_regs: vec![],
        hub_type: vec![],
        reg_unknown: side.reg_unknown.clone(),
        by_sig_table: HashMap::new(),
    };
    for f in 0..n {
        if w.in_table[f] {
            g.by_sig_table.entry(w.sig[f]).or_default().push(f as u32);
        }
    }
    // Registries become unknown when code without a side file registers, or
    // when a registration API is itself address-taken in the final link.
    for f in 0..n {
        if w.import[f] {
            continue;
        }
        let has_ir = !cands[f].is_empty();
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
    let mut stats = [0usize; 4];
    for f in 0..n {
        if w.import[f] {
            continue;
        }
        let name = &w.names[f];
        let mut wsigs: Vec<u32> = w.indirect[f].clone();
        wsigs.sort();
        let variants: Option<&Vec<&IrFn>> = if cands[f].is_empty() { None } else { Some(&cands[f]) };
        if let Some(vs) = variants {
            g.fty[f] = Some(vs.iter().flat_map(|v| v.types.iter().copied()).collect());
        }
        let matching: Vec<usize> = variants
            .map(|vs| {
                vs.iter()
                    .enumerate()
                    .filter(|(_, v)| {
                        let mut s: Vec<u32> = v.sites.iter().filter(|s| s.direct.is_none()).map(|s| s.sig.unwrap_or(u32::MAX)).collect();
                        s.sort();
                        s == wsigs
                    })
                    .map(|(i, _)| i)
                    .collect()
            })
            .unwrap_or_default();
        g.view[f] = match (variants, matching.len()) {
            (None, _) => View::NoIr,
            (Some(_), 0) => View::Mismatch,
            (Some(_), 1) => View::One(matching[0]),
            _ => View::Many,
        };
        stats[match g.view[f] {
            View::NoIr => 0,
            View::Mismatch => 1,
            View::One(_) => 2,
            View::Many => 3,
        }] += 1;
        let mut edges = vec![];
        match g.view[f] {
            View::NoIr | View::Mismatch => {
                let mut seen = HashSet::new();
                for &c in &w.direct[f] {
                    if seen.insert(c) {
                        edges.push(Edge { site: None, ir: None, target: Target::Direct(c) });
                    }
                }
                let mut s2: Vec<u32> = wsigs.clone();
                s2.dedup();
                for sig in s2 {
                    edges.push(Edge { site: None, ir: None, target: Target::Indirect { sig, typed: None, hub: None } });
                }
            }
            View::One(_) | View::Many => {
                let vs = variants.unwrap();
                let chosen: Vec<&IrFn> = match g.view[f] {
                    View::One(i) => vec![vs[i]],
                    _ => matching.iter().map(|&i| vs[i]).collect(),
                };
                if let View::One(i) = g.view[f] {
                    g.view_fn[f] = Some(vs[i]);
                }
                let single = chosen.len() == 1;
                // Direct calls: explained by IR sites with the same callee
                // name when IR has at least as many such sites as Wasm calls.
                let mut wcount: HashMap<&str, usize> = HashMap::new();
                for &c in &w.direct[f] {
                    *wcount.entry(w.names[c as usize].as_str()).or_default() += 1;
                }
                let mut seen = HashSet::new();
                for &c in &w.direct[f] {
                    if !seen.insert(c) {
                        continue;
                    }
                    let cname = w.names[c as usize].as_str();
                    if single {
                        let v = chosen[0];
                        let irs: Vec<usize> = v
                            .sites
                            .iter()
                            .enumerate()
                            .filter(|(_, s)| s.direct.as_deref() == Some(cname))
                            .map(|(i, _)| i)
                            .collect();
                        for &i in &irs {
                            let gi = g.irsites.len();
                            g.irsites.push(&v.sites[i]);
                            edges.push(Edge { site: Some(i as u32), ir: Some(gi), target: Target::Direct(c) });
                        }
                        if irs.len() < wcount[cname] {
                            edges.push(Edge { site: None, ir: None, target: Target::Direct(c) });
                        }
                    } else {
                        edges.push(Edge { site: None, ir: None, target: Target::Direct(c) });
                    }
                }
                for v in &chosen {
                    let hub = HUBS.iter().position(|&(m, hf, _, _)| {
                        single && *name == hf && side.modules.names[v.module as usize].ends_with(m)
                    });
                    for (i, s) in v.sites.iter().enumerate() {
                        let Some(sig) = s.sig else { continue };
                        if s.direct.is_some() {
                            continue;
                        }
                        let gi = g.irsites.len();
                        g.irsites.push(s);
                        let hub_ix = hub.and_then(|h| {
                            let tid = side.ids.get(HUBS[h].2)?;
                            if !s.icall.contains(&tid) {
                                return None;
                            }
                            g.hub_regs.push(HUBS[h].3.iter().map(|x| x.to_string()).collect());
                            g.hub_type.push(tid);
                            Some(g.hub_regs.len() - 1)
                        });
                        edges.push(Edge {
                            site: if single { Some(i as u32) } else { None },
                            ir: Some(gi),
                            target: Target::Indirect { sig, typed: Some(gi), hub: hub_ix },
                        });
                    }
                }
            }
        }
        g.edges[f] = edges;
    }
    eprintln!(
        "functions with IR: one variant {}, several variants {}, IR mismatch {}, no IR {}",
        stats[2], stats[3], stats[1], stats[0]
    );
    g
}

impl<'a> Graph<'a> {
    fn admit(&self, e: &Edge, t: u32, mode: Mode) -> Option<&'static str> {
        let Target::Indirect { sig, typed, hub } = &e.target else { return Some("direct") };
        if self.w.sig[t as usize] != *sig || !self.w.in_table[t as usize] {
            return None;
        }
        let Some(gi) = typed else { return Some("untyped-fn") };
        if mode == Mode::Signature {
            return Some("signature");
        }
        let s = self.irsites[*gi];
        if s.untyped {
            return Some("untyped-site");
        }
        let tn = &self.w.names[t as usize];
        let ft = self.fty[t as usize].as_ref();
        let fv = self.side.vslots.get(tn);
        if ft.is_none() && fv.is_none() {
            return Some("untyped-target");
        }
        if let Some(ft) = ft {
            for id in &s.icall {
                if !ft.contains(id) {
                    continue;
                }
                if let (Mode::Registry, Some(h)) = (mode, hub) {
                    if self.hub_type[*h] == *id {
                        let regs = &self.hub_regs[*h];
                        if regs.iter().any(|r| {
                            self.reg_unknown.contains_key(r)
                                || self.side.registered.get(r).map_or(false, |set| set.contains(tn))
                        }) {
                            return Some("registry");
                        }
                        continue;
                    }
                }
                return Some("icall");
            }
        }
        if let Some(fv) = fv {
            if s.vcall.iter().any(|x| fv.contains(x)) {
                return Some("vcall");
            }
        }
        None
    }

    fn targets(&self, e: &Edge, mode: Mode, out: &mut Vec<(u32, &'static str)>) {
        out.clear();
        match &e.target {
            Target::Direct(c) => out.push((*c, "direct")),
            Target::Indirect { sig, .. } => {
                for &t in self.by_sig_table.get(sig).map(|v| v.as_slice()).unwrap_or(&[]) {
                    if let Some(why) = self.admit(e, t, mode) {
                        out.push((t, why));
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- contexts
type Ctx = Vec<(u32, u32, u64)>; // (param, width, value), sorted; empty = top

struct Analysis<'g, 'a> {
    g: &'g Graph<'a>,
    mode: Mode,
    use_const: bool,
    /// Optional seed context to exclude (kernel_fork param 0 == value).
    exclude_mode: Option<u64>,
    blocked: HashSet<(u32, usize)>,
    ctxs: Interner,
    ctx_vals: Vec<Ctx>,
}

#[derive(Default)]
struct Result1 {
    reached: HashSet<(u32, u32)>,
    parent: HashMap<(u32, u32), ((u32, u32), usize, &'static str)>,
    set: HashSet<u32>,
    why_count: HashMap<&'static str, usize>,
    contexts: Vec<Vec<u32>>,
}

impl<'g, 'a> Analysis<'g, 'a> {
    fn new(g: &'g Graph<'a>, mode: Mode, use_const: bool) -> Self {
        let mut a = Analysis { g, mode, use_const, exclude_mode: None, blocked: HashSet::new(), ctxs: Interner::default(), ctx_vals: vec![] };
        a.ctx_id(&vec![]);
        a
    }
    fn ctx_id(&mut self, c: &Ctx) -> u32 {
        let key = format!("{c:?}");
        let before = self.ctxs.names.len();
        let id = self.ctxs.id(&key);
        if self.ctxs.names.len() > before {
            self.ctx_vals.push(c.clone());
        }
        id
    }
    fn keys(&self, t: u32) -> Option<&BTreeMap<u32, (u32, Vec<(Option<u64>, Vec<u32>)>)>> {
        if !self.use_const {
            return None;
        }
        self.g.view_fn[t as usize].map(|v| &v.k).filter(|k| !k.is_empty())
    }
    fn key_width(&self, t: u32, p: u32) -> Option<u32> {
        if self.exclude_mode.is_some() && self.g.w.import[t as usize] && self.g.w.seeds.contains(&t) {
            return (p == 0).then_some(32);
        }
        self.keys(t).and_then(|k| k.get(&p)).map(|x| x.0)
    }
    fn reachable(&self, f: u32, site: Option<u32>, c: &Ctx) -> bool {
        let (Some(s), Some(k)) = (site, self.keys(f)) else { return true };
        for &(p, w, v) in c {
            let Some((kw, entries)) = k.get(&p) else { continue };
            if *kw != w {
                continue;
            }
            let e = entries.iter().find(|(x, _)| *x == Some(v)).or_else(|| entries.iter().find(|(x, _)| x.is_none()));
            if let Some((_, list)) = e {
                if list.binary_search(&s).is_err() {
                    return false;
                }
            }
        }
        true
    }
    fn derive(&self, e: &Edge, c: &Ctx, t: u32) -> Ctx {
        let Some(gi) = e.ir else { return vec![] };
        if !self.use_const {
            return vec![];
        }
        let mut out = vec![];
        for &(i, a) in &self.g.irsites[gi].args {
            let Some(w) = self.key_width(t, i) else { continue };
            match a {
                Arg::C { w: aw, v } if aw == w => out.push((i, w, v)),
                Arg::P(j) => {
                    if let Some(&(_, pw, v)) = c.iter().find(|x| x.0 == j) {
                        if pw == w {
                            out.push((i, w, v));
                        }
                    }
                }
                _ => {}
            }
        }
        out.sort();
        out
    }

    fn run(&mut self) -> Result1 {
        let g = self.g;
        let n = g.w.names.len();
        let mut r = Result1 { contexts: vec![vec![0]; n], ..Default::default() };
        let mut tmp = vec![];
        // Phase A: discover constant contexts reachable from top contexts.
        if self.use_const {
            let mut q: VecDeque<(u32, u32)> = (0..n as u32).map(|f| (f, 0)).collect();
            while let Some((f, cid)) = q.pop_front() {
                let c = self.ctx_vals[cid as usize].clone();
                for (ei, e) in g.edges[f as usize].iter().enumerate() {
                    let Some(gi) = e.ir else { continue };
                    if g.irsites[gi].args.is_empty() || self.blocked.contains(&(f, ei)) {
                        continue;
                    }
                    if !self.reachable(f, e.site, &c) {
                        continue;
                    }
                    g.targets(e, self.mode, &mut tmp);
                    for &(t, _) in &tmp {
                        let c2 = self.derive(e, &c, t);
                        if c2.is_empty() {
                            continue;
                        }
                        let id = self.ctx_id(&c2);
                        if !r.contexts[t as usize].contains(&id) {
                            r.contexts[t as usize].push(id);
                            q.push_back((t, id));
                        }
                    }
                }
            }
        }
        // Reverse edges: callee -> (caller, edge index).
        let mut rev_direct: HashMap<u32, Vec<(u32, usize)>> = HashMap::new();
        let mut rev_sig: HashMap<u32, Vec<(u32, usize)>> = HashMap::new();
        for f in 0..n as u32 {
            for (ei, e) in g.edges[f as usize].iter().enumerate() {
                match e.target {
                    Target::Direct(c) => rev_direct.entry(c).or_default().push((f, ei)),
                    Target::Indirect { sig, .. } => rev_sig.entry(sig).or_default().push((f, ei)),
                }
            }
        }
        let mut q: VecDeque<(u32, u32)> = VecDeque::new();
        let seeds: Vec<u32> = g.w.seeds.clone();
        for &s in &seeds {
            for &cid in &r.contexts[s as usize].clone() {
                let c = &self.ctx_vals[cid as usize];
                if let Some(m) = self.exclude_mode {
                    if c.iter().any(|&(p, _, v)| p == 0 && v == m) {
                        continue;
                    }
                }
                if r.reached.insert((s, cid)) {
                    q.push_back((s, cid));
                }
            }
        }
        if g.w.dyn_link {
            // Instrumenter rule: any call_indirect may enter a side module.
            for f in 0..n as u32 {
                if !g.w.indirect[f as usize].is_empty() && r.reached.insert((f, 0)) {
                    q.push_back((f, 0));
                }
            }
        }
        while let Some((t, ct)) = q.pop_front() {
            let callers: Vec<(u32, usize, &'static str)> = {
                let mut v = vec![];
                for &(f, ei) in rev_direct.get(&t).map(|x| x.as_slice()).unwrap_or(&[]) {
                    v.push((f, ei, "direct"));
                }
                if g.w.in_table[t as usize] {
                    for &(f, ei) in rev_sig.get(&g.w.sig[t as usize]).map(|x| x.as_slice()).unwrap_or(&[]) {
                        if let Some(why) = g.admit(&g.edges[f as usize][ei], t, self.mode) {
                            v.push((f, ei, why));
                        }
                    }
                }
                v
            };
            for (f, ei, why) in callers {
                if self.blocked.contains(&(f, ei)) {
                    continue;
                }
                let e = &g.edges[f as usize][ei];
                for &cid in &r.contexts[f as usize].clone() {
                    if r.reached.contains(&(f, cid)) {
                        continue;
                    }
                    let c = self.ctx_vals[cid as usize].clone();
                    if !self.reachable(f, e.site, &c) {
                        continue;
                    }
                    let c2 = self.derive(e, &c, t);
                    let c2id = if c2.is_empty() { 0 } else { match self.ctxs.get(&format!("{c2:?}")) { Some(i) => i, None => continue } };
                    if c2id != ct {
                        continue;
                    }
                    r.reached.insert((f, cid));
                    r.parent.insert((f, cid), ((t, ct), ei, why));
                    if cid == 0 {
                        *r.why_count.entry(why).or_default() += 1;
                    }
                    q.push_back((f, cid));
                }
            }
        }
        r.set = r.reached.iter().filter(|x| x.1 == 0).map(|x| x.0).collect();
        r
    }

    fn chain(&self, r: &Result1, mut node: (u32, u32)) -> Vec<String> {
        let mut out = vec![];
        let mut guard = 0;
        while let Some(&(p, ei, why)) = r.parent.get(&node) {
            let e = &self.g.edges[node.0 as usize][ei];
            let detail = match &e.target {
                Target::Indirect { typed: Some(gi), .. } => {
                    let s = self.g.irsites[*gi];
                    let ids: Vec<String> = s
                        .icall
                        .iter()
                        .map(|i| self.g.side.ids.names[*i as usize].clone())
                        .chain(s.vcall.iter().map(|(i, o)| format!("{}+{}", self.g.side.ids.names[*i as usize], o)))
                        .collect();
                    format!(" [{why} {}]", ids.join(","))
                }
                _ => format!(" [{why}]"),
            };
            let ctx = &self.ctx_vals[p.1 as usize];
            let cs = if ctx.is_empty() { String::new() } else { format!(" ctx{ctx:?}") };
            out.push(format!("{}{} <- {}{}", trunc(&self.g.w.names[p.0 as usize], 90), cs, trunc(&self.g.w.names[node.0 as usize], 90), detail));
            node = p;
            guard += 1;
            if guard > 60 {
                out.push("...".into());
                break;
            }
        }
        out
    }
}

fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { s.chars().take(n).collect::<String>() + "…" }
}

// ---------------------------------------------------------------- dominators
/// Chokepoint census: dominator tree over the reached graph with one node per
/// (caller, indirect edge). Returns (edge node -> functions it dominates).
fn census(a: &Analysis, r: &Result1) -> Vec<((u32, usize), usize)> {
    let g = a.g;
    // Node numbering: reached (f,ctx) nodes, then site nodes.
    let mut id: HashMap<(u32, u32), u32> = HashMap::new();
    let mut nodes: Vec<(u32, u32)> = vec![(u32::MAX, 0)]; // 0 = virtual root
    for &x in &r.reached {
        id.insert(x, nodes.len() as u32);
        nodes.push(x);
    }
    let mut site_id: HashMap<(u32, usize), u32> = HashMap::new();
    let mut site_of: Vec<(u32, usize)> = vec![];
    let base = nodes.len() as u32;
    let mut succ: Vec<Vec<u32>> = vec![vec![]; nodes.len()];
    let mut add = |succ: &mut Vec<Vec<u32>>, a: u32, b: u32| {
        while succ.len() <= a.max(b) as usize {
            succ.push(vec![]);
        }
        succ[a as usize].push(b);
    };
    for &s in &g.w.seeds {
        for &(f, c) in r.reached.iter().filter(|x| x.0 == s) {
            add(&mut succ, 0, id[&(f, c)]);
        }
    }
    if g.w.dyn_link {
        for f in 0..g.w.names.len() as u32 {
            if !g.w.indirect[f as usize].is_empty() {
                if let Some(&i) = id.get(&(f, 0)) {
                    add(&mut succ, 0, i);
                }
            }
        }
    }
    // Rebuild every admitted edge between reached nodes.
    let mut tmp = vec![];
    for &(f, cid) in &r.reached {
        let c = a.ctx_vals[cid as usize].clone();
        for (ei, e) in g.edges[f as usize].iter().enumerate() {
            if a.blocked.contains(&(f, ei)) || !a.reachable(f, e.site, &c) {
                continue;
            }
            g.targets(e, a.mode, &mut tmp);
            for &(t, _) in &tmp {
                let c2 = a.derive(e, &c, t);
                let c2id = if c2.is_empty() { 0 } else { match a.ctxs.get(&format!("{c2:?}")) { Some(i) => i, None => continue } };
                let Some(&tn) = id.get(&(t, c2id)) else { continue };
                let fnode = id[&(f, cid)];
                if matches!(e.target, Target::Indirect { .. }) {
                    let sn = *site_id.entry((f, ei)).or_insert_with(|| {
                        site_of.push((f, ei));
                        base + site_of.len() as u32 - 1
                    });
                    add(&mut succ, tn, sn);
                    add(&mut succ, sn, fnode);
                } else {
                    add(&mut succ, tn, fnode);
                }
            }
        }
    }
    let total = succ.len();
    for v in succ.iter_mut() {
        v.sort();
        v.dedup();
    }
    // Reverse postorder from the root.
    let mut order = vec![];
    let mut seen = vec![false; total];
    let mut stack = vec![(0u32, 0usize)];
    seen[0] = true;
    while let Some((v, i)) = stack.pop() {
        if i < succ[v as usize].len() {
            stack.push((v, i + 1));
            let w = succ[v as usize][i];
            if !seen[w as usize] {
                seen[w as usize] = true;
                stack.push((w, 0));
            }
        } else {
            order.push(v);
        }
    }
    order.reverse();
    let mut rpo = vec![u32::MAX; total];
    for (i, &v) in order.iter().enumerate() {
        rpo[v as usize] = i as u32;
    }
    let mut preds: Vec<Vec<u32>> = vec![vec![]; total];
    for v in 0..total {
        for &w in &succ[v] {
            preds[w as usize].push(v as u32);
        }
    }
    let mut idom = vec![u32::MAX; total];
    idom[0] = 0;
    let intersect = |idom: &Vec<u32>, mut a: u32, mut b: u32| {
        while a != b {
            while rpo[a as usize] > rpo[b as usize] {
                a = idom[a as usize];
            }
            while rpo[b as usize] > rpo[a as usize] {
                b = idom[b as usize];
            }
        }
        a
    };
    let mut changed = true;
    while changed {
        changed = false;
        for &v in order.iter().skip(1) {
            let mut new = u32::MAX;
            for &p in &preds[v as usize] {
                if idom[p as usize] == u32::MAX {
                    continue;
                }
                new = if new == u32::MAX { p } else { intersect(&idom, p, new) };
            }
            if new != u32::MAX && idom[v as usize] != new {
                idom[v as usize] = new;
                changed = true;
            }
        }
    }
    // Count dominated top-context function nodes (each function once).
    let mut count = vec![0usize; total];
    for &v in order.iter().rev() {
        if (v as usize) < nodes.len() && v != 0 && nodes[v as usize].1 == 0 {
            count[v as usize] += 1;
        }
        let d = idom[v as usize];
        if v != 0 && d != u32::MAX && d != v {
            count[d as usize] += count[v as usize];
        }
    }
    let mut out: Vec<((u32, usize), usize)> = site_of.iter().enumerate().map(|(i, &s)| (s, count[base as usize + i])).collect();
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}

// ---------------------------------------------------------------- main
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut wasm_path = None;
    let mut side_path = None;
    let mut map_path: Option<String> = None;
    let mut inputs_path: Option<String> = None;
    let mut side_dir: Option<String> = None;
    let mut aliases_path: Option<String> = None;
    let mut modes: Vec<String> = vec![];
    let mut dump = None;
    let mut oracle = None;
    let mut census_n = 0usize;
    let mut cuts = 0usize;
    let mut explain: Vec<String> = vec![];
    let mut exclude_mode = None;
    let mut i = 1;
    while i < args.len() {
        let a = args[i].as_str();
        let mut v = || {
            i += 1;
            args[i].clone()
        };
        match a {
            "--wasm" => wasm_path = Some(v()),
            "--side" => side_path = Some(v()),
            "--map" => map_path = Some(v()),
            "--inputs" => inputs_path = Some(v()),
            "--side-dir" => side_dir = Some(v()),
            "--aliases" => aliases_path = Some(v()),
            "--mode" => modes.push(v()),
            "--dump-set" => dump = Some(v()),
            "--oracle" => oracle = Some(v()),
            "--census" => census_n = v().parse().unwrap(),
            "--cuts" => cuts = v().parse().unwrap(),
            "--explain" => explain.push(v()),
            "--exclude-fork-mode" => exclude_mode = Some(v().parse::<u64>().unwrap()),
            _ => panic!("unknown argument {a}"),
        }
        i += 1;
    }
    let mut sigs = Interner::default();
    let t0 = std::time::Instant::now();
    let w = load_wasm(wasm_path.as_deref().expect("--wasm"), &mut sigs);
    let mut side = side_path.map(|p| load_side(&p, &mut sigs)).unwrap_or_default();
    let bound = map_path.map(|m| {
        let bi = BindInputs { map: m, inputs: inputs_path, side_dir: side_dir.expect("--side-dir"), aliases: aliases_path };
        bind(&w, &bi, &mut side, &mut sigs)
    });
    let n_local = w.import.iter().filter(|x| !**x).count();
    eprintln!(
        "loaded in {:.1}s: {} functions ({} local), {} with call_indirect, {} in table, tail calls {}, call_ref {}, dynamic-linker imports {}",
        t0.elapsed().as_secs_f64(),
        w.names.len(),
        n_local,
        w.indirect.iter().filter(|v| !v.is_empty()).count(),
        w.in_table.iter().filter(|x| **x).count(),
        w.tail_calls,
        w.call_refs,
        w.dyn_link
    );
    // Reference: the instrumenter's own closure.
    let seeds: Vec<FunctionId> = fork_instrument::call_graph::find_import_funcs(&w.module, "kernel.kernel_fork");
    let mut all_seeds = seeds.clone();
    all_seeds.extend(fork_instrument::call_graph::dynamic_linker_imported_functions(&w.module));
    let reference = fork_instrument::call_graph::analyze_reaching_closure_from_seeds(&w.module, all_seeds.iter().copied(), w.dyn_link);
    let reference_set: HashSet<u32> = reference.activations.iter().map(|f| f.index() as u32).collect();
    let direct_only = fork_instrument::call_graph::direct_reaching_closure(&w.module, seeds[0]);
    println!("instrumenter closure (activations): {}", reference_set.len());
    println!("direct-call-only closure: {}", direct_only.len());
    let side = side;
    let cands: Vec<Vec<&IrFn>> = (0..w.names.len())
        .map(|f| match &bound {
            Some(b) => b[f]
                .iter()
                .filter(|(_, n)| !n.is_empty())
                .flat_map(|(oi, n)| side.objects[*oi][n].iter())
                .collect(),
            None => side.defs.get(&w.names[f]).map(|v| v.iter().collect()).unwrap_or_default(),
        })
        .collect();
    let g = build_graph(&w, &side, &cands);
    let mut regs: Vec<_> = g.reg_unknown.iter().map(|(k, v)| format!("{k} ({})", v.first().cloned().unwrap_or_default())).collect();
    regs.sort();
    println!("unknown registries: {regs:?}");
    let mut oracle_names: Option<HashSet<String>> = oracle.map(|p| {
        std::fs::read_to_string(&p).unwrap().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty() && l != "--").collect()
    });
    if modes.is_empty() {
        modes.push("signature".into());
    }
    for m in &modes {
        let (mode, use_const) = match m.as_str() {
            "signature" => (Mode::Signature, false),
            "typed" => (Mode::Typed, false),
            "registry" => (Mode::Registry, false),
            "typed+const" => (Mode::Typed, true),
            "registry+const" => (Mode::Registry, true),
            "signature+const" => (Mode::Signature, true),
            _ => panic!("unknown mode {m}"),
        };
        let mut a = Analysis::new(&g, mode, use_const);
        a.exclude_mode = exclude_mode;
        let t1 = std::time::Instant::now();
        let r = a.run();
        let mut kinds: Vec<_> = r.why_count.iter().collect();
        kinds.sort_by(|x, y| y.1.cmp(x.1));
        println!(
            "mode {m}: closure {} ({} contexts reached, {} context ids) in {:.1}s; admitted by {:?}",
            r.set.len(),
            r.reached.len(),
            a.ctx_vals.len(),
            t1.elapsed().as_secs_f64(),
            kinds
        );
        if mode == Mode::Signature && !use_const && exclude_mode.is_none() {
            let extra = r.set.difference(&reference_set).count();
            let missing = reference_set.difference(&r.set).count();
            println!("  vs instrumenter: +{extra} -{missing}");
        }
        if let Some(on) = &mut oracle_names {
            let mut missing = vec![];
            let set_names: HashSet<&str> = r.set.iter().map(|&f| w.names[f as usize].as_str()).collect();
            for nmx in on.iter() {
                if !set_names.contains(nmx.as_str()) && !nmx.starts_with("kernel_fork") {
                    missing.push(nmx.clone());
                }
            }
            println!("  oracle: {} observed functions; {} not in this closure{}", on.len(), missing.len(), if missing.is_empty() { "" } else { " (UNSOUND)" });
            for m in missing.iter().take(20) {
                println!("    missing: {m}");
            }
        }
        for pat in &explain {
            for &f in r.set.iter() {
                if w.names[f as usize].contains(pat.as_str()) {
                    println!("  why {}:", trunc(&w.names[f as usize], 120));
                    for l in a.chain(&r, (f, 0)) {
                        println!("    {l}");
                    }
                    break;
                }
            }
        }
        if let Some(p) = &dump {
            let mut names: Vec<&str> = r.set.iter().map(|&f| w.names[f as usize].as_str()).collect();
            names.sort();
            let mut fh = std::fs::File::create(format!("{p}.{m}")).unwrap();
            for nmx in names {
                writeln!(fh, "{nmx}").unwrap();
            }
        }
        if census_n > 0 {
            let mut cur = r;
            for round in 0..=cuts {
                let t2 = std::time::Instant::now();
                let top = census(&a, &cur);
                println!("  census round {round} (closure {}, {:.1}s): top dispatch sites by dominated functions", cur.set.len(), t2.elapsed().as_secs_f64());
                for (k, ((f, ei), cnt)) in top.iter().take(census_n).enumerate() {
                    let e = &g.edges[*f as usize][*ei];
                    let desc = match &e.target {
                        Target::Indirect { sig, typed, hub } => {
                            let s = typed.map(|gi| g.irsites[gi]);
                            let ids: Vec<String> = s
                                .map(|s| {
                                    s.icall
                                        .iter()
                                        .map(|i| side.ids.names[*i as usize].clone())
                                        .chain(s.vcall.iter().map(|(i, o)| format!("{}+{}", side.ids.names[*i as usize], o)))
                                        .chain(s.untyped.then(|| "untyped".to_string()))
                                        .collect()
                                })
                                .unwrap_or_else(|| vec![format!("no-IR({:?})", g.view[*f as usize])]);
                            let consts: Vec<String> = s.map(|s| s.args.iter().filter_map(|(i, a)| match a { Arg::C { v, .. } => Some(format!("a{i}={v}")), _ => None }).collect()).unwrap_or_default();
                            format!("sig {} {} {}{}", sigs.names[*sig as usize], ids.join(","), consts.join(" "), if hub.is_some() { " HUB" } else { "" })
                        }
                        _ => String::new(),
                    };
                    println!("   {:>2}. {:>6}  {}  ::  {}", k + 1, cnt, trunc(&w.names[*f as usize], 100), desc);
                    if k < 5 {
                        for l in a.chain(&cur, (*f, 0)).iter().take(12) {
                            println!("          {l}");
                        }
                    }
                }
                if round == cuts {
                    break;
                }
                if let Some(((f, ei), _)) = top.first() {
                    a.blocked.insert((*f, *ei));
                }
                cur = a.run();
            }
        }
    }
}
