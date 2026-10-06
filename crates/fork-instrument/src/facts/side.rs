//! Parsing the compiler facts the KandeloCallTypes plugin writes per object
//! (format 4; see `sdk/src/plugin/KandeloCallTypes.cpp`
//! and `KandeloFnCasts.cpp` for every line kind).
//!
//! Each object contributes one chunk that starts with `#kandelo-calltypes\t5`.
//! Function definitions (`F` ... `D`) stay per chunk so they can be bound to
//! the linked module by order ([`super::bind`]); every other fact is
//! name-keyed and merged across chunks, as the research analysis did.
use anyhow::{Context, Result, bail, ensure};
use std::collections::{HashMap, HashSet};

/// The only facts format this analysis models.
pub const FORMAT_VERSION: &str = "5";

#[derive(Default)]
pub(crate) struct Interner {
    map: HashMap<String, u32>,
    pub(crate) names: Vec<String>,
}

impl Interner {
    pub(crate) fn id(&mut self, s: &str) -> u32 {
        if let Some(&i) = self.map.get(s) {
            return i;
        }
        let i = self.names.len() as u32;
        self.names.push(s.to_string());
        self.map.insert(s.to_string(), i);
        i
    }
    pub(crate) fn get(&self, s: &str) -> Option<u32> {
        self.map.get(s).copied()
    }
}

/// One call site of a defined function, numbered in instruction order.
#[derive(Default, Clone, Debug)]
pub(crate) struct IrSite {
    pub(crate) direct: Option<String>,
    /// Wasm signature of an indirect call (interned `i32,i32->i32`).
    pub(crate) sig: Option<u32>,
    /// CFI function type ids (`icall`), vtable (class id, offset) (`vcall`).
    pub(crate) icall: Vec<u32>,
    pub(crate) vcall: Vec<(u32, i64)>,
    pub(crate) untyped: bool,
    /// Where the callee value was loaded from (`Y`): (kind, detail).
    pub(crate) origin: Option<(String, String)>,
}

/// One function definition in one object.
#[derive(Default, Clone, Debug)]
pub(crate) struct IrFn {
    /// Interned source module id (`M`).
    pub(crate) module: u32,
    /// LLVM IR parameter count.
    pub(crate) nparams: usize,
    pub(crate) types: Vec<u32>,
    pub(crate) sites: Vec<IrSite>,
}

