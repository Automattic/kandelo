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
    /// Where the callee value was loaded from (v3 Y record): (kind, detail).
    origin: Option<(String, String)>,
}

#[derive(Default, Clone, Debug)]
struct IrFn {
    module: u32,
    mangled: String,
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
    ("__synccall", "__synccall", 0, "synccall"),
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
    // Kandelo signal delivery (inlined into __do_syscall_impl): handlers come
    // from sigaction/signal registrations through the kernel.
    ("glue/channel_syscall.c", "*", "_ZTSFviE", &["signal"]),
    ("glue/channel_syscall.c", "*", "_ZTSFviP9siginfo_tPvE", &["signal"]),
    // musl __synccall(func, ctx): func runs in every thread's SIGSYNCCALL handler.
    ("thread/synccall.c", "handler", "_ZTSFvPvE", &["synccall"]),
    ("thread/synccall.c", "__synccall", "_ZTSFvPvE", &["synccall"]),
];

#[derive(Default)]
struct Side {
    modules: Interner,
    ids: Interner,
    /// Name-keyed definitions (legacy --side mode only).
    defs: HashMap<String, Vec<IrFn>>,
    /// Per loaded side file: function name -> definitions in that object.
    objects: Vec<HashMap<String, Vec<IrFn>>>,
    /// Per loaded side file: mangled name -> (name, variant index).
    by_mangled: Vec<HashMap<String, (String, usize)>>,
    /// Flow facts: where a function's address goes / where a parameter goes.
    xdest: HashMap<String, Vec<(String, String)>>,
    pdest: HashMap<(String, u32), Vec<(String, String)>>,
    loaded: HashMap<String, usize>,
    fn_types: HashMap<String, HashSet<u32>>,
    vslots: HashMap<String, HashSet<(u32, i64)>>,
    registered: HashMap<String, HashSet<String>>,
    /// Source-level function-pointer conversion facts (plugin v4, see
    /// KandeloFnCasts.cpp): address-taken function -> its type; functions
    /// converted to another type; value conversions' source types; record
    /// fields holding functions; records that are type-punned.
    ast_qtype: HashMap<String, HashSet<String>>,
    ast_w: HashMap<String, HashSet<String>>,
    ast_z: HashMap<String, HashSet<String>>,
    ast_g: HashMap<String, HashSet<String>>,
    ast_h: HashMap<String, HashSet<String>>,
    ast_seen: bool,
    /// File-local `struct sigaction` globals written only as sigaction()'s
    /// `old` argument: they hold already-installed handlers only.
    oldact_globals: HashSet<String>,
    /// The opaque pool (plugin `J`/`U` facts, KandeloFnCasts.cpp).
    pool_records: HashSet<String>,
    pool_types: HashSet<String>,
    /// Per-slot untyped-pointer flow (plugin SE/SO/SF/SD/SL/FT/NR facts).
    slot_edges: Vec<(String, String)>,
    slot_reads_rec: Vec<(String, String, bool)>,
    slot_reads_fn: Vec<(String, String)>,
    slot_reads_mem: Vec<(String, String, bool)>,
    slot_links: Vec<(String, String, String)>,
    rec_fn_types: HashMap<String, HashSet<String>>,
    rec_nested: HashMap<String, HashSet<String>>,
    /// Set from `--rule effective-types` before graph construction.
    effective_types: bool,
    /// Direct call sites: rc:<site> -> (callee, caller); arguments.
    call_sites: Vec<(String, String, String)>,
    call_args: HashMap<String, Vec<(u32, String)>>,
    /// setjmp/longjmp buffer identity lines (JS/JL), passed through to fsa.
    jmp_facts: Vec<String>,
    /// (registry, registering function) -> callbacks it registers.
    reg_by_fn: HashMap<(String, String), HashSet<String>>,
    reg_unknown: HashMap<String, Vec<String>>,
}

/// FPA_GENERALIZE=<mangled \t demangled tsv>: function type ids compare with
/// every pointer and reference type generalized (clang's
/// -fsanitize-cfi-icall-generalize-pointers equivalence). Unparsed ids are
/// kept as they are.
fn gid(s: &str) -> String {
    use std::sync::OnceLock;
    static MAP: OnceLock<Option<HashMap<String, String>>> = OnceLock::new();
    let m = MAP.get_or_init(|| {
        let p = std::env::var("FPA_GENERALIZE").ok().filter(|s| !s.is_empty())?;
        let mut m = HashMap::new();
        for l in std::fs::read_to_string(p).unwrap().lines() {
            if let Some((a, b)) = l.split_once('\t') {
                if let Some(d) = b.strip_prefix("typeinfo name for ") {
                    if let Some(g) = generalize_fn_type(d) {
                        m.insert(a.to_string(), g);
                    }
                }
            }
        }
        eprintln!("generalized {} function type ids", m.len());
        Some(m)
    });
    match m {
        Some(m) => m.get(s).cloned().unwrap_or_else(|| s.to_string()),
        None => s.to_string(),
    }
}

fn generalize_fn_type(d: &str) -> Option<String> {
    let b = d.as_bytes();
    let (mut angle, mut paren) = (0i32, 0i32);
    let mut open = None;
    for (i, &c) in b.iter().enumerate() {
        match c {
            b'<' => angle += 1,
            b'>' => angle -= 1,
            b'(' => {
                if angle == 0 && paren == 0 && i > 0 && b[i - 1] == b' ' && open.is_none() {
                    open = Some(i);
                }
                paren += 1;
            }
            b')' => paren -= 1,
            _ => {}
        }
    }
    let open = open?;
    // Matching close paren of the parameter list.
    let mut depth = 0i32;
    let mut close = None;
    for (i, &c) in b.iter().enumerate().skip(open) {
        match c {
            b'(' | b'<' | b'[' => depth += 1,
            b')' | b'>' | b']' => {
                depth -= 1;
                if depth == 0 && c == b')' {
                    close = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    let ret = d[..open].trim();
    if ret.contains('(') {
        return None; // returns a function pointer: leave as is
    }
    let mut parts = vec![];
    let (mut depth, mut start) = (0i32, open + 1);
    for i in open + 1..close {
        match b[i] {
            b'(' | b'<' | b'[' => depth += 1,
            b')' | b'>' | b']' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(d[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(d[start..close].trim());
    let g = |t: &str| -> String {
        let mut x = t.trim();
        for q in [" const", " volatile", " restrict"] {
            while let Some(y) = x.strip_suffix(q) {
                x = y.trim_end();
            }
        }
        if x.ends_with('*') || x.ends_with('&') || x.contains("(*)") || x.contains("::*") {
            "ptr".to_string()
        } else {
            t.to_string()
        }
    };
    let ps: Vec<String> = parts.iter().filter(|p| !p.is_empty()).map(|p| g(p)).collect();
    Some(format!("G:{}({}){}", g(ret), ps.join(","), d[close + 1..].trim()))
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
        self.by_mangled.push(HashMap::new());
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
    // AL precedes this file's slot facts when the unit was compiled with
    // -fno-strict-aliasing.
    let mut relaxed = text.lines().any(|l| l == "AL\trelaxed");
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
            "#kandelo-calltypes" => versions_ok &= matches!(f.get(1), Some(&"2") | Some(&"3") | Some(&"4") | Some(&"5")),
            "M" => module = side.modules.id(f[1]),
            "F" => cur = Some((f[1].to_string(), IrFn { module, mangled: f.get(5).unwrap_or(&"").to_string(), ..Default::default() })),
            "Y" => {
                let i = site(&mut cur, f[2]);
                cur.as_mut().unwrap().1.sites[i].origin = Some((f[3].to_string(), f.get(4).unwrap_or(&"").to_string()));
            }
            "O" => {
                side.oldact_globals.insert(f[1].to_string());
            }
            "J" => {
                side.pool_records.insert(f[1].to_string());
            }
            "U" => {
                side.pool_types.insert(f[1].to_string());
            }
            "SE" => side.slot_edges.push((f[1].to_string(), f[2].to_string())),
            "AL" => relaxed = true,
            "SO" => side.slot_reads_rec.push((f[1].to_string(), f[2].to_string(), relaxed)),
            "SF" => side.slot_reads_fn.push((f[1].to_string(), f[2].to_string())),
            "SD" => side.slot_reads_mem.push((f[1].to_string(), f[2].to_string(), relaxed)),
            "SL" => side.slot_links.push((f[1].to_string(), f[2].to_string(), f[3].to_string())),
            "FT" => {
                side.rec_fn_types.entry(f[1].to_string()).or_default().insert(f[2].to_string());
            }
            "JS" | "JL" => side.jmp_facts.push(line.to_string()),
            "SC" => side.call_sites.push((f[1].to_string(), f[2].to_string(), f[3].to_string())),
            "SA" => side.call_args.entry(f[1].to_string()).or_default().push((f[2].parse().unwrap_or(0), f[3].to_string())),
            "NR" => {
                side.rec_nested.entry(f[1].to_string()).or_default().insert(f[2].to_string());
            }
            "Q" => {
                side.ast_seen = true;
                side.ast_qtype.entry(f[1].to_string()).or_default().insert(f[2].to_string());
            }
            "W" => {
                side.ast_w.entry(f[1].to_string()).or_default().insert(f[2].to_string());
            }
            "Z" => {
                side.ast_z.entry(f[1].to_string()).or_default().insert(f[2].to_string());
            }
            "G" => {
                side.ast_g.entry(f[2].to_string()).or_default().insert(f[1].to_string());
            }
            "H" => {
                side.ast_h.entry(f[1].to_string()).or_default().insert(f.get(2).unwrap_or(&"*").to_string());
            }
            "X" => side.xdest.entry(f[1].to_string()).or_default().push((f[2].to_string(), f.get(3).unwrap_or(&"").to_string())),
            "P" => side
                .pdest
                .entry((f[1].to_string(), f[2].parse().unwrap()))
                .or_default()
                .push((f[3].to_string(), f.get(4).unwrap_or(&"").to_string())),
            "T" => {
                let id = side.ids.id(&gid(f[2]));
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
                    "icall" => Some((0, side.ids.id(&gid(f[5])), 0)),
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
                    let obj = side.objects.last_mut().unwrap();
                    let v = obj.entry(name.clone()).or_default();
                    if !fnr.mangled.is_empty() {
                        side.by_mangled.last_mut().unwrap().insert(fnr.mangled.clone(), (name, v.len()));
                    }
                    v.push(fnr);
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
                    if let Some((fname, _)) = cur.as_ref() {
                        side.reg_by_fn.entry((f[1].to_string(), fname.clone())).or_default().insert(name.to_string());
                    }
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
    fn visit_const(&mut self, i: &Const) {
        if let Value::I32(v) = i.value {
            self.consts.push(v as i64);
        }
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
        w.sig[i] = sig_of(&module, f.ty(), sigs);
        match &f.kind {
            FunctionKind::Import(_) => w.import[i] = true,
            FunctionKind::Local(l) => {
                let mut ind = vec![];
                dfs_in_order(
                    &mut Calls { consts: &mut w.consts[i], direct: &mut w.direct[i], indirect: &mut ind, tail: &mut w.tail_calls, refs: &mut w.call_refs },
                    l,
                    l.entry_block(),
                );
                w.indirect[i] = ind.into_iter().map(|t| sig_of(&module, t, sigs)).collect();
            }
            _ => {}
        }
    }
    for e in module.elements.iter() {
        if let ElementKind::Active { offset, .. } = &e.kind {
            if let Some(base) = match offset {
                ConstExpr::Value(Value::I32(v)) => Some(*v as i64),
                _ => None,
            } {
                if let ElementItems::Functions(v) = &e.items {
                    for (k, f) in v.iter().enumerate() {
                        w.slots.insert(base + k as i64, f.index() as u32);
                    }
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
            // `input:(symbol)`: the symbol is the object's own name for the
            // function (e.g. __main_argc_argv for main).
            match item.rfind(":(") {
                Some(p) => out.push((item[..p].to_string(), vec![item[p + 2..item.len().saturating_sub(1)].to_string()])),
                None => out.push((item.to_string(), vec![])),
            }
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
fn bind<'s>(w: &Wasm, bi: &BindInputs, side: &'s mut Side, sigs: &mut Interner) -> Vec<Vec<(usize, String, Option<usize>)>> {
    let entries = map_code_entries(&bi.map);
    let locals: Vec<usize> = (0..w.names.len()).filter(|&i| !w.import[i]).collect();
    assert_eq!(entries.len(), locals.len(), "map CODE entries vs defined functions");
    // Hashes recorded at link time (loose objects and build-tree archives).
    let mut loose: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(p) = &bi.inputs {
        for l in std::fs::read_to_string(p).unwrap().lines() {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() >= 2 && f[1] != "-" {
                loose.entry(f[0].to_string()).or_default().push(f[1].to_string());
            }
        }
    }
    let mut aliases: HashMap<(String, String), Vec<String>> = HashMap::new();
    if let Some(p) = &bi.aliases {
        for l in std::fs::read_to_string(p).unwrap().lines() {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() == 3 {
                let v = if f[0] == "glue" || f[2].starts_with('/') { f[2].to_string() } else { format!("{}/{}.calltypes", bi.side_dir, f[2]) };
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
            if let Some(hs) = loose.get(input) {
                let ps: Vec<String> = hs.iter().map(|h| format!("{}/{h}.calltypes", bi.side_dir)).filter(|p| exists(p)).collect();
                if !ps.is_empty() {
                    *how.entry("link-time-sha").or_default() += 1;
                    return ps;
                }
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
            let b = base(input);
            for g in ["channel_syscall", "compiler_rt", "cxxrt", "dlopen"] {
                // Link-time glue objects: `channel_syscall-<hash>.o` from older
                // SDKs, `kandelo-glue-*/channel_syscall.o` since glue is
                // compiled at a fixed -O2 before the link.
                if b.starts_with(&format!("{g}-")) || b == format!("{g}.o") {
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
            // The map's section symbol is the mangled name: exact variant.
            if let Some((n, vi)) = syms.first().and_then(|m| side.by_mangled[oi].get(m)).cloned() {
                out[f].push((oi, n, Some(vi)));
                continue;
            }
            out[f].push((oi, names.iter().find(|n| side.objects[oi].contains_key(*n)).cloned().unwrap_or_default(), None));
        }
    }
    let mut hv: Vec<_> = how.into_iter().collect();
    hv.sort();
    eprintln!("binding: inputs by method {hv:?}; side files loaded {}", side.objects.len());
    let mut missing: Vec<(String, usize)> = vec![];
    let mut cnt: HashMap<&str, usize> = HashMap::new();
    for (k, (input, _)) in entries.iter().enumerate() {
        if out[locals[k]].iter().all(|(_, n, _)| n.is_empty()) {
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
    /// hub index -> [(callback type id, registries)]
    hubs: Vec<Vec<(u32, Vec<String>)>>,
    /// Flow rule (field-sensitive function-pointer matching).
    flow: bool,
    hub_first: bool,
    noir_optimistic: bool,
    drop: Vec<String>,
    main_direct: bool,
    casts: bool,
    tainted: HashMap<String, HashSet<String>>,
    flow_cache: std::cell::RefCell<HashMap<String, Option<HashSet<(String, String)>>>>,
    reg_unknown: HashMap<String, Vec<String>>,
    by_sig_table: HashMap<u32, Vec<u32>>,
    extra_registered: Vec<(String, String)>,
    cut_cancel: usize,
}

#[derive(Clone, Default)]
struct Rules {
    /// musl cancellation: pthread_exit from the cancel module only when a
    /// writer of `pthread.cancel` (pthread_cancel, timer_create) is linked.
    cancel: bool,
    /// Simulated source restructures: direct edges caller>callee removed.
    cuts: Vec<(String, String)>,
    /// Field-sensitive function-pointer flow (MLTA-style; assumes no struct
    /// type punning).
    flow: bool,
    /// What-if: registries asserted complete by a source audit (their
    /// unknown markers are dropped). Not sound by itself.
    known: Vec<String>,
    /// At registry hubs, decide by registration before falling back to
    /// signature matching for targets without type facts. Sound when the
    /// registry is complete: an unregistered function cannot be dispatched
    /// by the hub whatever its type.
    hub_first: bool,
    /// What-if upper bound on coverage: table functions without type facts
    /// are never admitted at typed sites.
    noir_optimistic: bool,
    /// Attribution what-ifs (unsound): admission kinds never admitted.
    drop: Vec<String>,
    /// What-if: `main` is called directly by the crt, not through the table.
    main_direct: bool,
    /// What-if: functions whose indirect call edges are removed.
    cutsite: Vec<String>,
    /// pthread_cleanup_pop runs the handler its own lexical push installed
    /// (POSIX requires push/pop pairs in one lexical scope): the hub inside
    /// `_pthread_cleanup_pop` dispatches only to the caller's own handlers.
    cleanup_lexical: bool,
    /// Exact type matching except for functions the source shows may be
    /// called through another function type (plugin v4 facts): those match
    /// by Wasm signature, as today.
    casts: bool,
    /// The coarser variant: tainted functions match by Wasm signature.
    casts_sig: bool,
    /// Include the opaque pool (plugin `J`/`U` facts) in `casts`.
    pool: bool,
    /// Include per-slot untyped-pointer flow (plugin `S*` facts) in `casts`.
    slots: bool,
    /// Apply C's effective-type rule to struct read-backs in units compiled
    /// with strict aliasing (see `slot_flow`).
    effective_types: bool,
    /// Calls through an old-action `struct sigaction` global (plugin `O`
    /// facts) dispatch registered signal handlers only.
    sigaction_old: bool,
}

/// Functions that may be called through a function type other than their
/// own (see KandeloFnCasts.cpp): converted directly; of a type whose values
/// are converted; or stored in a record that is type-punned.
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
        side.call_args.get(site).map(|v| v.iter().filter(|(i, _)| k.map_or(true, |k| *i == k)).map(|(_, s)| s.as_str()).collect()).unwrap_or_default()
    };
    loop {
        let mut changed = false;
        for &f in &known {
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
    let pt = summ.values().filter(|(p, o)| !p.is_empty() && o.is_empty()).count();
    eprintln!("slots: {} call sites; {} functions return only their parameters", side.call_sites.len(), pt);
    out
}

/// Per-slot propagation of untyped-pointer origins (see KandeloFnCasts.cpp,
/// "slots"). Returns extra conversion starts per function and extra
/// type-to-type conversions, given the conversion reach computed so far
/// (functions reached through casts also receive indirect-call arguments of
/// the types they reach).
fn slot_flow(side: &Side, reach: &HashMap<String, HashSet<String>>) -> (HashMap<String, HashSet<String>>, HashMap<String, HashSet<String>>) {
    let mut ids: HashMap<String, u32> = HashMap::new();
    let mut names: Vec<String> = vec![];
    let mut id = |s: &str, ids: &mut HashMap<String, u32>, names: &mut Vec<String>| -> u32 {
        if let Some(&i) = ids.get(s) {
            return i;
        }
        let i = names.len() as u32;
        names.push(s.to_string());
        ids.insert(s.to_string(), i);
        i
    };
    let mut succ: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut add_edge = |a: &str, b: &str, ids: &mut HashMap<String, u32>, names: &mut Vec<String>, succ: &mut HashMap<u32, Vec<u32>>| {
        let (x, y) = (id(a, ids, names), id(b, ids, names));
        succ.entry(x).or_default().push(y);
    };
    for (a, b) in &side.slot_edges {
        add_edge(a, b, &mut ids, &mut names, &mut succ);
    }
    // Call-site results. Summaries: which parameters of each function reach
    // its return value through its own locals and calls, and whether
    // anything else (a global, a field, an origin it creates) does.
    for (site, callee, _caller, from) in pass_through_edges(side) {
        let _ = callee;
        add_edge(&from, &site, &mut ids, &mut names, &mut succ);
    }
    // Function f of type T: its parameter k is fed by every indirect call of
    // type T, and of every type its conversions reach.
    let mut types_of: HashMap<&str, Vec<String>> = HashMap::new();
    for (t, _, fname) in &side.slot_links {
        types_of.entry(fname.as_str()).or_default().push(t.clone());
    }
    for (t, k, fname) in &side.slot_links {
        let mut ts: Vec<String> = vec![t.clone()];
        if let Some(r) = reach.get(fname) {
            ts.extend(r.iter().cloned());
        }
        for u in ts {
            if k == "ret" {
                add_edge(&format!("r:{fname}"), &format!("rt:{u}"), &mut ids, &mut names, &mut succ);
            } else {
                add_edge(&format!("pt:{u}:{k}"), &format!("p:{fname}:{k}"), &mut ids, &mut names, &mut succ);
            }
        }
    }
    // Propagate origin sets.
    let n = names.len();
    let mut orig: Vec<HashSet<u32>> = vec![HashSet::new(); n];
    let mut work: VecDeque<u32> = VecDeque::new();
    for i in 0..n {
        if names[i].starts_with('@') {
            orig[i].insert(i as u32);
            work.push_back(i as u32);
        }
    }
    while let Some(x) = work.pop_front() {
        let Some(ss) = succ.get(&x) else { continue };
        let ox = orig[x as usize].clone();
        for &y in ss {
            let before = orig[y as usize].len();
            orig[y as usize].extend(ox.iter().copied());
            if orig[y as usize].len() != before {
                work.push_back(y);
            }
        }
    }
    let at = |slot: &str| -> Vec<&str> {
        ids.get(slot).map(|&i| orig[i as usize].iter().map(|&o| names[o as usize].as_str()).collect()).unwrap_or_default()
    };
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
    let fns_in = |r: &str| -> Vec<String> {
        closure(r).iter().flat_map(|x| side.ast_g.get(x).into_iter().flatten().cloned()).collect()
    };
    let types_in = |r: &str| -> Vec<String> {
        closure(r).iter().flat_map(|x| side.rec_fn_types.get(x).into_iter().flatten().cloned()).collect()
    };
    let mut starts: HashMap<String, HashSet<String>> = HashMap::new();
    let mut z: HashMap<String, HashSet<String>> = HashMap::new();
    let slot_dbg = std::env::var("FPA_SLOT_DEBUG").ok();
    // What-if (diagnosis only, unsound): ignore read-backs at these slots.
    let ignored: HashSet<String> = std::env::var("FPA_SLOT_IGNORE")
        .map(|v| v.split('|').map(|x| x.to_string()).collect())
        .unwrap_or_default();
    let only: Option<Vec<String>> = std::env::var("FPA_SLOT_ONLY").ok().map(|v| v.split('|').map(|x| x.to_string()).collect());
    let at = |slot: &str| -> Vec<&str> {
        if ignored.contains(slot) || only.as_ref().is_some_and(|o| !o.iter().any(|p| slot.starts_with(p.as_str()))) {
            vec![]
        } else {
            at(slot)
        }
    };
    let kinds = std::env::var("FPA_SLOT_KINDS").unwrap_or_else(|_| "rec,fn,mem".into());
    // C's effective-type rule (--rule effective-types): in a unit compiled
    // with strict aliasing, the compiler itself assumes a struct is never
    // read through an unrelated struct type, so such read-backs cannot be
    // relied on by a correct program and are not modelled; in units compiled
    // with -fno-strict-aliasing they are.
    let eff = side.effective_types;
    for (slot, s_rec, _) in side.slot_reads_rec.iter().filter(|_| kinds.contains("rec")).filter(|(_, _, rel)| !eff || *rel) {
        for o in at(slot) {
            if let Some(r) = o.strip_prefix("@rec:") {
                if r != s_rec {
                    if let Some(d) = &slot_dbg {
                        if r.contains(d.as_str()) || s_rec.contains(d.as_str()) || d == "rec" {
                            eprintln!("SLOT-DEBUG\trec\t{slot}\t{r}\t{s_rec}");
                        }
                    }
                    let ts = types_in(s_rec);
                    for f in fns_in(r) {
                        starts.entry(f).or_default().extend(ts.iter().cloned());
                    }
                }
            }
        }
    }
    let show = |what: &str, slot: &str, o: &str, t: &str| {
        if let Some(d) = &slot_dbg {
            if t.contains(d.as_str()) || o.contains(d.as_str()) {
                eprintln!("SLOT-DEBUG\t{what}\t{slot}\t{o}\t{t}");
            }
        }
    };
    for (slot, u) in side.slot_reads_fn.iter().filter(|_| kinds.contains("fn")) {
        for o in at(slot) {
            show("fn", slot, o, u);
            if let Some(f) = o.strip_prefix("@fn:") {
                starts.entry(f.to_string()).or_default().insert(u.clone());
            } else if let Some(t) = o.strip_prefix("@ty:") {
                if t != u {
                    z.entry(t.to_string()).or_default().insert(u.clone());
                }
            }
        }
    }
    for (slot, u, _) in side.slot_reads_mem.iter().filter(|_| kinds.contains("mem")).filter(|(_, _, rel)| !eff || *rel) {
        for o in at(slot) {
            if let Some(r) = o.strip_prefix("@rec:") {
                for f in fns_in(r) {
                    starts.entry(f).or_default().insert(u.clone());
                }
            }
        }
    }
    let star = at("*").len();
    eprintln!(
        "slots: {} slots, {} edges, {} origins reach the unknown slot; {} functions gain conversion targets",
        n,
        side.slot_edges.len(),
        star,
        starts.len()
    );
    (starts, z)
}

fn tainted_fns(side: &Side, any_sig: bool, pool: bool) -> HashMap<String, HashSet<String>> {
    tainted_fns2(side, any_sig, pool, false)
}

fn tainted_fns2(side: &Side, any_sig: bool, pool: bool, slots: bool) -> HashMap<String, HashSet<String>> {
    if !slots {
        return tainted_fns1(side, any_sig, pool, &HashMap::new(), &HashMap::new());
    }
    // Iterate: slot flow depends on what conversions reach, and adds to it.
    let mut reach = tainted_fns1(side, any_sig, pool, &HashMap::new(), &HashMap::new());
    for round in 0..4 {
        let (st, z) = slot_flow(side, &reach);
        let next = tainted_fns1(side, any_sig, pool, &st, &z);
        let changed = next != reach;
        reach = next;
        if !changed {
            eprintln!("slots: converged after {} rounds", round + 1);
            break;
        }
    }
    reach
}

fn tainted_fns1(
    side: &Side,
    any_sig: bool,
    pool: bool,
    extra_starts: &HashMap<String, HashSet<String>>,
    extra_z: &HashMap<String, HashSet<String>>,
) -> HashMap<String, HashSet<String>> {
    if !side.ast_seen {
        eprintln!("WARNING: --rule casts without plugin v4 facts: nothing is tainted (unsound)");
    }
    // Conversion starts per function: direct conversions, and the types its
    // record is punned to.
    let mut starts: HashMap<String, HashSet<String>> = side.ast_w.clone();
    for (f, ts) in extra_starts {
        starts.entry(f.clone()).or_default().extend(ts.iter().cloned());
    }
    // The opaque pool: functions stored in pooled records enter `*`, and
    // `*` may be read back as any pooled type.
    let mut z = side.ast_z.clone();
    for (t, us) in extra_z {
        z.entry(t.clone()).or_default().extend(us.iter().cloned());
    }
    if pool {
        for r in &side.pool_records {
            for f in side.ast_g.get(r).map(|v| v.iter()).into_iter().flatten() {
                starts.entry(f.clone()).or_default().insert("*".to_string());
            }
        }
        z.entry("*".to_string()).or_default().extend(side.pool_types.iter().cloned());
    }
    let side_z = &z;
    for (r, tos) in &side.ast_h {
        for f in side.ast_g.get(r).map(|v| v.iter()).into_iter().flatten() {
            starts.entry(f.clone()).or_default().extend(tos.iter().cloned());
        }
    }
    // A function of type T also reaches whatever a T-typed value is
    // converted to.
    let zfrom: HashSet<&String> = side_z.keys().filter(|k| *k != "*").collect();
    let own = |f: &str| -> Vec<String> {
        let mut v: Vec<String> = side.ast_qtype.get(f).map(|s| s.iter().cloned().collect()).unwrap_or_default();
        if let Some(ids) = side.fn_types.get(f) {
            v.extend(ids.iter().map(|&i| side.ids.names[i as usize].clone()));
        }
        v
    };
    let mut fns: HashSet<String> = starts.keys().cloned().collect();
    for f in side.ast_qtype.keys().chain(side.fn_types.keys()) {
        if own(f).iter().any(|t| zfrom.contains(t)) {
            fns.insert(f.clone());
        }
    }
    let closure = |seeds: Vec<String>| -> HashSet<String> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut work = seeds;
        while let Some(t) = work.pop() {
            if !seen.insert(t.clone()) {
                continue;
            }
            if let Some(nx) = side_z.get(&t) {
                work.extend(nx.iter().cloned());
            }
        }
        seen
    };
    let mut out = HashMap::new();
    for f in &fns {
        let mut seeds: Vec<String> = starts.get(f).map(|s| s.iter().cloned().collect()).unwrap_or_default();
        seeds.extend(own(f));
        let r = if any_sig { ["<any>".to_string()].into_iter().collect() } else { closure(seeds) };
        out.insert(f.clone(), r);
    }
    eprintln!(
        "casts: {} tainted functions ({} converted directly, {} value-conversion types, {} punned records){}",
        out.len(),
        side.ast_w.len(),
        side.ast_z.len(),
        side.ast_h.len(),
        if any_sig { " [matched by Wasm signature]" } else { " [matched along conversion chains]" }
    );
    out
}

fn build_graph<'a>(w: &'a Wasm, side: &'a Side, cands: &[Vec<&'a IrFn>], rules: Rules) -> Graph<'a> {
    let rules_cuts = rules.cuts.clone();
    let n = w.names.len();
    let mut g = Graph {
        w,
        side,
        view: vec![View::NoIr; n],
        view_fn: vec![None; n],
        fty: vec![None; n],
        edges: vec![vec![]; n],
        irsites: vec![],
        hubs: vec![],
        flow: rules.flow,
        hub_first: rules.hub_first,
        noir_optimistic: rules.noir_optimistic,
        drop: rules.drop.clone(),
        main_direct: rules.main_direct,
        casts: rules.casts || rules.casts_sig,
        tainted: if rules.casts || rules.casts_sig { tainted_fns2(side, rules.casts_sig, rules.pool, rules.slots) } else { HashMap::new() },
        flow_cache: Default::default(),
        reg_unknown: side.reg_unknown.iter().filter(|(k, _)| !rules.known.contains(k)).map(|(k, v)| (k.clone(), v.clone())).collect(),
        by_sig_table: HashMap::new(),
        extra_registered: vec![],
        cut_cancel: 0,
    };
    let cancel_writers = ["pthread_cancel", "timer_create"].iter().any(|n| w.by_name.contains_key(*n));
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
        if !has_ir && w.names[f].starts_with(".Lregister_call_dtors") {
            // LLVM's WebAssemblyLowerGlobalDtors synthesizes this function
            // after IR: it registers this object's `.Lcall_dtors*` with
            // __cxa_atexit. Check that every table slot it names holds one.
            let ok = w.direct[f].iter().all(|&c| w.names[c as usize] == "__cxa_atexit")
                && w.consts[f].iter().all(|v| w.slots.get(v).map_or(true, |&t| w.names[t as usize].starts_with(".Lcall_dtors")));
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
        } else if name.starts_with(".Lcall_dtors") && side.ids.get(&gid("_ZTSFvPvE")).is_some() {
            // Synthesized by LLVM's WebAssemblyLowerGlobalDtors as
            // `void call_dtors(void*)`; only ever registered with __cxa_atexit.
            g.fty[f] = Some([side.ids.get(&gid("_ZTSFvPvE")).unwrap()].into_iter().collect());
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
                    if rules.cancel
                        && !cancel_writers
                        && single
                        && (cname == "__pthread_exit" || cname == "pthread_exit")
                        && side.modules.names[chosen[0].module as usize].ends_with("thread/wasm32posix/pthread_cancel.c")
                    {
                        g.cut_cancel += 1;
                        continue;
                    }
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
                    let hub_entries: Vec<usize> = (0..HUBS.len())
                        .filter(|&h| {
                            let (m, hf, _, _) = HUBS[h];
                            single && (hf == "*" || *name == hf) && side.modules.names[v.module as usize].ends_with(m)
                        })
                        .collect();
                    for (i, s) in v.sites.iter().enumerate() {
                        let Some(sig) = s.sig else { continue };
                        if s.direct.is_some() {
                            continue;
                        }
                        let gi = g.irsites.len();
                        g.irsites.push(s);
                        let entries: Vec<(u32, Vec<String>)> = hub_entries
                            .iter()
                            .filter_map(|&h| {
                                let tid = side.ids.get(&gid(HUBS[h].2))?;
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
                        edges.push(Edge {
                            site: if single { Some(i as u32) } else { None },
                            ir: Some(gi),
                            target: Target::Indirect { sig, typed: Some(gi), hub: hub_ix },
                        });
                    }
                }
            }
        }
        if !rules_cuts.is_empty() {
            edges.retain(|e| match e.target {
                Target::Direct(c) => !rules_cuts.iter().any(|(a, b)| *name == *a && w.names[c as usize] == *b),
                _ => true,
            });
        }
        if rules.main_direct && (name == "libc_start_main_stage2" || name == "__libc_start_main") {
            // The crt calls main directly (the what-if's whole point).
            for m in ["main", "__main_argc_argv", "__main_void"] {
                for &t in w.by_name.get(m).map(|v| v.as_slice()).unwrap_or(&[]) {
                    edges.push(Edge { site: None, ir: None, target: Target::Direct(t) });
                }
            }
        }
        if rules.cutsite.iter().any(|c| c == name) {
            edges.retain(|e| matches!(e.target, Target::Direct(_)));
        }
        if rules.cleanup_lexical {
            if name == "_pthread_cleanup_pop" {
                edges.retain(|e| matches!(e.target, Target::Direct(_)));
            } else if w.direct[f].iter().any(|&c| w.names[c as usize] == "_pthread_cleanup_pop") {
                if let Some(hs) = side.reg_by_fn.get(&("cleanup".to_string(), name.to_string())) {
                    for h in hs {
                        for &t in w.by_name.get(h).map(|v| v.as_slice()).unwrap_or(&[]) {
                            edges.push(Edge { site: None, ir: None, target: Target::Direct(t) });
                        }
                    }
                }
            }
        }
        g.edges[f] = edges;
    }
    let untyped_tab: Vec<&str> = (0..n).filter(|&f| w.in_table[f] && g.fty[f].is_none() && side.vslots.get(&w.names[f]).is_none()).map(|f| w.names[f].as_str()).collect();
    eprintln!("table functions without type facts: {} (e.g. {:?})", untyped_tab.len(), &untyped_tab[..untyped_tab.len().min(12)]);
    eprintln!(
        "functions with IR: one variant {}, several variants {}, IR mismatch {}, no IR {}",
        stats[2], stats[3], stats[1], stats[0]
    );
    g
}

impl<'a> Graph<'a> {
    fn admit(&self, e: &Edge, t: u32, mode: Mode) -> Option<&'static str> {
        let why = self.admit0(e, t, mode)?;
        if self.drop.iter().any(|d| d == why) {
            return None;
        }
        if self.main_direct && why != "direct" {
            let n = &self.w.names[t as usize];
            if n == "main" || n == "__main_argc_argv" || n == "__main_void" || n == "libc_start_main_stage2" {
                return None;
            }
        }
        Some(why)
    }

    fn admit0(&self, e: &Edge, t: u32, mode: Mode) -> Option<&'static str> {
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
        if let (true, Mode::Registry, Some(h)) = (self.hub_first, mode, hub) {
            // Every type id of this site is a hub id: registration decides.
            let entries = &self.hubs[*h];
            if !s.icall.is_empty() && s.vcall.is_empty() && s.icall.iter().all(|id| entries.iter().any(|(t, _)| t == id)) {
                let reg = s.icall.iter().any(|id| {
                    entries.iter().filter(|(t, _)| t == id).any(|(_, regs)| {
                        regs.iter().any(|r| {
                            self.reg_unknown.contains_key(r)
                                || self.side.registered.get(r).map_or(false, |set| set.contains(tn))
                                || self.extra_registered.iter().any(|(rr, n)| rr == r && n == tn)
                        })
                    })
                });
                let typed_ok = ft.is_none() || s.icall.iter().any(|id| ft.unwrap().contains(id));
                return (reg && typed_ok).then_some("registry");
            }
        }
        if ft.is_none() && fv.is_none() {
            return (!self.noir_optimistic).then_some("untyped-target");
        }
        if self.casts && hub.is_none() && !s.icall.is_empty() {
            if let Some(reach) = self.tainted.get(tn) {
                if reach.contains("<any>") || s.icall.iter().any(|&id| reach.contains(&self.side.ids.names[id as usize])) {
                    // Sizing what-if (unsound): FPA_FLOW_TAINTED also filters
                    // tainted admits by the flow rule.
                    if self.flow && std::env::var_os("FPA_FLOW_TAINTED").is_some() && !self.flow_ok(s, tn) {
                        return None;
                    }
                    return Some("tainted");
                }
            }
        }
        if let Some(ft) = ft {
            for id in &s.icall {
                if !ft.contains(id) {
                    continue;
                }
                if let (Mode::Registry, Some(h)) = (mode, hub) {
                    if let Some((_, regs)) = self.hubs[*h].iter().find(|(t, _)| t == id) {
                        if regs.iter().any(|r| {
                            self.reg_unknown.contains_key(r)
                                || self.side.registered.get(r).map_or(false, |set| set.contains(tn))
                                || self.extra_registered.iter().any(|(rr, n)| rr == r && n == tn)
                        }) {
                            return Some("registry");
                        }
                        continue;
                    }
                }
                if self.flow && !self.flow_ok(s, tn) {
                    continue;
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

    /// Destinations of a function's address, following parameters into
    /// callees (bounded); None when it escapes to an unmodelled place.
    fn flow_dest(&self, fname: &str) -> Option<HashSet<(String, String)>> {
        if let Some(c) = self.flow_cache.borrow().get(fname) {
            return c.clone();
        }
        let norm = |d: &str| -> String {
            // Struct names may carry per-module ".N" suffixes: merge them.
            let (ty, field) = d.rsplit_once(':').unwrap_or((d, ""));
            let mut t = ty.to_string();
            while let Some((a, b)) = t.rsplit_once('.') {
                if !b.is_empty() && b.chars().all(|c| c.is_ascii_digit()) { t = a.to_string(); } else { break; }
            }
            format!("{t}:{field}")
        };
        let mut out: HashSet<(String, String)> = HashSet::new();
        let mut work: Vec<((String, String), u32)> = self
            .side
            .xdest
            .get(fname)
            .map(|v| v.iter().map(|x| (x.clone(), 0)).collect())
            .unwrap_or_default();
        let mut escaped = work.is_empty();
        while let Some(((kind, detail), depth)) = work.pop() {
            match kind.as_str() {
                "field" => { out.insert(("field".into(), norm(&detail))); }
                "global" => { out.insert(("global".into(), detail)); }
                "arg" => {
                    out.insert(("arg".into(), detail.clone()));
                    let (callee, k) = detail.rsplit_once(':').unwrap_or((&detail, "0"));
                    let k: u32 = k.parse().unwrap_or(0);
                    match self.side.pdest.get(&(callee.to_string(), k)) {
                        Some(v) if depth < 6 => work.extend(v.iter().map(|x| (x.clone(), depth + 1))),
                        Some(_) => escaped = true,
                        None => {
                            // A callee without facts (no IR, an import): unknown.
                            escaped = true;
                        }
                    }
                }
                _ => escaped = true,
            }
            if escaped {
                break;
            }
        }
        let r = (!escaped).then_some(out);
        self.flow_cache.borrow_mut().insert(fname.to_string(), r.clone());
        r
    }

    fn flow_ok(&self, s: &IrSite, tn: &str) -> bool {
        let Some((kind, detail)) = &s.origin else { return true };
        let want = match kind.as_str() {
            "field" => {
                let (ty, field) = detail.rsplit_once(':').unwrap_or((detail, ""));
                let mut t = ty.to_string();
                while let Some((a, b)) = t.rsplit_once('.') {
                    if !b.is_empty() && b.chars().all(|c| c.is_ascii_digit()) { t = a.to_string(); } else { break; }
                }
                ("field".to_string(), format!("{t}:{field}"))
            }
            "global" => ("global".to_string(), detail.clone()),
            _ => return true, // arg / other: no flow restriction
        };
        match self.flow_dest(tn) {
            None => true,
            Some(d) => d.contains(&want),
        }
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
    // Function nodes, reported with edge index usize::MAX.
    for (i, &(f, c)) in nodes.iter().enumerate().skip(1) {
        if c == 0 {
            out.push(((f, usize::MAX), count[i]));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}

// ---------------------------------------------------------------- safety net
/// Run-time safety net prototype: in every function the instrumenter left
/// untransformed, follow each call_indirect whose type could dispatch to a
/// transformed table function with `global.get $_wpk_fork_state; if;
/// unreachable; end`. A fork unwind that returns into such a function then
/// traps instead of continuing with a half-unwound stack.
/// Returns (sites, functions).
fn guard_pass(inp: &str, out: &str, insert: bool) -> (usize, usize) {
    let mut m = Module::from_file(inp).unwrap_or_else(|e| panic!("{inp}: {e}"));
    let state = m
        .globals
        .iter()
        .find(|g| g.name.as_deref() == Some("_wpk_fork_state"))
        .expect("_wpk_fork_state")
        .id();
    struct Reads {
        state: GlobalId,
        hit: bool,
        seqs: Vec<InstrSeqId>,
    }
    impl<'i> Visitor<'i> for Reads {
        fn visit_global_get(&mut self, i: &GlobalGet) {
            self.hit |= i.global == self.state;
        }
        fn visit_global_set(&mut self, i: &GlobalSet) {
            self.hit |= i.global == self.state;
        }
        fn start_instr_seq(&mut self, seq: &'i InstrSeq) {
            self.seqs.push(seq.id());
        }
    }
    let mut instrumented = HashSet::new();
    let mut seqs_of: HashMap<FunctionId, Vec<InstrSeqId>> = HashMap::new();
    for f in m.funcs.iter() {
        if let FunctionKind::Local(l) = &f.kind {
            let mut r = Reads { state, hit: false, seqs: vec![] };
            dfs_in_order(&mut r, l, l.entry_block());
            if r.hit {
                instrumented.insert(f.id());
            }
            seqs_of.insert(f.id(), r.seqs);
        }
    }
    let mut in_table = HashSet::new();
    for e in m.elements.iter() {
        match &e.items {
            ElementItems::Functions(v) => in_table.extend(v.iter().copied()),
            ElementItems::Expressions(_, ex) => {
                for x in ex {
                    if let ConstExpr::RefFunc(f) = x {
                        in_table.insert(*f);
                    }
                }
            }
        }
    }
    let types: HashSet<TypeId> = instrumented.iter().filter(|f| in_table.contains(*f)).map(|&f| m.funcs.get(f).ty()).collect();
    let (mut sites, mut fns) = (0, 0);
    for (fid, seqs) in seqs_of {
        if instrumented.contains(&fid) {
            continue;
        }
        let lf = match &mut m.funcs.get_mut(fid).kind {
            FunctionKind::Local(l) => l,
            _ => continue,
        };
        let mut here = 0;
        for seq in seqs {
            let positions: Vec<usize> = lf
                .block(seq)
                .instrs
                .iter()
                .enumerate()
                .filter(|(_, (i, _))| matches!(i, Instr::CallIndirect(ci) if types.contains(&ci.ty)))
                .map(|(k, _)| k)
                .collect();
            for &k in positions.iter().rev() {
                here += 1;
                if !insert {
                    continue;
                }
                let cons = {
                    let mut b = lf.builder_mut().dangling_instr_seq(None);
                    b.unreachable();
                    b.id()
                };
                let alt = lf.builder_mut().dangling_instr_seq(None).id();
                let block = &mut lf.block_mut(seq).instrs;
                block.insert(k + 1, (Instr::GlobalGet(GlobalGet { global: state }), InstrLocId::default()));
                block.insert(k + 2, (Instr::IfElse(IfElse { consequent: cons, alternative: alt }), InstrLocId::default()));
            }
        }
        sites += here;
        fns += (here > 0) as usize;
    }
    m.emit_wasm_file(out).unwrap();
    (sites, fns)
}

// ---------------------------------------------------------------- main
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|a| a.as_str()) == Some("guard") {
        // fpa guard <instrumented.wasm> <out.wasm> [--count-only]
        let insert = args.get(4).map(|a| a.as_str()) != Some("--count-only");
        let (sites, fns) = guard_pass(&args[2], &args[3], insert);
        println!("guard: {sites} sites in {fns} untransformed functions ({})", if insert { "inserted" } else { "counted; module re-encoded unchanged" });
        return;
    }
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
    let mut rules = Rules::default();
    let mut export: Option<(String, String)> = None;
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
            // fork-sink research: per-function indirect targets for fsa.
            "--export-targets" => {
                let path = v();
                let mode = v();
                export = Some((path, mode));
            }
            "--rule" => match v().as_str() {
                "cancel" => rules.cancel = true,
                "flow" => rules.flow = true,
                "hubfirst" => rules.hub_first = true,
                "main-direct" => rules.main_direct = true,
                "cleanup-lexical" => rules.cleanup_lexical = true,
                "casts" => rules.casts = true,
                "casts-sig" => rules.casts_sig = true,
                "sigaction-old" => rules.sigaction_old = true,
                "pool" => rules.pool = true,
                "slots" => rules.slots = true,
                "effective-types" => rules.effective_types = true,
                r if r.starts_with("cutsite:") => rules.cutsite.push(r[8..].to_string()),
                r if r.starts_with("drop:") => rules.drop.push(r[5..].to_string()),
                "noir-optimistic" => rules.noir_optimistic = true,
                r if r.starts_with("known:") => rules.known.push(r[6..].to_string()),
                r if r.starts_with("cut:") => {
                    let (a, b) = r[4..].split_once('>').expect("cut:caller>callee");
                    rules.cuts.push((a.to_string(), b.to_string()));
                }
                r => panic!("unknown rule {r}"),
            },
            _ => panic!("unknown argument {a}"),
        }
        i += 1;
    }
    let mut sigs = Interner::default();
    let t0 = std::time::Instant::now();
    let mut w = load_wasm(wasm_path.as_deref().expect("--wasm"), &mut sigs);
    if std::env::var("FPA_IGNORE_DYNLINK").is_ok() {
        // Upper bound only: pretend no side module can fork.
        w.dyn_link = false;
    }
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
    let mut side = side;
    let cands: Vec<Vec<&IrFn>> = (0..w.names.len())
        .map(|f| match &bound {
            Some(b) => b[f]
                .iter()
                .filter(|(_, n, _)| !n.is_empty())
                .flat_map(|(oi, n, vi)| match vi {
                    Some(i) => vec![&side.objects[*oi][n][*i]],
                    None => side.objects[*oi][n].iter().collect(),
                })
                .collect(),
            None => side.defs.get(&w.names[f]).map(|v| v.iter().collect()).unwrap_or_default(),
        })
        .collect();
    side.effective_types = rules.effective_types;
    let g = build_graph(&w, &side, &cands, rules.clone());
    if rules.cancel {
        println!("rule cancel: {} direct calls to pthread_exit removed (writers linked: {})", g.cut_cancel, ["pthread_cancel", "timer_create"].iter().filter(|n| w.by_name.contains_key(**n)).count());
    }
    if let Some((path, m)) = &export {
        // One line per (function, Wasm signature of a call_indirect in it):
        // the union of targets every IR site of that signature admits.
        // Functions without usable IR fall back to the signature rule inside
        // `targets`, so the union is never narrower than the facts justify.
        let mode = match m.as_str() {
            "signature" => Mode::Signature,
            "typed" => Mode::Typed,
            "registry" => Mode::Registry,
            _ => panic!("unknown export mode {m}"),
        };
        let mut fh = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
        let mut out = vec![];
        let mut lines = 0usize;
        for f in 0..w.names.len() {
            if w.import[f] || w.indirect[f].is_empty() {
                continue;
            }
            let mut by_sig: BTreeMap<u32, std::collections::BTreeSet<u32>> = BTreeMap::new();
            for &s in &w.indirect[f] {
                by_sig.entry(s).or_default();
            }
            let dbg = std::env::var("FPA_DEBUG_FN").ok().and_then(|x| x.parse::<usize>().ok()) == Some(f);
            if dbg {
                eprintln!("debug {}: view {:?}", w.names[f], g.view[f]);
            }
            for e in &g.edges[f] {
                if let Target::Indirect { sig, .. } = &e.target {
                    g.targets(e, mode, &mut out);
                    if dbg {
                        let mut why: HashMap<&str, usize> = HashMap::new();
                        for x in out.iter() {
                            *why.entry(x.1).or_default() += 1;
                        }
                        let s = match &e.target { Target::Indirect { typed, .. } => typed.map(|gi| g.irsites[gi]), _ => None };
                        eprintln!("  edge sig {} site {:?} ir {:?}: {:?}", sigs.names[*sig as usize], e.site, s.map(|s| (&s.icall, &s.vcall, s.untyped, &s.origin)), why);
                    }
                    by_sig.entry(*sig).or_default().extend(out.iter().map(|x| x.0));
                }
            }
            for (s, t) in by_sig {
                let t: Vec<String> = t.iter().map(|x| x.to_string()).collect();
                writeln!(fh, "{f}\t{}\t{}", sigs.names[s as usize], t.join(",")).unwrap();
                lines += 1;
            }
        }
        eprintln!("exported {lines} (function, signature) target sets ({m}{}) to {path}", if rules.flow { "+flow" } else { "" });
        {
            let mut fh = std::io::BufWriter::new(std::fs::File::create(format!("{path}.jmp")).unwrap());
            let mut seen = HashSet::new();
            for l in &side.jmp_facts {
                if seen.insert(l) {
                    writeln!(fh, "{l}").unwrap();
                }
            }
        }
        if rules.cleanup_lexical {
            // Per caller of _pthread_cleanup_pop: the handlers its own
            // pthread_cleanup_push calls install (fsa --cleanup-map).
            let mut fh = std::io::BufWriter::new(std::fs::File::create(format!("{path}.cleanup")).unwrap());
            for f in 0..w.names.len() {
                if w.import[f] || !w.direct[f].iter().any(|&c| w.names[c as usize] == "_pthread_cleanup_pop") {
                    continue;
                }
                if matches!(g.view[f], View::NoIr | View::Mismatch) {
                    continue;
                }
                let hs: Vec<String> = side
                    .reg_by_fn
                    .get(&("cleanup".to_string(), w.names[f].clone()))
                    .map(|v| v.iter().cloned().collect())
                    .unwrap_or_default();
                writeln!(fh, "{}\t{}", w.names[f], hs.join("\u{1}")).unwrap();
            }
        }
    }
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
        {
            // Run-time safety net cost: every call_indirect in a function
            // outside the closure whose Wasm type could dispatch to an
            // instrumented table function needs a post-call state check.
            let mut sigs_in: HashSet<u32> = HashSet::new();
            for &f in &r.set {
                if w.in_table[f as usize] {
                    sigs_in.insert(w.sig[f as usize]);
                }
            }
            let (mut sites, mut fns, mut all_sites) = (0usize, 0usize, 0usize);
            for f in 0..w.names.len() {
                if w.import[f] || r.set.contains(&(f as u32)) {
                    continue;
                }
                all_sites += w.indirect[f].len();
                let n = w.indirect[f].iter().filter(|s| sigs_in.contains(s)).count();
                sites += n;
                fns += (n > 0) as usize;
            }
            println!(
                "  guard: {sites} call_indirect sites in {fns} uninstrumented functions need a check (of {all_sites} sites outside the closure); ~{} bytes at 8 B/site + 12 B/function",
                sites * 8 + fns * 12
            );
        }
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
                let direct_only: HashSet<u32> = direct_only.iter().map(|f| f.index() as u32).collect();
                let top: Vec<_> = top.into_iter().filter(|((f, ei), _)| *ei != usize::MAX || !direct_only.contains(f)).collect();
                for (k, ((f, ei), cnt)) in top.iter().take(census_n).enumerate() {
                    if *ei == usize::MAX {
                        println!("   {:>2}. {:>6}  [function] {}", k + 1, cnt, trunc(&w.names[*f as usize], 110));
                        if k < 8 {
                            for l in a.chain(&cur, (*f, 0)).iter().take(14) {
                                println!("          {l}");
                            }
                        }
                        continue;
                    }
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
                if let Some(((f, ei), _)) = top.iter().find(|((_, ei), _)| *ei != usize::MAX) {
                    a.blocked.insert((*f, *ei));
                }
                cur = a.run();
            }
        }
    }
}