/// Registration APIs: (demangled wasm name, mangled symbol, callback arg, registry).
pub(crate) const REG_APIS: &[(&str, &str, u32, &str)] = &[
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
pub(crate) const HUBS: &[(&str, &str, &str, &[&str])] = &[
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

/// Every fact of every chunk.
#[derive(Default)]
pub(crate) struct Side {
    pub(crate) modules: Interner,
    pub(crate) ids: Interner,
    /// Per chunk, in order: the functions it defines, in definition order.
    pub(crate) chunks: Vec<Vec<(String, IrFn)>>,
    pub(crate) fn_types: HashMap<String, HashSet<u32>>,
    pub(crate) vslots: HashMap<String, HashSet<(u32, i64)>>,
    pub(crate) registered: HashMap<String, HashSet<String>>,
    /// Source-level function-pointer conversion facts (KandeloFnCasts.cpp):
    /// address-taken function -> its type; functions converted to another
    /// type; value conversions' source types; record fields holding
    /// functions; records that are type-punned.
    pub(crate) ast_qtype: HashMap<String, HashSet<String>>,
    pub(crate) ast_w: HashMap<String, HashSet<String>>,
    pub(crate) ast_z: HashMap<String, HashSet<String>>,
    pub(crate) ast_g: HashMap<String, HashSet<String>>,
    pub(crate) ast_h: HashMap<String, HashSet<String>>,
    /// File-local `struct sigaction` globals written only as sigaction()'s
    /// `old` argument: they hold already-installed handlers only.
    pub(crate) oldact_globals: HashSet<String>,
    /// Per-slot untyped-pointer flow (plugin SE/SO/SF/SD/SL/FT/NR facts).
    /// The `bool` on read-backs marks a unit compiled with relaxed aliasing.
    pub(crate) slot_edges: Vec<(String, String)>,
    pub(crate) slot_reads_rec: Vec<(String, String, bool)>,
    pub(crate) slot_reads_fn: Vec<(String, String)>,
    pub(crate) slot_reads_mem: Vec<(String, String, bool)>,
    pub(crate) slot_links: Vec<(String, String, String)>,
    pub(crate) rec_fn_types: HashMap<String, HashSet<String>>,
    pub(crate) rec_nested: HashMap<String, HashSet<String>>,
    /// Apply C's effective-type rule in strict-aliasing units.
    pub(crate) effective_types: bool,
    /// Direct call sites: rc:<site> -> (callee, caller); arguments.
    pub(crate) call_sites: Vec<(String, String, String)>,
    pub(crate) call_args: HashMap<String, Vec<(u32, String)>>,
    /// setjmp/longjmp buffer identity lines (JS/JL), verbatim.
    pub(crate) jmp_facts: Vec<String>,
    /// (registry, registering function) -> callbacks it registers.
    pub(crate) reg_by_fn: HashMap<(String, String), HashSet<String>>,
    pub(crate) reg_unknown: HashMap<String, Vec<String>>,
}

/// Split the linked `kandelo.calltypes` section into per-object chunks.
/// wasm-ld concatenates the objects' sections; each starts with the header.
pub(crate) fn split_chunks(text: &str) -> Result<Vec<&str>> {
    const HEADER: &str = "#kandelo-calltypes\t";
    let mut starts: Vec<usize> = vec![];
    for (i, _) in text.match_indices(HEADER) {
        ensure!(
            i == 0 || text.as_bytes()[i - 1] == b'\n',
            "facts chunk header at byte {i} does not start a line"
        );
        starts.push(i);
    }
    ensure!(!text.is_empty(), "empty facts section");
    ensure!(starts.first() == Some(&0), "facts section does not start with a chunk header");
    let mut out = Vec::with_capacity(starts.len());
    for (k, &a) in starts.iter().enumerate() {
        let b = starts.get(k + 1).copied().unwrap_or(text.len());
        out.push(&text[a..b]);
    }
    Ok(out)
}

impl Side {
    /// Parse one chunk; its definitions become `self.chunks[last]`.
    pub(crate) fn parse_chunk(&mut self, text: &str, sigs: &mut Interner) -> Result<()> {
        let side = self;
        let mut defs: Vec<(String, IrFn)> = vec![];
        let mut module = side.modules.id("?");
        let mut cur: Option<(String, IrFn)> = None;
        // AL marks a unit compiled with -fno-strict-aliasing; it applies to
        // the whole chunk.
        let mut relaxed = text.lines().any(|l| l == "AL\trelaxed");
        let mut header = false;
        for (lineno, line) in text.lines().enumerate() {
            let f: Vec<&str> = line.split('\t').collect();
            let need = |n: usize| -> Result<()> {
                ensure!(f.len() >= n, "line {}: `{}` needs {n} fields", lineno + 1, f[0]);
                Ok(())
            };
            let num = |s: &str| -> Result<usize> { s.parse::<usize>().with_context(|| format!("line {}: bad number `{s}`", lineno + 1)) };
            let site = |cur: &mut Option<(String, IrFn)>, i: &str| -> Result<usize> {
                let i = num(i)?;
                let fnr = &mut cur.as_mut().with_context(|| format!("line {}: record outside a function", lineno + 1))?.1;
                if fnr.sites.len() <= i {
                    fnr.sites.resize(i + 1, IrSite::default());
                }
                Ok(i)
            };
            match f[0] {
                "#kandelo-calltypes" => {
                    ensure!(lineno == 0, "line {}: second header inside a chunk", lineno + 1);
                    ensure!(f.get(1) == Some(&FORMAT_VERSION), "facts format {:?}, expected {FORMAT_VERSION}", f.get(1));
                    header = true;
                }
                "M" => {
                    need(2)?;
                    module = side.modules.id(f[1]);
                }
                "F" => {
                    need(3)?;
                    ensure!(cur.is_none(), "line {}: F inside a function", lineno + 1);
                    cur = Some((f[1].to_string(), IrFn { module, nparams: num(f[2])?, ..Default::default() }));
                }
                "Y" => {
                    need(4)?;
                    let i = site(&mut cur, f[2])?;
                    cur.as_mut().unwrap().1.sites[i].origin = Some((f[3].to_string(), f.get(4).unwrap_or(&"").to_string()));
                }
                "O" => {
                    need(2)?;
                    side.oldact_globals.insert(f[1].to_string());
                }
                "SE" => {
                    need(3)?;
                    side.slot_edges.push((f[1].to_string(), f[2].to_string()));
                }
                "AL" => relaxed = true,
                "SO" => {
                    need(3)?;
                    side.slot_reads_rec.push((f[1].to_string(), f[2].to_string(), relaxed));
                }
                "SF" => {
                    need(3)?;
                    side.slot_reads_fn.push((f[1].to_string(), f[2].to_string()));
                }
                "SD" => {
                    need(3)?;
                    side.slot_reads_mem.push((f[1].to_string(), f[2].to_string(), relaxed));
                }
                "SL" => {
                    need(4)?;
                    side.slot_links.push((f[1].to_string(), f[2].to_string(), f[3].to_string()));
                }
                "FT" => {
                    need(3)?;
                    side.rec_fn_types.entry(f[1].to_string()).or_default().insert(f[2].to_string());
                }
                "JS" | "JL" => side.jmp_facts.push(line.to_string()),
                "SC" => {
                    need(4)?;
                    side.call_sites.push((f[1].to_string(), f[2].to_string(), f[3].to_string()));
                }
                "SA" => {
                    need(4)?;
                    side.call_args.entry(f[1].to_string()).or_default().push((f[2].parse().unwrap_or(0), f[3].to_string()));
                }
                "NR" => {
                    need(3)?;
                    side.rec_nested.entry(f[1].to_string()).or_default().insert(f[2].to_string());
                }
                "Q" => {
                    need(3)?;
                    side.ast_qtype.entry(f[1].to_string()).or_default().insert(f[2].to_string());
                }
                "W" => {
                    need(3)?;
                    side.ast_w.entry(f[1].to_string()).or_default().insert(f[2].to_string());
                }
                "Z" => {
                    need(3)?;
                    side.ast_z.entry(f[1].to_string()).or_default().insert(f[2].to_string());
                }
                "G" => {
                    need(3)?;
                    side.ast_g.entry(f[2].to_string()).or_default().insert(f[1].to_string());
                }
                "H" => {
                    need(2)?;
                    side.ast_h.entry(f[1].to_string()).or_default().insert(f.get(2).unwrap_or(&"*").to_string());
                }
                "T" => {
                    need(3)?;
                    let id = side.ids.id(f[2]);
                    side.fn_types.entry(f[1].into()).or_default().insert(id);
                    if let Some((_, fnr)) = cur.as_mut() {
                        fnr.types.push(id);
                    }
                }
                "V" => {
                    need(4)?;
                    let id = side.ids.id(f[2]);
                    let off = f[3].parse::<i64>().with_context(|| format!("line {}: bad offset", lineno + 1))?;
                    side.vslots.entry(f[1].into()).or_default().insert((id, off));
                }
                "C" => {
                    need(4)?;
                    let i = site(&mut cur, f[2])?;
                    cur.as_mut().unwrap().1.sites[i].direct = Some(f[3].to_string());
                }
                "S" => {
                    need(5)?;
                    let i = site(&mut cur, f[2])?;
                    let sig = sigs.id(f[3]);
                    let k = match f[4] {
                        "icall" => {
                            need(6)?;
                            Some((0, side.ids.id(f[5]), 0))
                        }
                        "vcall" => {
                            need(7)?;
                            let off = f[6].parse::<i64>().with_context(|| format!("line {}: bad offset", lineno + 1))?;
                            Some((1, side.ids.id(f[5]), off))
                        }
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
                "D" => {
                    need(4)?;
                    let (name, mut fnr) = cur.take().with_context(|| format!("line {}: D outside a function", lineno + 1))?;
                    ensure!(name == f[1], "line {}: D for `{}` closes `{name}`", lineno + 1, f[1]);
                    let n = num(f[3])?;
                    if fnr.sites.len() < n {
                        fnr.sites.resize(n, IrSite::default());
                    }
                    defs.push((name, fnr));
                }
                "R" => {
                    need(3)?;
                    match f[2] {
                        "*" => side.reg_unknown.entry(f[1].into()).or_default().push("non-constant callback".into()),
                        "?" => side.reg_unknown.entry(f[1].into()).or_default().push("registration API address escapes".into()),
                        s if s.starts_with('%') => {
                            // A forwarder: ignorable only when the enclosing
                            // function is itself a registration API of this
                            // registry at that argument.
                            need(4)?;
                            let n: u32 = s[1..].parse().with_context(|| format!("line {}: bad forwarder", lineno + 1))?;
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
                    }
                }
                // Facts production does not use: constant arguments (A, K),
                // address flow (X, P), the opaque pool (J, U), counts (D is
                // above), and anything a later plugin adds.
                _ => {}
            }
        }
        if !header {
            bail!("facts chunk without a header");
        }
        ensure!(cur.is_none(), "facts chunk ends inside a function definition");
        side.chunks.push(defs);
        Ok(())
    }
}
