//! fsa: fork-sink analysis research tool.
//!
//! Question: under a fork mechanism whose unwind stops at the deepest frame
//! that never returns in the child (a "sink"), which functions still need
//! fork instrumentation?
//!
//! The analysis works on one Wasm module (the instrumenter's input) and is
//! sound under the same assumptions as `fork_instrument::call_graph` plus the
//! ones listed in `ASSUMPTIONS` below; every refinement that adds an
//! assumption is a command-line switch and is printed in the report.
//!
//! 1. Whole-program summaries: for every function, may it return, and which
//!    exception tags may escape it. Least fixpoint over the call graph;
//!    `call_indirect` targets are every table function of the same
//!    structural signature unless a refinement below proves fewer.
//! 2. Child continuation: for every function on the fork path, run an
//!    abstract interpreter (constants, unmodified parameters, exnref tag
//!    sets) starting *after* each fork-reaching call with the callee's
//!    child-side result (kernel_fork returns 0 in the child). The function
//!    is OPEN if a `return` or an escaping exception is reachable, otherwise
//!    CLOSED (a sink for every one of its fork-reaching calls).
//! 3. The instrumented set under sinks: every function with a fork-reaching
//!    call whose callee is OPEN (or is kernel_fork). Closed functions stop
//!    the upward walk; open ones propagate to their callers.
//!
//! Refinements of indirect targets (all sound, each states its assumption):
//!   const-slot  an index that is a known constant names one table slot
//!               (needs: active segments with constant offsets, no
//!               table.set/fill/grow/copy/init in the module)
//!   param       an index that is an unmodified parameter of a function
//!               that is only ever called directly resolves to the union of
//!               the constant arguments at its call sites
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::Write as _;
use walrus::ir::*;
use walrus::*;

type Tags = u64;
const TAGS_ALL: Tags = u64::MAX;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum V {
    Top,
    C(i64),
    /// The function's own parameter, unmodified.
    P(u32),
    /// An exnref carrying one of these tags.
    Exn(Tags),
    /// Address `entry __stack_pointer + k` (frame-slot base).
    Sp(i64),
}

fn joinv(a: V, b: V) -> V {
    match (a, b) {
        _ if a == b => a,
        (V::Exn(x), V::Exn(y)) => V::Exn(x | y),
        _ => V::Top,
    }
}

#[derive(Clone, PartialEq, Debug)]
struct St {
    live: bool,
    loc: Vec<V>,
    stk: Vec<V>,
    /// Frame slots: (Sp offset, width, value), sorted; absent = unknown.
    mem: Vec<(i64, u32, V)>,
    /// Current __stack_pointer as an Sp offset (None: unknown).
    sp: Option<i64>,
}

impl St {
    fn dead(h: usize) -> St {
        St { live: false, loc: vec![], stk: vec![V::Top; h], mem: vec![], sp: None }
    }
}

/// Join `b` into `a`; both describe the same program point (equal heights).
fn join_into(a: &mut Option<St>, b: &St) -> bool {
    if !b.live {
        if a.is_none() {
            *a = Some(b.clone());
            return true;
        }
        return false;
    }
    match a {
        None => {
            *a = Some(b.clone());
            true
        }
        Some(x) if !x.live => {
            *x = b.clone();
            true
        }
        Some(x) => {
            let mut ch = false;
            let before = x.mem.len();
            x.mem.retain_mut(|e| match b.mem.iter().find(|f| f.0 == e.0 && f.1 == e.1) {
                Some(f) => {
                    let j = joinv(e.2, f.2);
                    if j != e.2 {
                        e.2 = j;
                        ch = true;
                    }
                    true
                }
                None => false,
            });
            ch |= x.mem.len() != before;
            if x.sp != b.sp && x.sp.is_some() {
                x.sp = None;
                ch = true;
            }
            for (p, q) in x.loc.iter_mut().zip(&b.loc) {
                let j = joinv(*p, *q);
                if j != *p {
                    *p = j;
                    ch = true;
                }
            }
            let n = x.stk.len().min(b.stk.len());
            let (xo, bo) = (x.stk.len() - n, b.stk.len() - n);
            for i in 0..n {
                let j = joinv(x.stk[xo + i], b.stk[bo + i]);
                if j != x.stk[xo + i] {
                    x.stk[xo + i] = j;
                    ch = true;
                }
            }
            ch
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
struct Summ {
    ret: bool,
    thr: Tags,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Policy {
    /// Signal dispatch targets resolved like any call_indirect (sound).
    Sig,
    /// Signal handlers are assumed not to throw or longjmp past the sink
    /// frame (to be enforced by a loud run-time check).
    NoThrow,
    /// Only the listed functions are handlers.
    List,
}

struct Prog {
    m: Module,
    n: usize,
    names: Vec<String>,
    import: Vec<bool>,
    fty: Vec<TypeId>,
    skey: Vec<u32>,
    tkey: HashMap<TypeId, u32>,
    /// Table members by (table index, signature key).
    members: HashMap<(usize, u32), Vec<u32>>,
    /// Functions that can be called other than by a direct call.
    escapes: Vec<bool>,
    /// Constant slot -> function for table 0 when the table is immutable.
    slots: Option<HashMap<i64, u32>>,
    dyn_link: bool,
    callers: Vec<Vec<u32>>,
    /// Functions containing call_indirect of a given signature key.
    icallers: HashMap<u32, Vec<u32>>,
    tag_bit: HashMap<TagId, u32>,
    signal_fns: HashSet<u32>,
    sig_policy: Policy,
    sig_list: HashSet<u32>,
    use_param: bool,
    sig_handler_keys: HashSet<u32>,
    fids: Vec<FunctionId>,
    /// Calls that cannot execute under a mechanically checked rule.
    cut: HashSet<(u32, u32)>,
    /// fpa-exported indirect targets: (function, signature key) -> targets.
    itargets: HashMap<(u32, u32), Vec<u32>>,
    /// Globals that always hold their constant initializer (never written,
    /// not imported, not exported mutable): GOT.func / __table_base etc.
    gconst: HashMap<GlobalId, i64>,
    /// The module's shadow-stack pointer global, when named.
    sp_global: Option<GlobalId>,
    /// Bodies small enough for call specialisation.
    small: Vec<bool>,
    /// C/C++ _Noreturn by specification (abort, exit, std::terminate, ...):
    /// never return normally, whatever their conflated callees suggest.
    noreturn: Vec<bool>,
    /// Let no exception or longjmp escape by specification.
    nothrow: Vec<bool>,
    /// What-if: the crt calls main directly, so main is no indirect target
    /// except from the start routine's own call (a libc/crt change).
    main_fns: HashSet<u32>,
    /// --cleanup-map: caller -> the cleanup handlers it installs.
    cleanup_map: HashMap<u32, Vec<u32>>,
    cleanup_pop: HashSet<u32>,
    start_fns: HashSet<u32>,
}

/// Every instruction sequence of a body, in a deterministic pre-order.
fn all_seqs(lf: &LocalFunction) -> Vec<(InstrSeqId, &InstrSeq)> {
    let mut out = vec![];
    let mut stack = vec![lf.entry_block()];
    while let Some(id) = stack.pop() {
        let seq = lf.block(id);
        out.push((id, seq));
        for (ins, _) in seq.instrs.iter().rev() {
            match ins {
                Instr::Block(b) => stack.push(b.seq),
                Instr::Loop(b) => stack.push(b.seq),
                Instr::TryTable(t) => stack.push(t.seq),
                Instr::IfElse(ie) => {
                    stack.push(ie.alternative);
                    stack.push(ie.consequent);
                }
                Instr::Try(t) => {
                    for c in &t.catches {
                        match c {
                            LegacyCatch::Catch { handler, .. } | LegacyCatch::CatchAll { handler } => stack.push(*handler),
                            LegacyCatch::Delegate { .. } => {}
                        }
                    }
                    stack.push(t.seq);
                }
                _ => {}
            }
        }
    }
    out
}

fn table_ix(m: &Module, t: TableId) -> usize {
    m.tables.iter().position(|x| x.id() == t).unwrap()
}

impl Prog {
    fn load(path: &str) -> Prog {
        let m = Module::from_file(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let n = m.funcs.iter().map(|f| f.id().index() + 1).max().unwrap_or(0);
        let mut keys: HashMap<String, u32> = HashMap::new();
        let mut key = |m: &Module, t: TypeId| -> u32 {
            let ty = m.types.get(t);
            let s = format!("{:?}->{:?}", ty.params(), ty.results());
            let k = keys.len() as u32;
            *keys.entry(s).or_insert(k)
        };
        let ty0 = m.types.iter().next().map(|t| t.id()).unwrap();
        let mut tkey = HashMap::new();
        for t in m.types.iter() {
            // GC struct/array types have no signature; they never key calls.
            if t.is_function() {
                tkey.insert(t.id(), key(&m, t.id()));
            }
        }
        let mut p = Prog {
            n,
            names: vec![String::new(); n],
            import: vec![false; n],
            fty: vec![ty0; n],
            skey: vec![0; n],
            tkey,
            members: HashMap::new(),
            escapes: vec![false; n],
            slots: None,
            dyn_link: fork_instrument::call_graph::has_dynamic_linker_imports(&m),
            callers: vec![vec![]; n],
            icallers: HashMap::new(),
            tag_bit: HashMap::new(),
            signal_fns: HashSet::new(),
            sig_policy: Policy::Sig,
            sig_list: HashSet::new(),
            use_param: false,
            sig_handler_keys: HashSet::new(),
            fids: vec![],
            cut: HashSet::new(),
            itargets: HashMap::new(),
            gconst: HashMap::new(),
            sp_global: None,
            small: vec![],
            noreturn: vec![],
            nothrow: vec![],
            main_fns: HashSet::new(),
            cleanup_map: HashMap::new(),
            cleanup_pop: HashSet::new(),
            start_fns: HashSet::new(),
            m,
        };
        p.fids = vec![p.m.funcs.iter().next().unwrap().id(); n];
        for f in p.m.funcs.iter() {
            let i = f.id().index();
            p.fids[i] = f.id();
            p.names[i] = f.name.clone().unwrap_or_else(|| format!("#{i}"));
            p.import[i] = matches!(f.kind, FunctionKind::Import(_));
            p.fty[i] = f.ty();
            p.skey[i] = p.tkey[&f.ty()];
        }
        for (i, t) in p.m.tags.iter().enumerate() {
            p.tag_bit.insert(t.id, (i as u32).min(63));
        }
        // Table membership.
        let mut mutated = false;
        let mut ref_funcs: HashSet<u32> = HashSet::new();
        let mut table_init: HashSet<usize> = HashSet::new();
        for f in p.m.funcs.iter() {
            let FunctionKind::Local(lf) = &f.kind else { continue };
            for (_, seq) in all_seqs(lf) {
                for (ins, _) in &seq.instrs {
                    match ins {
                        Instr::TableSet(_) | Instr::TableFill(_) | Instr::TableGrow(_) | Instr::TableCopy(_) => mutated = true,
                        Instr::TableInit(t) => {
                            mutated = true;
                            table_init.insert(table_ix(&p.m, t.table));
                        }
                        Instr::RefFunc(r) => {
                            ref_funcs.insert(r.func.index() as u32);
                        }
                        Instr::Call(c) => p.callers[c.func.index()].push(f.id().index() as u32),
                        Instr::ReturnCall(c) => p.callers[c.func.index()].push(f.id().index() as u32),
                        Instr::CallIndirect(c) => p.icallers.entry(p.tkey[&c.ty]).or_default().push(f.id().index() as u32),
                        Instr::ReturnCallIndirect(c) => p.icallers.entry(p.tkey[&c.ty]).or_default().push(f.id().index() as u32),
                        _ => {}
                    }
                }
            }
        }
        for v in p.icallers.values_mut() {
            v.sort();
            v.dedup();
        }
        for v in p.callers.iter_mut() {
            v.sort();
            v.dedup();
        }
        let ntab = p.m.tables.iter().count();
        let mut slots: HashMap<i64, u32> = HashMap::new();
        let mut slots_ok = true;
        let mut add = |p: &mut Prog, t: usize, f: u32| {
            p.members.entry((t, p.skey[f as usize])).or_default().push(f);
            p.escapes[f as usize] = true;
        };
        let elems: Vec<_> = p.m.elements.iter().map(|e| (e.kind.clone(), e.items.clone())).collect();
        for (kind, items) in elems {
            let funcs: Vec<u32> = match &items {
                ElementItems::Functions(v) => v.iter().map(|x| x.index() as u32).collect(),
                ElementItems::Expressions(_, v) => v
                    .iter()
                    .filter_map(|e| if let ConstExpr::RefFunc(f) = e { Some(f.index() as u32) } else { None })
                    .collect(),
            };
            match kind {
                ElementKind::Active { table, offset } => {
                    let t = table_ix(&p.m, table);
                    let base = match offset {
                        ConstExpr::Value(Value::I32(v)) => Some(v as i64),
                        ConstExpr::Value(Value::I64(v)) => Some(v),
                        _ => None,
                    };
                    if t != 0 || base.is_none() {
                        slots_ok = false;
                    }
                    for (k, &f) in funcs.iter().enumerate() {
                        add(&mut p, t, f);
                        if let (0, Some(b)) = (t, base) {
                            slots.insert(b + k as i64, f);
                        }
                    }
                }
                ElementKind::Passive => {
                    for t in 0..ntab {
                        if table_init.contains(&t) {
                            for &f in &funcs {
                                add(&mut p, t, f);
                            }
                        }
                    }
                    for &f in &funcs {
                        p.escapes[f as usize] = true;
                    }
                }
                ElementKind::Declared => {
                    for &f in &funcs {
                        p.escapes[f as usize] = true;
                    }
                }
            }
        }
        if mutated {
            slots_ok = false;
            for &f in &ref_funcs {
                for t in 0..ntab {
                    add(&mut p, t, f);
                }
            }
        }
        for &f in &ref_funcs {
            p.escapes[f as usize] = true;
        }
        for e in p.m.exports.iter() {
            if let ExportItem::Function(f) = e.item {
                p.escapes[f.index()] = true;
            }
        }
        if let Some(s) = p.m.start {
            p.escapes[s.index()] = true;
        }
        for v in p.members.values_mut() {
            v.sort();
            v.dedup();
        }
        if slots_ok {
            p.slots = Some(slots);
        }
        p.small = (0..n)
            .map(|i| match &p.m.funcs.get(p.fids[i]).kind {
                FunctionKind::Local(lf) => all_seqs(lf).iter().map(|(_, s)| s.instrs.len()).sum::<usize>() <= 600,
                _ => false,
            })
            .collect();
        const NORETURN: &[&str] = &[
            "abort", "exit", "_Exit", "_exit", "quick_exit", "pthread_exit", "__pthread_exit",
            "longjmp", "siglongjmp", "_longjmp", "__wasm_longjmp", "std::terminate()",
            "__clang_call_terminate", "__cxa_throw", "__cxa_rethrow", "__assert_fail",
        ];
        p.noreturn = (0..n)
            .map(|i| {
                let nm = p.names[i].as_str();
                !p.import[i] && NORETURN.iter().any(|x| nm == *x || (nm.starts_with(x) && nm[x.len()..].starts_with('(')))
            })
            .collect();
        const NOTHROW: &[&str] = &[
            "exit", "_Exit", "_exit", "quick_exit", "pthread_exit", "__pthread_exit",
            "std::terminate()", "__clang_call_terminate",
        ];
        p.nothrow = (0..n)
            .map(|i| {
                let nm = p.names[i].as_str();
                !p.import[i] && NOTHROW.iter().any(|x| nm == *x || (nm.starts_with(x) && nm[x.len()..].starts_with('(')))
            })
            .collect();
        p.sp_global = p.m.globals.iter().find(|g| g.name.as_deref() == Some("__stack_pointer")).map(|g| g.id());
        let mut gwritten: HashSet<GlobalId> = HashSet::new();
        for f in p.m.funcs.iter() {
            let FunctionKind::Local(lf) = &f.kind else { continue };
            for (_, seq) in all_seqs(lf) {
                for (ins, _) in &seq.instrs {
                    if let Instr::GlobalSet(g) = ins {
                        gwritten.insert(g.global);
                    }
                }
            }
        }
        for e in p.m.exports.iter() {
            if let ExportItem::Global(g) = e.item {
                if p.m.globals.get(g).mutable {
                    gwritten.insert(g);
                }
            }
        }
        for g in p.m.globals.iter() {
            if gwritten.contains(&g.id()) {
                continue;
            }
            if let GlobalKind::Local(ConstExpr::Value(v)) = &g.kind {
                match v {
                    Value::I32(x) => {
                        p.gconst.insert(g.id(), *x as i64);
                    }
                    Value::I64(x) => {
                        p.gconst.insert(g.id(), *x);
                    }
                    _ => {}
                }
            }
        }
        for s in ["[I32]->[]", "[I32, I32, I32]->[]"] {
            if let Some(k) = keys_lookup(&p.m, &p.tkey, s) {
                p.sig_handler_keys.insert(k);
            }
        }
        p
    }

    fn fid(&self, i: u32) -> FunctionId {
        self.fids[i as usize]
    }

    fn by_name(&self, n: &str) -> Vec<u32> {
        (0..self.n as u32).filter(|&i| self.names[i as usize] == n).collect()
    }
}

fn keys_lookup(m: &Module, tkey: &HashMap<TypeId, u32>, s: &str) -> Option<u32> {
    for t in m.types.iter().filter(|t| t.is_function()) {
        if format!("{:?}->{:?}", t.params(), t.results()) == s {
            return Some(tkey[&t.id()]);
        }
    }
    None
}

// ------------------------------------------------------------- interpreter

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Normal,
    Child,
}

struct FnInfo {
    params: usize,
    lidx: HashMap<LocalId, usize>,
    written: Vec<bool>,
    /// Local holds an exnref (null-initialised).
    exn: Vec<bool>,
}

fn fninfo(m: &Module, lf: &LocalFunction) -> FnInfo {
    let mut lidx = HashMap::new();
    for (i, a) in lf.args.iter().enumerate() {
        lidx.insert(*a, i);
    }
    let mut written = vec![false; lf.args.len()];
    for (_, seq) in all_seqs(lf) {
        for (ins, _) in &seq.instrs {
            let (l, w) = match ins {
                Instr::LocalGet(x) => (x.local, false),
                Instr::LocalSet(x) => (x.local, true),
                Instr::LocalTee(x) => (x.local, true),
                _ => continue,
            };
            let k = lidx.len();
            let i = *lidx.entry(l).or_insert(k);
            if written.len() <= i {
                written.resize(i + 1, false);
            }
            written[i] |= w;
        }
    }
    let mut exn = vec![false; lidx.len()];
    for (l, &i) in &lidx {
        if let ValType::Ref(r) = m.locals.get(*l).ty() {
            if r.heap_type == HeapType::Abstract(AbstractHeapType::Exn) {
                exn[i] = true;
            }
        }
    }
    FnInfo { params: lf.args.len(), lidx, written, exn }
}

/// Where to inject child-side control into a body: a call instruction
/// (seq, index) and what that call yields in the child.
#[derive(Clone, Copy)]
struct Inject {
    ret: Option<V>,
    thr: Tags,
    /// Catch-landing probe: replace the top `n` stack values with these
    /// (the clause payload) instead of modelling a call result.
    top: Option<(u8, [V; 4])>,
}

struct Ctx<'a> {
    p: &'a Prog,
    summ: &'a [Summ],
    /// Param refinement cache (shared).
    ptarg: &'a mut HashMap<(u32, u32), Option<Vec<u32>>>,
    /// Tags of every exnref a function stores in a local (normal mode).
    exn_seen: &'a mut HashMap<u32, Tags>,
    /// Functions whose frame address escapes (no slot tracking).
    frame_esc: &'a mut HashSet<u32>,
    /// Call specialisation (only once summaries are final).
    allow_spec: bool,
    spec: &'a mut HashMap<(u32, Vec<V>), (Option<V>, Tags)>,
    depth: u32,
}

struct Walk<'a, 'b> {
    cx: &'b mut Ctx<'a>,
    f: u32,
    lf: &'a LocalFunction,
    info: &'b FnInfo,
    mode: Mode,
    inject: &'b HashMap<(InstrSeqId, usize), Inject>,
    labels: HashMap<InstrSeqId, Option<St>>,
    arity: HashMap<InstrSeqId, usize>,
    handlers: Vec<&'a [TryTableCatch]>,
    legacy: Vec<(InstrSeqId, Vec<(Option<TagId>, InstrSeqId)>)>,
    legacy_entry: HashMap<InstrSeqId, Option<St>>,
    ret: Option<V>,
    returned: bool,
    thr: Tags,
    /// First callee (and tags) seen making the continuation escape/return.
    why: Vec<String>,
    /// Record args passed to `rec_callee` at param `rec_param`.
    rec_callee: Option<u32>,
    rec_param: u32,
    rec_vals: Vec<V>,
    unsupported: bool,
    nres: usize,
    cur: (InstrSeqId, usize),
    rec_sites: Option<HashMap<(InstrSeqId, usize), HashSet<u32>>>,
    /// Normal mode: post-call states to record at these sites.
    rec_states: Option<HashMap<(InstrSeqId, usize), Option<St>>>,
    /// Child mode: recorded normal-mode post-call states.
    inj_states: HashMap<(InstrSeqId, usize), Option<St>>,
    /// Frame-slot tracking enabled for this body (no frame address escapes).
    frame_ok: bool,
    frame_escaped: bool,
}

fn seq_arity(m: &Module, ty: InstrSeqType) -> (usize, usize) {
    match ty {
        InstrSeqType::Simple(None) => (0, 0),
        InstrSeqType::Simple(Some(_)) => (0, 1),
        InstrSeqType::MultiValue(t) => {
            let (a, b) = m.types.params_results(t);
            (a.len(), b.len())
        }
    }
}

impl<'a, 'b> Walk<'a, 'b> {
    fn pop(&mut self, st: &mut St, k: usize) -> Vec<V> {
        let n = st.stk.len();
        if k > n {
            // Malformed relative to our model; treat as unsupported.
            self.unsupported = true;
            st.stk.clear();
            return vec![V::Top; k];
        }
        st.stk.split_off(n - k)
    }

    fn deliver(&mut self, label: InstrSeqId, st: &St, vals: Vec<V>) {
        if !st.live {
            return;
        }
        let s = St { live: true, loc: st.loc.clone(), stk: vals, mem: st.mem.clone(), sp: st.sp };
        let e = self.labels.entry(label).or_insert(None);
        join_into(e, &s);
    }

    fn branch(&mut self, label: InstrSeqId, st: &St) {
        if !st.live {
            return;
        }
        let a = *self.arity.get(&label).unwrap_or(&0);
        let n = st.stk.len();
        let vals = st.stk[n.saturating_sub(a)..].to_vec();
        self.deliver(label, st, vals);
    }

    fn throw(&mut self, st: &St, mut tags: Tags, why: &str) {
        if !st.live || tags == 0 {
            return;
        }
        for h in (0..self.handlers.len()).rev() {
            let cs = self.handlers[h];
            for c in cs {
                match c {
                    TryTableCatch::Catch { tag, label } | TryTableCatch::CatchRef { tag, label } => {
                        let bit = 1u64 << self.cx.p.tag_bit[tag];
                        if tags & bit != 0 {
                            let a = *self.arity.get(label).unwrap_or(&0);
                            let mut v = vec![V::Top; a];
                            if matches!(c, TryTableCatch::CatchRef { .. }) && a > 0 {
                                v[a - 1] = V::Exn(bit);
                            }
                            self.deliver(*label, st, v);
                            if bit != 1 << 63 {
                                tags &= !bit;
                            }
                        }
                    }
                    TryTableCatch::CatchAll { label } | TryTableCatch::CatchAllRef { label } => {
                        let a = *self.arity.get(label).unwrap_or(&0);
                        let mut v = vec![V::Top; a];
                        if matches!(c, TryTableCatch::CatchAllRef { .. }) && a > 0 {
                            v[a - 1] = V::Exn(tags);
                        }
                        self.deliver(*label, st, v);
                        tags = 0;
                    }
                }
                if tags == 0 {
                    return;
                }
            }
        }
        // Legacy try handlers (innermost last). Approximate: any matching
        // handler receives control; catch_all stops propagation.
        for i in (0..self.legacy.len()).rev() {
            let entries = self.legacy[i].1.clone();
            for (tag, h) in entries {
                let hit = match tag {
                    Some(t) => tags & (1u64 << self.cx.p.tag_bit[&t]) != 0,
                    None => true,
                };
                if hit {
                    let (pa, _) = seq_arity(&self.cx.p.m, self.lf.block(h).ty);
                    let s = St { live: true, loc: st.loc.clone(), stk: vec![V::Top; pa], mem: st.mem.clone(), sp: st.sp };
                    let e = self.legacy_entry.entry(h).or_insert(None);
                    join_into(e, &s);
                    if tag.is_none() {
                        tags = 0;
                    }
                }
            }
            if tags == 0 {
                return;
            }
        }
        let w = format!("throws {tags:#x} via {why}");
        if self.why.len() < 24 && !self.why.contains(&w) {
            self.why.push(w);
        }
        self.thr |= tags;
    }

    fn effect(&mut self, targets: &[u32], external: bool) -> Summ {
        let mut s = Summ::default();
        if external {
            return Summ { ret: true, thr: TAGS_ALL };
        }
        for &t in targets {
            if t == u32::MAX {
                // Gated signal handler: returns, and any escape past the
                // sink frame is a loud run-time failure, not a modelled path.
                s.ret = true;
                continue;
            }
            if self.cx.p.import[t as usize] {
                s.ret = true;
            } else {
                let x = self.cx.summ[t as usize];
                s.ret |= x.ret;
                s.thr |= x.thr;
            }
        }
        s
    }

    fn icall_targets(&mut self, key: u32, table: usize, idx: V, signal: bool) -> (Vec<u32>, bool) {
        let p = self.cx.p;
        if signal && p.sig_handler_keys.contains(&key) {
            match p.sig_policy {
                Policy::Sig => {}
                Policy::NoThrow => return (vec![u32::MAX], false),
                Policy::List => {
                    let v: Vec<u32> = p
                        .members
                        .get(&(table, key))
                        .map(|m| m.iter().copied().filter(|f| p.sig_list.contains(f)).collect())
                        .unwrap_or_default();
                    return (v, false);
                }
            }
        }
        if let (V::C(k), Some(slots)) = (idx, &p.slots) {
            if table == 0 {
                return match slots.get(&k) {
                    Some(&f) if p.skey[f as usize] == key => (vec![f], false),
                    _ => (vec![], false),
                };
            }
        }
        if let (V::P(q), true) = (idx, p.use_param) {
            if let Some(v) = param_targets(self.cx, self.f, q, 0) {
                let v: Vec<u32> = v.into_iter().filter(|&f| p.skey[f as usize] == key).collect();
                return (v, false);
            }
        }
        if let Some(v) = p.itargets.get(&(self.f, key)) {
            return (v.clone(), p.dyn_link);
        }
        let v = p.members.get(&(table, key)).cloned().unwrap_or_default();
        (v, p.dyn_link)
    }

    fn call(&mut self, st: &mut St, mut targets: Vec<u32>, external: bool, nparams: usize, nres: usize, tail: bool, why: String) {
        // pthread_cleanup_pop runs the handler of the caller's own lexical
        // pthread_cleanup_push (POSIX pairs them in one scope).
        if targets.len() == 1 && self.cx.p.cleanup_pop.contains(&targets[0]) {
            if let Some(hs) = self.cx.p.cleanup_map.get(&self.f) {
                // u32::MAX: the pop itself returns (run == 0 calls nothing).
                targets = hs.clone();
                targets.push(u32::MAX);
            }
        }
        if !self.cx.p.main_fns.is_empty() && targets.len() > 1 && !self.cx.p.start_fns.contains(&self.f) {
            targets.retain(|t| !self.cx.p.main_fns.contains(t));
        }
        let args = self.pop(st, nparams);
        if st.live {
            if let Some(r) = self.rec_sites.as_mut() {
                let e = r.entry(self.cur).or_default();
                if !(targets.len() == 1 && self.cx.p.cut.contains(&(self.f, targets[0]))) {
                    e.extend(targets.iter().copied().filter(|&t| t != u32::MAX));
                    if external {
                        e.insert(u32::MAX - 1);
                    }
                }
            }
        }
        self.esc(&args);
        if targets.len() == 1 && self.cx.p.cut.contains(&(self.f, targets[0])) {
            st.live = false;
            for _ in 0..nres {
                st.stk.push(V::Top);
            }
            return;
        }
        // Constant arguments to one small local callee: evaluate it for
        // exactly these arguments (memoized, depth-limited).
        if st.live && !tail && self.cx.allow_spec && self.cx.depth < 3 && targets.len() == 1 && targets[0] != u32::MAX {
            let t = targets[0];
            if !self.cx.p.import[t as usize] && args.iter().any(|a| matches!(a, V::C(_))) && self.cx.p.small[t as usize] {
                let key: Vec<V> = args.iter().map(|a| if matches!(a, V::C(_)) { *a } else { V::Top }).collect();
                let r = match self.cx.spec.get(&(t, key.clone())) {
                    Some(r) => *r,
                    None => {
                        let FunctionKind::Local(lf) = &self.cx.p.m.funcs.get(self.cx.p.fid(t)).kind else { unreachable!() };
                        let info = fninfo(&self.cx.p.m, lf);
                        let entry: Vec<V> = key.iter().enumerate().map(|(i, a)| if *a == V::Top { V::P(i as u32) } else { *a }).collect();
                        self.cx.depth += 1;
                        let r = interpret3(self.cx, t, &info, Mode::Normal, &HashMap::new(), None, false, Some(&entry));
                        self.cx.depth -= 1;
                        let x = if r.unsupported { (Some(V::Top), TAGS_ALL) } else { (r.ret.map(|v| if matches!(v, V::P(_) | V::Sp(_)) { V::Top } else { v }), r.thr) };
                        self.cx.spec.insert((t, key), x);
                        x
                    }
                };
                if r.1 != 0 {
                    let snap = st.clone();
                    self.throw(&snap, r.1, &why);
                }
                if r.0.is_none() {
                    st.live = false;
                }
                for k in 0..nres {
                    st.stk.push(if k + 1 == nres { r.0.unwrap_or(V::Top) } else { V::Top });
                }
                return;
            }
        }
        if let Some(rc) = self.rec_callee {
            if st.live && targets.len() == 1 && targets[0] == rc && rc != u32::MAX {
                self.rec_vals.push(args.get(self.rec_param as usize).copied().unwrap_or(V::Top));
            }
        }
        let s = if self.mode == Mode::Normal && self.cx.summ.is_empty() {
            // Value-only pass (param refinement): every call returns.
            Summ { ret: true, thr: 0 }
        } else {
            self.effect(&targets, external)
        };
        if s.thr != 0 {
            let snap = st.clone();
            let why2 = if targets.len() > 1 {
                let th: Vec<&str> = targets
                    .iter()
                    .filter(|&&t| t != u32::MAX && !self.cx.p.import[t as usize] && self.cx.summ.get(t as usize).map_or(false, |x| x.thr != 0))
                    .take(4)
                    .map(|&t| self.cx.p.names[t as usize].as_str())
                    .collect();
                format!("{why} throwing:{th:?}")
            } else {
                why.clone()
            };
            self.throw(&snap, s.thr, &why2);
        }
        if tail {
            if st.live && s.ret {
                if !self.returned && self.why.len() < 6 {
                    self.why.push(format!("returns via tail call {why}"));
                }
                self.returned = true;
                self.ret = Some(self.ret.map_or(V::Top, |_| V::Top));
            }
            st.live = false;
        } else if !s.ret {
            st.live = false;
        }
        for _ in 0..nres {
            st.stk.push(V::Top);
        }
    }

    fn run(&mut self, seq: InstrSeqId, mut st: St) -> St {
        let instrs = &self.lf.block(seq).instrs;
        for (ix, (ins, _)) in instrs.iter().enumerate() {
            self.cur = (seq, ix);
            st = self.step(seq, ix, ins, st);
            if self.mode == Mode::Normal {
                if let Some(r) = self.rec_states.as_mut() {
                    if r.contains_key(&(seq, ix)) && st.live {
                        let e = r.get_mut(&(seq, ix)).unwrap();
                        join_into(e, &st);
                    }
                }
            }
            if let Some(inj) = self.inject.get(&(seq, ix)).copied() {
                if matches!(ins, Instr::ReturnCall(_) | Instr::ReturnCallIndirect(_) | Instr::ReturnCallRef(_)) {
                    // A tail call leaves no caller state: the callee's
                    // child-side result is this function's own result, and its
                    // exceptions leave this function directly (a tail call is
                    // outside every enclosing handler).
                    if self.mode == Mode::Child {
                        if let Some(v) = inj.ret {
                            self.ret = Some(self.ret.map_or(v, |r| joinv(r, v)));
                            self.returned = true;
                        }
                        self.thr |= inj.thr;
                    }
                    continue;
                }
                // The call at (seq, ix) has just been modelled with its normal
                // effect; add the child-side resumption. The child's frame
                // holds exactly the parent's locals at this call, which the
                // normal-mode state here over-approximates.
                let base = self.inj_states.get(&(seq, ix)).and_then(|x| x.clone()).filter(|x| x.live);
                if let Some(base) = base {
                    if inj.thr != 0 {
                        self.throw(&base, inj.thr, "fork-path callee in the child");
                    }
                    if let Some((k, vals)) = inj.top {
                        let mut s = base.clone();
                        let k = k as usize;
                        let n = s.stk.len();
                        if n >= k {
                            s.stk[n - k..].copy_from_slice(&vals[..k]);
                            let mut o = Some(st.clone());
                            join_into(&mut o, &s);
                            st = o.unwrap();
                        } else {
                            self.unsupported = true;
                        }
                    }
                    if let Some(v) = inj.ret {
                        let mut s = base.clone();
                        if let Some(top) = s.stk.last_mut() {
                            *top = v;
                        }
                        let mut o = Some(st.clone());
                        join_into(&mut o, &s);
                        st = o.unwrap();
                    }
                }
            }
        }
        st
    }

    /// A frame address used other than as a load/store base or SP update:
    /// the frame escapes and slot tracking is unsound for this body.
    fn esc(&mut self, vals: &[V]) {
        if self.frame_ok && vals.iter().any(|v| matches!(v, V::Sp(_))) {
            self.frame_escaped = true;
        }
    }

    fn note_exn(&mut self, i: usize, v: V) {
        if self.mode == Mode::Normal && self.info.exn[i] {
            let t = match v {
                V::Exn(t) => t,
                _ => TAGS_ALL,
            };
            *self.cx.exn_seen.entry(self.f).or_insert(0) |= t;
        }
    }

    fn child_locals(&self) -> Vec<V> {
        let n = self.info.lidx.len();
        let seen = self.cx.exn_seen.get(&self.f).copied().unwrap_or(TAGS_ALL);
        (0..n)
            .map(|i| {
                if self.info.written.get(i).copied().unwrap_or(false) {
                    if self.info.exn[i] { V::Exn(seen) } else { V::Top }
                } else if self.info.exn[i] && i >= self.info.params {
                    V::Exn(0)
                } else if i < self.info.params {
                    V::P(i as u32)
                } else {
                    V::C(0)
                }
            })
            .collect()
    }

    fn entry_locals(&self) -> Vec<V> {
        let n = self.info.lidx.len();
        (0..n)
            .map(|i| if i < self.info.params { V::P(i as u32) } else if self.info.exn[i] { V::Exn(0) } else { V::C(0) })
            .collect()
    }

    /// Run a structured sub-sequence; returns the state after the construct
    /// (fallthrough joined with branches to its label).
    fn region(&mut self, seq: InstrSeqId, entry: St, is_loop: bool) -> St {
        let (pa, ra) = seq_arity(&self.cx.p.m, self.lf.block(seq).ty);
        self.arity.insert(seq, if is_loop { pa } else { ra });
        if !is_loop {
            self.labels.insert(seq, None);
            let out = self.run(seq, entry);
            let acc = self.labels.remove(&seq).unwrap();
            let mut o = Some(out);
            if let Some(a) = acc {
                join_into(&mut o, &a);
            }
            let mut o = o.unwrap();
            let n = o.stk.len();
            if n > ra {
                o.stk.drain(0..n - ra);
            }
            while o.stk.len() < ra {
                o.stk.insert(0, V::Top);
            }
            return o;
        }
        let mut ent = Some(entry);
        let mut out;
        let mut iter = 0;
        loop {
            self.labels.insert(seq, None);
            out = self.run(seq, ent.clone().unwrap());
            let back = self.labels.remove(&seq).unwrap();
            let mut nent = ent.clone();
            let ch = match &back {
                Some(b) => join_into(&mut nent, b),
                None => false,
            };
            if !ch {
                break;
            }
            iter += 1;
            if iter > 6 {
                // Widen: every local that is still changing goes to Top.
                if let (Some(a), Some(b)) = (&ent, &mut nent) {
                    if a.live && b.live {
                        for (x, y) in a.loc.iter().zip(b.loc.iter_mut()) {
                            if x != y {
                                *y = V::Top;
                            }
                        }
                    }
                }
            }
            if iter > 40 {
                self.unsupported = true;
                break;
            }
            ent = nent;
        }
        let n = out.stk.len();
        if n > ra {
            out.stk.drain(0..n - ra);
        }
        out
    }

    fn step(&mut self, seq: InstrSeqId, ix: usize, ins: &'a Instr, mut st: St) -> St {
        let p = self.cx.p;
        let m = &p.m;
        macro_rules! popn {
            ($k:expr) => {
                self.pop(&mut st, $k)
            };
        }
        macro_rules! push {
            ($v:expr) => {
                st.stk.push(if st.live { $v } else { V::Top })
            };
        }
        let _ = (seq, ix);
        match ins {
            Instr::Block(b) => {
                let (pa, _) = seq_arity(m, self.lf.block(b.seq).ty);
                let args = popn!(pa);
                let inner = St { live: st.live, loc: std::mem::take(&mut st.loc), stk: args, mem: std::mem::take(&mut st.mem), sp: st.sp };
                let out = self.region(b.seq, inner, false);
                st.live = out.live;
                st.loc = out.loc;
                st.mem = out.mem;
                st.sp = out.sp;
                st.stk.extend(out.stk);
            }
            Instr::Loop(b) => {
                let (pa, _) = seq_arity(m, self.lf.block(b.seq).ty);
                let args = popn!(pa);
                let inner = St { live: st.live, loc: std::mem::take(&mut st.loc), stk: args, mem: std::mem::take(&mut st.mem), sp: st.sp };
                let out = self.region(b.seq, inner, true);
                st.live = out.live;
                st.loc = out.loc;
                st.mem = out.mem;
                st.sp = out.sp;
                st.stk.extend(out.stk);
            }
            Instr::TryTable(t) => {
                let (pa, _) = seq_arity(m, self.lf.block(t.seq).ty);
                let args = popn!(pa);
                let inner = St { live: st.live, loc: std::mem::take(&mut st.loc), stk: args, mem: std::mem::take(&mut st.mem), sp: st.sp };
                self.handlers.push(&t.catches);
                let out = self.region(t.seq, inner, false);
                self.handlers.pop();
                st.live = out.live;
                st.loc = out.loc;
                st.mem = out.mem;
                st.sp = out.sp;
                st.stk.extend(out.stk);
            }
            Instr::Try(t) => {
                let (pa, ra) = seq_arity(m, self.lf.block(t.seq).ty);
                let args = popn!(pa);
                let inner = St { live: st.live, loc: std::mem::take(&mut st.loc), stk: args, mem: std::mem::take(&mut st.mem), sp: st.sp };
                let entries: Vec<(Option<TagId>, InstrSeqId)> = t
                    .catches
                    .iter()
                    .filter_map(|c| match c {
                        LegacyCatch::Catch { tag, handler } => Some((Some(*tag), *handler)),
                        LegacyCatch::CatchAll { handler } => Some((None, *handler)),
                        LegacyCatch::Delegate { .. } => None,
                    })
                    .collect();
                self.legacy.push((t.seq, entries.clone()));
                let out = self.region(t.seq, inner, false);
                self.legacy.pop();
                let mut acc = Some(out);
                for (_, h) in entries {
                    if let Some(Some(e)) = self.legacy_entry.remove(&h) {
                        self.arity.insert(h, ra);
                        // A legacy handler's rethrow re-raises whatever it caught.
                        let o = self.region(h, e, false);
                        join_into(&mut acc, &o);
                    }
                }
                let o = acc.unwrap();
                st.live = o.live;
                st.loc = o.loc;
                st.mem = o.mem;
                st.sp = o.sp;
                st.stk.extend(o.stk);
            }
            Instr::IfElse(ie) => {
                let c = popn!(1)[0];
                self.esc(&[c]);
                let (pa, _) = seq_arity(m, self.lf.block(ie.consequent).ty);
                let args = popn!(pa);
                let live = st.live;
                let (t_live, e_live) = match c {
                    V::C(0) => (false, live),
                    V::C(_) => (live, false),
                    _ => (live, live),
                };
                let loc = std::mem::take(&mut st.loc);
                let mem = std::mem::take(&mut st.mem);
                let a = St { live: t_live, loc: if t_live { loc.clone() } else { vec![] }, stk: args.clone(), mem: mem.clone(), sp: st.sp };
                let b = St { live: e_live, loc: if e_live { loc } else { vec![] }, stk: args, mem, sp: st.sp };
                let oa = self.region(ie.consequent, a, false);
                let ob = self.region(ie.alternative, b, false);
                let mut o = Some(oa);
                join_into(&mut o, &ob);
                let o = o.unwrap();
                st.live = o.live;
                st.loc = o.loc;
                st.mem = o.mem;
                st.sp = o.sp;
                st.stk.extend(o.stk);
            }
            Instr::Br(b) => {
                self.branch(b.block, &st);
                st.live = false;
            }
            Instr::BrIf(b) => {
                let c = popn!(1)[0];
                self.esc(&[c]);
                match c {
                    V::C(0) => {}
                    V::C(_) => {
                        self.branch(b.block, &st);
                        st.live = false;
                    }
                    _ => self.branch(b.block, &st),
                }
            }
            Instr::BrTable(b) => {
                let c = popn!(1)[0];
                match c {
                    V::C(k) if k >= 0 && (k as usize) < b.blocks.len() => self.branch(b.blocks[k as usize], &st),
                    V::C(_) => self.branch(b.default, &st),
                    _ => {
                        let mut seen = HashSet::new();
                        for &t in b.blocks.iter().chain(std::iter::once(&b.default)) {
                            if seen.insert(t) {
                                self.branch(t, &st);
                            }
                        }
                    }
                }
                st.live = false;
            }
            Instr::Return(_) => {
                let n = st.stk.len();
                let rs: Vec<V> = st.stk[n.saturating_sub(self.nres)..].to_vec();
                self.esc(&rs);
                if st.live {
                    let v = if self.nres == 1 { st.stk.last().copied().unwrap_or(V::Top) } else { V::Top };
                    self.ret = Some(self.ret.map_or(v, |r| joinv(r, v)));
                    if !self.returned && self.why.len() < 6 {
                        self.why.push("reaches return".into());
                    }
                    self.returned = true;
                }
                st.live = false;
            }
            Instr::Unreachable(_) => st.live = false,
            Instr::Throw(t) => {
                let (pa, _) = m.types.params_results(m.tags.get(t.tag).ty);
                let a = popn!(pa.len());
                self.esc(&a);
                let bit = 1u64 << p.tag_bit[&t.tag];
                let snap = st.clone();
                self.throw(&snap, bit, "throw");
                st.live = false;
            }
            Instr::ThrowRef(_) => {
                let v = popn!(1)[0];
                let tags = match v {
                    V::Exn(t) => t,
                    _ => TAGS_ALL,
                };
                let snap = st.clone();
                self.throw(&snap, tags, "throw_ref");
                st.live = false;
            }
            Instr::Rethrow(_) => {
                let snap = st.clone();
                self.throw(&snap, TAGS_ALL, "rethrow");
                st.live = false;
            }
            Instr::Call(c) => {
                let (pa, ra) = m.types.params_results(m.funcs.get(c.func).ty());
                let (pa, ra) = (pa.len(), ra.len());
                let why = p.names[c.func.index()].clone();
                self.call(&mut st, vec![c.func.index() as u32], false, pa, ra, false, why);
            }
            Instr::ReturnCall(c) => {
                let (pa, ra) = m.types.params_results(m.funcs.get(c.func).ty());
                let (pa, ra) = (pa.len(), ra.len());
                let why = p.names[c.func.index()].clone();
                self.call(&mut st, vec![c.func.index() as u32], false, pa, ra, true, why);
            }
            Instr::CallIndirect(c) => {
                let idx = popn!(1)[0];
                let (pa, ra) = m.types.params_results(c.ty);
                let (pa, ra) = (pa.len(), ra.len());
                let key = p.tkey[&c.ty];
                let signal = p.signal_fns.contains(&self.f);
                let (mut t, ext) = self.icall_targets(key, table_ix(m, c.table), idx, signal);
                if self.cx.p.start_fns.contains(&self.f) {
                    // main-direct what-if: the crt's own call reaches main
                    // even when typed targets (CFI type mismatch) drop it.
                    for &mf in &self.cx.p.main_fns {
                        if p.skey[mf as usize] == key && !t.contains(&mf) {
                            t.push(mf);
                        }
                    }
                }
                let why = format!("call_indirect {:?}{} ({} targets)", m.types.get(c.ty).params(), if signal { " [signal]" } else { "" }, t.len());
                self.call(&mut st, t, ext, pa, ra, false, why);
            }
            Instr::ReturnCallIndirect(c) => {
                let idx = popn!(1)[0];
                let (pa, ra) = m.types.params_results(c.ty);
                let (pa, ra) = (pa.len(), ra.len());
                let key = p.tkey[&c.ty];
                let (t, ext) = self.icall_targets(key, table_ix(m, c.table), idx, false);
                self.call(&mut st, t, ext, pa, ra, true, "return_call_indirect".into());
            }
            Instr::CallRef(c) => {
                popn!(1);
                let (pa, ra) = m.types.params_results(c.ty);
                let (pa, ra) = (pa.len(), ra.len());
                let key = p.tkey[&c.ty];
                let t: Vec<u32> = (0..p.n as u32).filter(|&f| p.escapes[f as usize] && p.skey[f as usize] == key).collect();
                self.call(&mut st, t, p.dyn_link, pa, ra, false, "call_ref".into());
            }
            Instr::ReturnCallRef(c) => {
                popn!(1);
                let (pa, ra) = m.types.params_results(c.ty);
                let (pa, ra) = (pa.len(), ra.len());
                let key = p.tkey[&c.ty];
                let t: Vec<u32> = (0..p.n as u32).filter(|&f| p.escapes[f as usize] && p.skey[f as usize] == key).collect();
                self.call(&mut st, t, p.dyn_link, pa, ra, true, "return_call_ref".into());
            }
            Instr::LocalGet(l) => {
                let i = self.info.lidx[&l.local];
                let v = if st.live { st.loc[i] } else { V::Top };
                push!(v);
            }
            Instr::LocalSet(l) => {
                let v = popn!(1)[0];
                if st.live {
                    let i = self.info.lidx[&l.local];
                    st.loc[i] = v;
                    self.note_exn(i, v);
                }
            }
            Instr::LocalTee(l) => {
                let v = *st.stk.last().unwrap_or(&V::Top);
                if st.live {
                    let i = self.info.lidx[&l.local];
                    st.loc[i] = v;
                    self.note_exn(i, v);
                }
            }
            Instr::GlobalGet(g) => {
                let v = if self.frame_ok && Some(g.global) == p.sp_global {
                    st.sp.map_or(V::Top, V::Sp)
                } else {
                    p.gconst.get(&g.global).map_or(V::Top, |&c| V::C(c))
                };
                push!(v);
            }
            Instr::GlobalSet(g) => {
                let v = popn!(1)[0];
                if Some(g.global) == p.sp_global {
                    st.sp = match v {
                        V::Sp(k) => Some(k),
                        _ => None,
                    };
                } else {
                    self.esc(&[v]);
                }
            }
            Instr::Const(c) => {
                let v = match c.value {
                    Value::I32(x) => V::C(x as i64),
                    Value::I64(x) => V::C(x),
                    _ => V::Top,
                };
                push!(v);
            }
            Instr::Binop(b) => {
                let a = popn!(2);
                let v = match (b.op, a[0], a[1]) {
                    (BinaryOp::I32Add | BinaryOp::I64Add, V::Sp(k), V::C(c)) | (BinaryOp::I32Add | BinaryOp::I64Add, V::C(c), V::Sp(k)) => V::Sp(k + c),
                    (BinaryOp::I32Sub | BinaryOp::I64Sub, V::Sp(k), V::C(c)) => V::Sp(k - c),
                    _ => {
                        self.esc(&a);
                        binop(b.op, a[0], a[1])
                    }
                };
                push!(v);
            }
            Instr::Unop(u) => {
                let a = popn!(1)[0];
                self.esc(&[a]);
                push!(unop(u.op, a));
            }
            Instr::TernOp(_) => {
                popn!(3);
                push!(V::Top);
            }
            Instr::Select(_) => {
                let a = popn!(3);
                let v = match a[2] {
                    V::C(0) => a[1],
                    V::C(_) => a[0],
                    _ => joinv(a[0], a[1]),
                };
                push!(v);
            }
            Instr::Drop(_) => {
                popn!(1);
            }
            Instr::MemorySize(_) | Instr::TableSize(_) | Instr::RefNull(_) | Instr::RefFunc(_) => push!(V::Top),
            Instr::Load(l) => {
                let a = popn!(1)[0];
                let w = match l.kind {
                    LoadKind::I32 { .. } => 4,
                    LoadKind::I64 { .. } => 8,
                    _ => 0,
                };
                let v = match a {
                    V::Sp(k) if self.frame_ok && w > 0 => {
                        let key = k + l.arg.offset as i64;
                        st.mem.iter().find(|e| e.0 == key && e.1 == w).map_or(V::Top, |e| e.2)
                    }
                    _ => V::Top,
                };
                push!(v);
            }
            Instr::MemoryGrow(_) | Instr::TableGet(_) | Instr::RefIsNull(_) | Instr::RefAsNonNull(_) => {
                popn!(1);
                push!(V::Top);
            }
            Instr::MemoryInit(_) | Instr::MemoryCopy(_) | Instr::MemoryFill(_) | Instr::TableFill(_) | Instr::TableInit(_) | Instr::TableCopy(_) => {
                let a = popn!(3);
                self.esc(&a);
            }
            Instr::DataDrop(_) | Instr::ElemDrop(_) | Instr::AtomicFence(_) => {}
            Instr::Store(sto) => {
                let a = popn!(2);
                self.esc(&a[1..]);
                if let V::Sp(k) = a[0] {
                    if self.frame_ok && st.live {
                        let key = k + sto.arg.offset as i64;
                        let w = sto.kind.width() as i64;
                        st.mem.retain(|e| e.0 + e.1 as i64 <= key || key + w <= e.0);
                        let full = matches!(sto.kind, StoreKind::I32 { atomic: false } | StoreKind::I64 { atomic: false });
                        if full && !matches!(a[1], V::Sp(_)) {
                            st.mem.push((key, w as u32, a[1]));
                            st.mem.sort_by_key(|e| (e.0, e.1));
                        }
                    }
                }
            }
            Instr::TableSet(_) => {
                popn!(2);
            }
            Instr::AtomicRmw(_) | Instr::AtomicNotify(_) | Instr::TableGrow(_) | Instr::I8x16Swizzle(_) | Instr::I8x16Shuffle(_) | Instr::RefEq(_) => {
                let a = popn!(2);
                self.esc(&a);
                push!(V::Top);
            }
            Instr::Cmpxchg(_) | Instr::AtomicWait(_) | Instr::V128Bitselect(_) => {
                let a = popn!(3);
                self.esc(&a);
                push!(V::Top);
            }
            Instr::LoadSimd(l) => {
                use LoadSimdKind::*;
                match l.kind {
                    V128Load8Lane(_) | V128Load16Lane(_) | V128Load32Lane(_) | V128Load64Lane(_) => {
                        popn!(2);
                        push!(V::Top);
                    }
                    V128Store8Lane(_) | V128Store16Lane(_) | V128Store32Lane(_) | V128Store64Lane(_) => {
                        popn!(2);
                    }
                    _ => {
                        popn!(1);
                        push!(V::Top);
                    }
                }
            }
            Instr::BrOnNull(b) => {
                let v = popn!(1);
                self.branch(b.block, &st);
                st.stk.push(v[0]);
            }
            Instr::BrOnNonNull(b) => {
                let v = popn!(1);
                st.stk.push(v[0]);
                self.branch(b.block, &st);
                st.stk.pop();
            }
            _ => {
                // GC / wide-arithmetic instructions: not produced by the
                // C/C++ toolchain; give up on this body conservatively.
                self.unsupported = true;
                st.live = false;
            }
        }
        st
    }
}

fn binop(op: BinaryOp, a: V, b: V) -> V {
    use BinaryOp::*;
    let (V::C(x), V::C(y)) = (a, b) else {
        // x == x style folds are not needed for the fork-result tests.
        return V::Top;
    };
    let (x32, y32) = (x as i32, y as i32);
    let r = match op {
        I32Eq => (x32 == y32) as i64,
        I32Ne => (x32 != y32) as i64,
        I32LtS => (x32 < y32) as i64,
        I32LtU => ((x32 as u32) < (y32 as u32)) as i64,
        I32GtS => (x32 > y32) as i64,
        I32GtU => ((x32 as u32) > (y32 as u32)) as i64,
        I32LeS => (x32 <= y32) as i64,
        I32LeU => ((x32 as u32) <= (y32 as u32)) as i64,
        I32GeS => (x32 >= y32) as i64,
        I32GeU => ((x32 as u32) >= (y32 as u32)) as i64,
        I64Eq => (x == y) as i64,
        I64Ne => (x != y) as i64,
        I64LtS => (x < y) as i64,
        I64LtU => ((x as u64) < (y as u64)) as i64,
        I64GtS => (x > y) as i64,
        I64GtU => ((x as u64) > (y as u64)) as i64,
        I64LeS => (x <= y) as i64,
        I64LeU => ((x as u64) <= (y as u64)) as i64,
        I64GeS => (x >= y) as i64,
        I64GeU => ((x as u64) >= (y as u64)) as i64,
        I32Add => x32.wrapping_add(y32) as i64,
        I32Sub => x32.wrapping_sub(y32) as i64,
        I32Mul => x32.wrapping_mul(y32) as i64,
        I32And => (x32 & y32) as i64,
        I32Or => (x32 | y32) as i64,
        I32Xor => (x32 ^ y32) as i64,
        I32Shl => x32.wrapping_shl(y32 as u32) as i64,
        I32ShrS => x32.wrapping_shr(y32 as u32) as i64,
        I32ShrU => (x32 as u32).wrapping_shr(y32 as u32) as i32 as i64,
        I64Add => x.wrapping_add(y),
        I64Sub => x.wrapping_sub(y),
        I64Mul => x.wrapping_mul(y),
        I64And => x & y,
        I64Or => x | y,
        I64Xor => x ^ y,
        _ => return V::Top,
    };
    V::C(r)
}

fn unop(op: UnaryOp, a: V) -> V {
    use UnaryOp::*;
    let V::C(x) = a else { return V::Top };
    match op {
        I32Eqz => V::C(((x as i32) == 0) as i64),
        I64Eqz => V::C((x == 0) as i64),
        I32WrapI64 => V::C(x as i32 as i64),
        I64ExtendSI32 => V::C(x as i32 as i64),
        I64ExtendUI32 => V::C(x as u32 as i64),
        I32Extend8S => V::C(x as i8 as i64),
        I32Extend16S => V::C(x as i16 as i64),
        _ => V::Top,
    }
}

// ------------------------------------------------------------- drivers

struct Res {
    ret: Option<V>,
    thr: Tags,
    why: Vec<String>,
    unsupported: bool,
    rec_vals: Vec<V>,
    sites: HashMap<(InstrSeqId, usize), HashSet<u32>>,
}

fn entry_seq_placeholder(lf: &LocalFunction) -> InstrSeqId {
    lf.entry_block()
}

fn interpret(cx: &mut Ctx, f: u32, info: &FnInfo, mode: Mode, inject: &HashMap<(InstrSeqId, usize), Inject>, rec: Option<(u32, u32)>) -> Res {
    interpret2(cx, f, info, mode, inject, rec, false)
}

fn interpret2(cx: &mut Ctx, f: u32, info: &FnInfo, mode: Mode, inject: &HashMap<(InstrSeqId, usize), Inject>, rec: Option<(u32, u32)>, rec_sites: bool) -> Res {
    interpret3(cx, f, info, mode, inject, rec, rec_sites, None)
}

/// One body. Child mode first runs a normal-mode pass to record the state
/// after each injected call, then resumes from those states. A body whose
/// frame address escapes is re-run without frame-slot tracking.
fn interpret3(
    cx: &mut Ctx,
    f: u32,
    info: &FnInfo,
    mode: Mode,
    inject: &HashMap<(InstrSeqId, usize), Inject>,
    rec: Option<(u32, u32)>,
    rec_sites: bool,
    entry_args: Option<&[V]>,
) -> Res {
    loop {
        let frame_ok = cx.p.sp_global.is_some() && !cx.frame_esc.contains(&f);
        let mut inj_states = HashMap::new();
        if mode == Mode::Child {
            let keys: HashMap<(InstrSeqId, usize), Option<St>> = inject.keys().map(|k| (*k, None)).collect();
            let (_, states, esc) = walk_body(cx, f, info, Mode::Normal, &HashMap::new(), None, false, Some(keys), HashMap::new(), frame_ok, None);
            if esc && frame_ok {
                cx.frame_esc.insert(f);
                continue;
            }
            inj_states = states.unwrap_or_default();
        }
        let (r, _, esc) = walk_body(cx, f, info, mode, inject, rec, rec_sites, None, inj_states, frame_ok, entry_args);
        if esc && frame_ok {
            cx.frame_esc.insert(f);
            continue;
        }
        return r;
    }
}

#[allow(clippy::too_many_arguments)]
fn walk_body(
    cx: &mut Ctx,
    f: u32,
    info: &FnInfo,
    mode: Mode,
    inject: &HashMap<(InstrSeqId, usize), Inject>,
    rec: Option<(u32, u32)>,
    rec_sites: bool,
    rec_states: Option<HashMap<(InstrSeqId, usize), Option<St>>>,
    inj_states: HashMap<(InstrSeqId, usize), Option<St>>,
    frame_ok: bool,
    entry_args: Option<&[V]>,
) -> (Res, Option<HashMap<(InstrSeqId, usize), Option<St>>>, bool) {
    let p = cx.p;
    let FunctionKind::Local(lf) = &p.m.funcs.get(p.fid(f)).kind else { unreachable!() };
    let nres = p.m.types.results(lf.ty()).len();
    let lf: &LocalFunction = lf;
    let mut w = Walk {
        cx,
        f,
        lf,
        info,
        mode,
        inject,
        labels: HashMap::new(),
        arity: HashMap::new(),
        handlers: vec![],
        legacy: vec![],
        legacy_entry: HashMap::new(),
        ret: None,
        returned: false,
        thr: 0,
        why: vec![],
        rec_callee: rec.map(|r| r.0),
        rec_param: rec.map_or(0, |r| r.1),
        rec_vals: vec![],
        unsupported: false,
        nres,
        cur: (lf.entry_block(), 0),
        rec_sites: if rec_sites { Some(HashMap::new()) } else { None },
        rec_states,
        inj_states,
        frame_ok,
        frame_escaped: false,
    };
    let entry = lf.entry_block();
    let st = match mode {
        Mode::Normal => {
            let mut loc = w.entry_locals();
            if let Some(a) = entry_args {
                for (i, v) in a.iter().enumerate() {
                    if i < loc.len() {
                        loc[i] = *v;
                    }
                }
            }
            St { live: true, loc, stk: vec![], mem: vec![], sp: Some(0) }
        }
        Mode::Child => St { live: false, loc: vec![], stk: vec![], mem: vec![], sp: None },
    };
    // The function body is a block whose label is the function return.
    w.arity.insert(entry, nres);
    w.labels.insert(entry, None);
    let out = w.run(entry, st);
    let acc = w.labels.remove(&entry).unwrap();
    let mut o = Some(out);
    if let Some(a) = acc {
        join_into(&mut o, &a);
    }
    let o = o.unwrap();
    if o.live {
        let v = if nres == 1 { o.stk.last().copied().unwrap_or(V::Top) } else { V::Top };
        if matches!(v, V::Sp(_)) {
            w.frame_escaped = true;
        }
        w.ret = Some(w.ret.map_or(v, |r| joinv(r, v)));
        if !w.returned && w.why.len() < 6 {
            w.why.push("falls off the end".into());
        }
    }
    let esc = w.frame_escaped;
    let states = w.rec_states.take();
    (Res { ret: w.ret, thr: w.thr, why: w.why, unsupported: w.unsupported, rec_vals: w.rec_vals, sites: w.rec_sites.unwrap_or_default() }, states, esc)
}

/// Targets of `call_indirect` through parameter `q` of `f`, when `f` is only
/// ever called directly and every caller passes a resolvable constant.
fn param_targets(cx: &mut Ctx, f: u32, q: u32, depth: u32) -> Option<Vec<u32>> {
    if let Some(r) = cx.ptarg.get(&(f, q)) {
        return r.clone();
    }
    let p = cx.p;
    if p.escapes[f as usize] || depth > 4 || p.slots.is_none() || p.callers[f as usize].is_empty() {
        return None;
    }
    cx.ptarg.insert((f, q), None); // cycle guard
    let mut out: Vec<u32> = vec![];
    let mut ok = true;
    for &g in &p.callers[f as usize].clone() {
        let FunctionKind::Local(lf) = &p.m.funcs.get(p.fid(g)).kind else {
            ok = false;
            break;
        };
        let info = fninfo(&p.m, lf);
        let empty: [Summ; 0] = [];
        let mut scratch = HashMap::new();
        let mut fe = HashSet::new();
        let mut sm = HashMap::new();
        let mut cx2 = Ctx { p, summ: &empty, ptarg: cx.ptarg, exn_seen: &mut scratch, frame_esc: &mut fe, allow_spec: false, spec: &mut sm, depth: 0 };
        let r = interpret(&mut cx2, g, &info, Mode::Normal, &HashMap::new(), Some((f, q)));
        if std::env::var("FSA_DEBUG_PARAM").is_ok() {
            eprintln!("param_targets {}#{q} caller {}: {:?} unsupported={}", p.names[f as usize], p.names[g as usize], r.rec_vals, r.unsupported);
        }
        if r.unsupported {
            ok = false;
            break;
        }
        for v in r.rec_vals {
            match v {
                V::C(k) => match p.slots.as_ref().unwrap().get(&k) {
                    Some(&t) => out.push(t),
                    None => {} // traps: no target
                },
                V::P(q2) => match param_targets(cx, g, q2, depth + 1) {
                    Some(v) => out.extend(v),
                    None => {
                        ok = false;
                        break;
                    }
                },
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            break;
        }
    }
    let r = if ok {
        out.sort();
        out.dedup();
        Some(out)
    } else {
        None
    };
    cx.ptarg.insert((f, q), r.clone());
    r
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |k: &str| args.iter().position(|a| a == k).map(|i| args[i + 1].clone());
    let has = |k: &str| args.iter().any(|a| a == k);
    let wasm = get("--wasm").expect("--wasm <module>");
    let mut p = Prog::load(&wasm);
    p.use_param = has("--param");
    // Rule 2 by run-time check: an exception or longjmp leaving a sink frame
    // in the child is a loud failure, so it does not reopen the sink.
    let exc_mode = get("--exc").unwrap_or_else(|| "static".into());
    let exc_runtime = exc_mode == "runtime";
    // equiv: a closed function may still let an exception escape (stopped
    // by the run-time check) only when no frame that can be above it on a
    // fork stack has a catch clause for that tag; then the check never
    // changes behaviour (the exception would reach the stack root anyway).
    let exc_equiv = exc_mode == "equiv";
    assert!(exc_runtime || exc_equiv || exc_mode == "static", "--exc static|equiv|runtime");
    let sig_fns = get("--signal-fns").unwrap_or_else(|| "__deliver_pending_signal,__do_syscall_impl".into());
    for n in sig_fns.split(',') {
        let pre = format!("{n}(");
        for f in 0..p.n as u32 {
            let nm = &p.names[f as usize];
            if nm == n || nm.starts_with(&pre) {
                p.signal_fns.insert(f);
            }
        }
    }
    p.sig_policy = match get("--signal-policy").as_deref() {
        None | Some("sig") => Policy::Sig,
        Some("nothrow") => Policy::NoThrow,
        Some(s) if s.starts_with("list:") => {
            let text = std::fs::read_to_string(&s[5..]).unwrap();
            for l in text.lines() {
                for f in p.by_name(l.trim()) {
                    p.sig_list.insert(f);
                }
            }
            Policy::List
        }
        Some(s) => panic!("unknown --signal-policy {s}"),
    };
    if let Some(path) = get("--itargets") {
        // fpa's signature strings: params,..->results with i32/i64/f32/f64/v128/ref.
        let vt = |t: &ValType| match t {
            ValType::I32 => "i32",
            ValType::I64 => "i64",
            ValType::F32 => "f32",
            ValType::F64 => "f64",
            ValType::V128 => "v128",
            _ => "ref",
        };
        let mut fpa_key: HashMap<String, Vec<u32>> = HashMap::new();
        for t in p.m.types.iter() {
            let sname = format!(
                "{}->{}",
                t.params().iter().map(vt).collect::<Vec<_>>().join(","),
                t.results().iter().map(vt).collect::<Vec<_>>().join(",")
            );
            let k = p.tkey[&t.id()];
            let e = fpa_key.entry(sname).or_default();
            if !e.contains(&k) {
                e.push(k);
            }
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let mut lines = 0;
        for l in text.lines() {
            let mut it = l.split('\t');
            let f: u32 = it.next().unwrap().parse().unwrap();
            let sname = it.next().unwrap();
            let t: Vec<u32> = it.next().unwrap_or("").split(',').filter(|x| !x.is_empty()).map(|x| x.parse().unwrap()).collect();
            for &k in fpa_key.get(sname).map(|v| v.as_slice()).unwrap_or(&[]) {
                let t: Vec<u32> = t.iter().copied().filter(|&g| p.skey[g as usize] == k).collect();
                p.itargets.insert((f, k), t);
            }
            lines += 1;
        }
        eprintln!("itargets: {lines} (function, signature) sets from {path}");
    }
    if let Some(path) = get("--cleanup-map") {
        p.cleanup_pop = p.by_name("_pthread_cleanup_pop").into_iter().collect();
        let mut n = 0;
        for l in std::fs::read_to_string(&path).unwrap().lines() {
            let (f, hs) = l.split_once('\t').unwrap_or((l, ""));
            let hv: Vec<u32> = hs.split('\u{1}').filter(|x| !x.is_empty()).flat_map(|h| p.by_name(h)).collect();
            for fi in p.by_name(f) {
                p.cleanup_map.insert(fi, hv.clone());
                n += 1;
            }
        }
        eprintln!("cleanup map: {n} callers of _pthread_cleanup_pop");
    }
    if has("--dlopen-contract") && p.dyn_link {
        // Load-time side-module contract (docs/plans/2026-10-02-fork-sinks.md,
        // "Fork sinks in programs that can dlopen"): the host refuses to load
        // a side module whose fork-open entries could be reached from a call
        // site the main module did not prepare, so side-module code never
        // forks beneath an unprepared main frame. The analysis may then
        // ignore side-module entries.
        p.dyn_link = false;
        eprintln!("dlopen contract: side-module entries ignored (enforced at load time)");
    }
    if has("--registries") {
        // musl callback registries (sources checked, no Kandelo overlay):
        // each hub's dispatch call reaches only callbacks passed to the
        // registration API. Applies only when every call to the API is a
        // direct call with a resolvable constant (param_targets proves it).
        // (hub, dispatch signature, [(api, arg)]). An absent API counts as
        // "never called" only where its source file contains no other caller
        // of it (checked against musl): pthread_atfork.c, pthread_once.c,
        // pthread_key_create.c and pthread_cleanup_push.c. atexit.c is the
        // exception: __cxa_atexit is inlined into atexit (handled below).
        let hubs: &[(&str, &str, &[(&str, u32)])] = &[
            ("__fork_handler", "[]->[]", &[("pthread_atfork", 0), ("pthread_atfork", 1), ("pthread_atfork", 2)]),
            ("__funcs_on_exit", "[I32]->[]", &[("__cxa_atexit", 0)]),
            ("__pthread_once_full", "[]->[]", &[("__pthread_once", 1)]),
            ("__pthread_tsd_run_dtors", "[I32]->[]", &[("__pthread_key_create", 1)]),
            ("_pthread_cleanup_pop", "[I32]->[]", &[("_pthread_cleanup_push", 1)]),
            ("__pthread_exit", "[I32]->[]", &[("__pthread_key_create", 1), ("_pthread_cleanup_push", 1)]),
        ];
        let absent_empty = ["pthread_atfork", "__pthread_once", "__pthread_key_create", "_pthread_cleanup_push"];
        let empty_s: [Summ; 0] = [];
        let mut scratch = HashMap::new();
        let mut cache: HashMap<(u32, u32), Option<Vec<u32>>> = HashMap::new();
        let mut reg = |p: &Prog, api: &str, k: u32, cache: &mut HashMap<(u32, u32), Option<Vec<u32>>>, scratch: &mut HashMap<u32, Tags>| -> Option<Vec<u32>> {
            let mut out = vec![];
            let mut fs = p.by_name(api);
            // musl weak aliases (pthread_once -> __pthread_once, ...) keep one name.
            if let Some(alias) = api.strip_prefix("__") {
                if alias.starts_with("pthread_") {
                    fs.extend(p.by_name(alias));
                }
            }
            if fs.is_empty() {
                // Absent may mean inlined within its own source file, not
                // "no registrations": unknown unless the file has no caller.
                return if absent_empty.contains(&api) { Some(vec![]) } else { None };
            }
            for f in fs {
                if p.import[f as usize] {
                    return None;
                }
                let mut fe = HashSet::new();
                let mut sm = HashMap::new();
                let mut cx = Ctx { p, summ: &empty_s, ptarg: cache, exn_seen: scratch, frame_esc: &mut fe, allow_spec: false, spec: &mut sm, depth: 0 };
                out.extend(param_targets(&mut cx, f, k, 0)?);
            }
            Some(out)
        };
        let mut overrides: Vec<((u32, u32), Vec<u32>)> = vec![];
        for (hub, sig, apis) in hubs {
            let Some(key) = keys_lookup(&p.m, &p.tkey, sig) else { continue };
            let mut t: Option<Vec<u32>> = Some(vec![]);
            for (api, k) in apis.iter() {
                match (t.as_mut(), reg(&p, api, *k, &mut cache, &mut scratch)) {
                    (Some(v), Some(x)) => v.extend(x),
                    _ => t = None,
                }
            }
            let hubs_f = p.by_name(hub);
            match t {
                Some(mut v) => {
                    v.sort();
                    v.dedup();
                    let v: Vec<u32> = v.into_iter().filter(|&g| p.skey[g as usize] == key).collect();
                    eprintln!("registry {hub}: {} callbacks {:?}", v.len(), v.iter().take(6).map(|&g| p.names[g as usize].as_str()).collect::<Vec<_>>());
                    for h in hubs_f {
                        overrides.push(((h, key), v.clone()));
                    }
                }
                None => eprintln!("registry {hub}: NOT applied (a registration is unresolvable)"),
            }
        }
        // __cxa_atexit inlined into atexit (same source file) and otherwise
        // unreferenced: the only callbacks __funcs_on_exit can see are the
        // function constants atexit itself stores, i.e. musl's `call`.
        if p.by_name("__cxa_atexit").is_empty() {
            if let (Some(key), [a]) = (keys_lookup(&p.m, &p.tkey, "[I32]->[]"), p.by_name("atexit").as_slice()) {
                let FunctionKind::Local(lf) = &p.m.funcs.get(p.fid(*a)).kind else { unreachable!() };
                let mut v: Vec<u32> = vec![];
                for (_, seq) in all_seqs(lf) {
                    for (ins, _) in &seq.instrs {
                        let c = match ins {
                            Instr::Const(Const { value: Value::I32(x) }) => Some(*x as i64),
                            Instr::GlobalGet(g) => p.gconst.get(&g.global).copied(),
                            _ => None,
                        };
                        if let Some(f) = c.and_then(|c| p.slots.as_ref().and_then(|s| s.get(&c))) {
                            if p.skey[*f as usize] == key {
                                v.push(*f);
                            }
                        }
                    }
                }
                v.sort();
                v.dedup();
                eprintln!("registry __funcs_on_exit via inlined __cxa_atexit in atexit: {:?}", v.iter().map(|&g| p.names[g as usize].as_str()).collect::<Vec<_>>());
                for h in p.by_name("__funcs_on_exit") {
                    overrides.push(((h, key), v.clone()));
                }
            }
        }
        // atexit(f) registers musl's static `call` with f as its argument.
        if let Some(key) = keys_lookup(&p.m, &p.tkey, "[]->[]") {
            let mut callers = reg(&p, "__cxa_atexit", 0, &mut cache, &mut scratch).unwrap_or_default();
            if let Some(((_, _), v)) = overrides.iter().find(|((h, _), _)| p.names[*h as usize] == "__funcs_on_exit") {
                callers.extend(v.iter().copied());
            }
            if let Some(mut v) = reg(&p, "atexit", 0, &mut cache, &mut scratch) {
                v.sort();
                v.dedup();
                for c in p.by_name("call") {
                    if callers.contains(&c) {
                        eprintln!("registry atexit call: {} callbacks", v.len());
                        overrides.push(((c, key), v.clone()));
                    }
                }
            }
        }
        for (k, v) in overrides {
            p.itargets.insert(k, v);
        }
    }
    if has("--main-direct") {
        for n in ["main", "__main_argc_argv", "__main_void"] {
            p.main_fns.extend(p.by_name(n));
        }
        for n in ["libc_start_main_stage2", "__libc_start_main"] {
            p.start_fns.extend(p.by_name(n));
        }
        eprintln!("main-direct what-if: {} main functions, {} start functions", p.main_fns.len(), p.start_fns.len());
    }
    if has("--cancel") {
        // musl sets pthread_t->cancel only in pthread_cancel and in
        // timer_create's SIGEV_THREAD worker (libc/musl-overlay checked).
        // With neither linked the flag stays 0, so the cancellation-point
        // checks never reach pthread_exit.
        let writers = ["pthread_cancel", "__pthread_cancel", "timer_create", "__timer_create"];
        let named = |p: &Prog, w: &str| -> Vec<u32> {
            let pre = format!("{w}(");
            (0..p.n as u32).filter(|&f| p.names[f as usize] == w || p.names[f as usize].starts_with(&pre)).collect()
        };
        let linked: Vec<&str> = writers.iter().copied().filter(|w| named(&p, w).iter().any(|&f| !p.import[f as usize])).collect();
        if linked.is_empty() {
            let checks = ["__syscall_cp_check", "__syscall_cp_cancel_preflight", "__testcancel", "__cancel", "__pthread_testcancel", "pthread_testcancel"];
            let exits: Vec<u32> = ["pthread_exit", "__pthread_exit"].iter().flat_map(|n| named(&p, n)).collect();
            for c in checks {
                for f in named(&p, c) {
                    for &e in &exits {
                        p.cut.insert((f, e));
                    }
                }
            }
            eprintln!("cancel rule: no cancel writer linked; {} cancellation edges cut", p.cut.len());
        } else {
            eprintln!("cancel rule: NOT applied, cancel writers linked: {linked:?}");
        }
    }
    let n = p.n;
    eprintln!(
        "{}: functions {} (imports {}), table slots {}, dynamic linking {}, signal dispatch fns {:?}",
        wasm,
        n,
        p.import.iter().filter(|x| **x).count(),
        p.slots.as_ref().map_or("unknown/mutable".into(), |s| s.len().to_string()),
        p.dyn_link,
        p.signal_fns.iter().map(|&f| p.names[f as usize].clone()).collect::<Vec<_>>()
    );

    // Baseline: the shipped instrumenter's closure.
    let seed = fork_instrument::call_graph::find_import_func(&p.m, "kernel.kernel_fork").expect("module does not import kernel.kernel_fork");
    let base = fork_instrument::call_graph::analyze_reaching_closure(&p.m, seed);
    let r_set: HashSet<u32> = base.activations.iter().map(|f| f.index() as u32).collect();
    let r_ctrl: HashSet<u32> = base.control_reachable.iter().map(|f| f.index() as u32).collect();
    let seed_i = seed.index() as u32;
    let instrumented_today = r_set.iter().filter(|&&f| !p.import[f as usize]).count();

    // Per-function info.
    let infos: Vec<Option<FnInfo>> = (0..n)
        .map(|i| match &p.m.funcs.get(p.fid(i as u32)).kind {
            FunctionKind::Local(lf) => Some(fninfo(&p.m, lf)),
            _ => None,
        })
        .collect();

    // ---- 1. whole-program summaries (least fixpoint)
    let t0 = std::time::Instant::now();
    let mut summ = vec![Summ::default(); n];
    for i in 0..n {
        if p.import[i] {
            summ[i] = Summ { ret: true, thr: 0 };
        }
    }
    let mut ptarg: HashMap<(u32, u32), Option<Vec<u32>>> = HashMap::new();
    let mut exn_seen: HashMap<u32, Tags> = HashMap::new();
    let mut frame_esc: HashSet<u32> = HashSet::new();
    let mut spec_memo: HashMap<(u32, Vec<V>), (Option<V>, Tags)> = HashMap::new();
    let mut queued = vec![false; n];
    let mut work: VecDeque<u32> = VecDeque::new();
    for i in 0..n {
        if !p.import[i] {
            work.push_back(i as u32);
            queued[i] = true;
        }
    }
    let mut unsupported_fns = 0usize;
    let mut evals = 0usize;
    let empty = HashMap::new();
    while let Some(f) = work.pop_front() {
        queued[f as usize] = false;
        evals += 1;
        let info = infos[f as usize].as_ref().unwrap();
        let snapshot = summ.clone();
        let mut cx = Ctx { p: &p, summ: &snapshot, ptarg: &mut ptarg, exn_seen: &mut exn_seen, frame_esc: &mut frame_esc, allow_spec: false, spec: &mut spec_memo, depth: 0 };
        let r = interpret(&mut cx, f, info, Mode::Normal, &empty, None);
        let mut s = Summ { ret: r.ret.is_some(), thr: r.thr };
        if r.unsupported {
            s = Summ { ret: true, thr: TAGS_ALL };
            if std::env::var("FSA_SHOW_UNSUPPORTED").is_ok() && summ[f as usize].thr != TAGS_ALL {
                eprintln!("UNSUPPORTED\t{}", p.names[f as usize]);
            }
        }
        if p.noreturn[f as usize] {
            s.ret = false;
        }
        if p.nothrow[f as usize] {
            // C11 7.22.4.4 / C++ [support.start.term] / POSIX pthread_exit:
            // an exception or longjmp leaving a handler that exit() or
            // pthread_exit() runs is undefined behaviour (C++: terminate).
            s.thr = 0;
        }
        let old = summ[f as usize];
        let new = Summ { ret: old.ret | s.ret, thr: old.thr | s.thr };
        if new != old {
            summ[f as usize] = new;
            for &c in &p.callers[f as usize] {
                if !queued[c as usize] {
                    queued[c as usize] = true;
                    work.push_back(c);
                }
            }
            if p.escapes[f as usize] {
                if let Some(cs) = p.icallers.get(&p.skey[f as usize]) {
                    for &c in cs {
                        if !queued[c as usize] {
                            queued[c as usize] = true;
                            work.push_back(c);
                        }
                    }
                }
            }
        }
        if evals > 50 * n {
            panic!("summary fixpoint did not converge");
        }
    }
    for i in 0..n {
        if !p.import[i] && summ[i] == (Summ { ret: true, thr: TAGS_ALL }) {
            unsupported_fns += 0;
        }
    }
    let _ = unsupported_fns;
    let noret = (0..n).filter(|&i| !p.import[i] && !summ[i].ret).count();
    let throwing = (0..n).filter(|&i| summ[i].thr != 0).count();
    eprintln!(
        "summaries: {} evaluations in {:.1}s; {} functions never return, {} may throw",
        evals,
        t0.elapsed().as_secs_f32(),
        noret,
        throwing
    );

    if let Some(name) = get("--why-throw") {
        let mut cur = name.clone();
        let mut seen: HashSet<String> = HashSet::new();
        for _ in 0..25 {
            let Some(f) = p.by_name(&cur).into_iter().find(|&f| !p.import[f as usize]) else { break };
            seen.insert(cur.clone());
            let mut snapshot = summ.clone();
            snapshot[f as usize].thr = 0;
            let mut cx = Ctx { p: &p, summ: &snapshot, ptarg: &mut ptarg, exn_seen: &mut exn_seen, frame_esc: &mut frame_esc, allow_spec: true, spec: &mut spec_memo, depth: 0 };
            let r = interpret(&mut cx, f, infos[f as usize].as_ref().unwrap(), Mode::Normal, &empty, None);
            println!("WHY-THROW\t{cur}\tthr={:#x}\t{}", r.thr, r.why.iter().filter(|w| w.starts_with("throws")).cloned().collect::<Vec<_>>().join(" | "));
            let next = r
                .why
                .iter()
                .filter(|w| w.starts_with("throws"))
                .filter_map(|w| w.split(" via ").nth(1))
                .find(|x| !seen.contains(*x))
                .map(|x| x.to_string());
            match next {
                Some(nx) if !nx.starts_with("call_indirect") && !nx.starts_with("throw") => cur = nx,
                Some(nx) => {
                    println!("WHY-THROW\t(stops at {nx})");
                    break;
                }
                None => break,
            }
        }
    }

    // ---- 2. child continuation fixpoint over the fork path
    // Fork-reaching call sites per function: (seq, index, targets on path).
    let t1 = std::time::Instant::now();
    // Resolved call targets per call instruction, from a normal-mode pass
    // over every body (dead code contributes nothing).
    let mut all_sites: HashMap<u32, Vec<(InstrSeqId, usize, Vec<u32>)>> = HashMap::new();
    let mut gate_fns: HashSet<u32> = HashSet::new();
    {
        let snapshot = summ.clone();
        for f in 0..n as u32 {
            if p.import[f as usize] {
                continue;
            }
            let mut cx = Ctx { p: &p, summ: &snapshot, ptarg: &mut ptarg, exn_seen: &mut exn_seen, frame_esc: &mut frame_esc, allow_spec: true, spec: &mut spec_memo, depth: 0 };
            let r = interpret2(&mut cx, f, infos[f as usize].as_ref().unwrap(), Mode::Normal, &empty, None, true);
            let mut v: Vec<(InstrSeqId, usize, Vec<u32>)> = r
                .sites
                .into_iter()
                .map(|(k, t)| {
                    let mut t: Vec<u32> = t.into_iter().collect();
                    t.sort();
                    t.dedup();
                    (k.0, k.1, t)
                })
                .collect();
            v.sort_by_key(|x| (x.0.index(), x.1));
            if p.signal_fns.contains(&f) && p.sig_policy != Policy::Sig {
                gate_fns.insert(f);
            }
            all_sites.insert(f, v);
        }
    }
    // Fork-reaching closure under the same refinements (R').
    let mut rdeps_all: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&f, v) in &all_sites {
        for (_, _, t) in v {
            for &g in t {
                rdeps_all.entry(g).or_default().push(f);
            }
        }
    }
    // EXT: a call that may enter a dlopen'd side module, which may fork.
    let ext_i = u32::MAX - 1;
    let mut r2: HashSet<u32> = HashSet::new();
    let mut q: VecDeque<u32> = VecDeque::new();
    r2.insert(seed_i);
    q.push_back(seed_i);
    if p.dyn_link {
        r2.insert(ext_i);
        q.push_back(ext_i);
    }
    while let Some(g) = q.pop_front() {
        if let Some(cs) = rdeps_all.get(&g) {
            for &c in cs {
                if r2.insert(c) {
                    q.push_back(c);
                }
            }
        }
    }
    if let Some(names) = get("--throw-path") {
        // Shortest call path from each named function to a function that
        // itself executes `throw`, through callees that may throw.
        let throws_itself: HashSet<u32> = (0..n as u32)
            .filter(|&f| {
                let FunctionKind::Local(lf) = &p.m.funcs.get(p.fid(f)).kind else { return false };
                all_seqs(lf).iter().any(|(_, s)| s.instrs.iter().any(|(i, _)| matches!(i, Instr::Throw(_))))
            })
            .collect();
        for name in names.split(',') {
            for f0 in p.by_name(name) {
                let mut prev: HashMap<u32, u32> = HashMap::new();
                let mut q = VecDeque::from([f0]);
                prev.insert(f0, f0);
                let mut hit = None;
                while let Some(g) = q.pop_front() {
                    if throws_itself.contains(&g) && g != f0 {
                        hit = Some(g);
                        break;
                    }
                    for (_, _, t) in all_sites.get(&g).map(|v| v.as_slice()).unwrap_or(&[]) {
                        for &h in t {
                            if h != seed_i && h != ext_i && !p.import[h as usize] && summ[h as usize].thr != 0 && !prev.contains_key(&h) {
                                prev.insert(h, g);
                                q.push_back(h);
                            }
                        }
                    }
                }
                let mut path = vec![];
                if let Some(mut x) = hit {
                    while x != f0 {
                        path.push(p.names[x as usize].clone());
                        x = prev[&x];
                    }
                }
                path.reverse();
                println!("THROW-PATH\t{name}\t{}", if path.is_empty() { "<none>".into() } else { path.join(" -> ") });
            }
        }
    }
    if let Some(names) = get("--fork-path") {
        // Shortest call path from each named function to kernel_fork (or a
        // side-module boundary) over the refined call graph.
        for name in names.split(',') {
            for f0 in p.by_name(name) {
                let mut prev: HashMap<u32, u32> = HashMap::from([(f0, f0)]);
                let mut q = VecDeque::from([f0]);
                let mut hit = None;
                while let Some(g) = q.pop_front() {
                    if g == seed_i || g == ext_i {
                        hit = Some(g);
                        break;
                    }
                    for (_, _, t) in all_sites.get(&g).map(|v| v.as_slice()).unwrap_or(&[]) {
                        for &h in t {
                            if r2.contains(&h) && !prev.contains_key(&h) {
                                prev.insert(h, g);
                                q.push_back(h);
                            }
                        }
                    }
                }
                let mut path = vec![];
                if let Some(mut x) = hit {
                    while x != f0 {
                        path.push(if x == ext_i { "<side module>".to_string() } else { p.names[x as usize].clone() });
                        x = prev[&x];
                    }
                }
                path.reverse();
                println!("FORK-PATH\t{name}\t{}", if path.is_empty() { "<none>".into() } else { path.join(" -> ") });
            }
        }
    }
    let on_path = |g: u32| r2.contains(&g);
    let refined_today = r2.iter().filter(|&&f| f != ext_i && !p.import[f as usize]).count();
    let mut sites: HashMap<u32, Vec<(InstrSeqId, usize, Vec<u32>)>> = HashMap::new();
    for (&f, v) in &all_sites {
        if !r2.contains(&f) {
            continue;
        }
        let w: Vec<(InstrSeqId, usize, Vec<u32>)> = v
            .iter()
            .filter_map(|(a, b, t)| {
                let t: Vec<u32> = t.iter().copied().filter(|&g| on_path(g)).collect();
                (!t.is_empty()).then(|| (*a, *b, t))
            })
            .collect();
        if !w.is_empty() {
            sites.insert(f, w);
        }
    }
    let _ = &r_ctrl;
    // For each sink whose child continuation may still throw, can any frame
    // above it catch that tag? (catch tag / catch_ref tag / catch_all /
    // catch_all_ref all count, so C++ cleanups count too: conservative.)
    // Catching frames. --catchers coarse: any catch clause counts.
    // precise (default): a clause counts only if its landing can do
    // something other than rethrow the caught exception (a cleanup pad) or
    // call std::terminate (a noexcept pad): i.e. it is a real handler.
    let precise_catchers = get("--catchers").as_deref() != Some("coarse");
    const PROBE: Tags = 1 << 62;
    let mut catches: HashMap<u32, Tags> = HashMap::new();
    let mut clause_stats = [0usize; 4]; // handler, cleanup, terminate, unknown
    // The longjmp tag is the one `__wasm_longjmp` throws (LLVM SjLj lowering).
    let mut longjmp_bits: Tags = 0;
    for f in p.by_name("__wasm_longjmp") {
        if let FunctionKind::Local(lf) = &p.m.funcs.get(p.fid(f)).kind {
            for (_, seq) in all_seqs(lf) {
                for (ins, _) in &seq.instrs {
                    if let Instr::Throw(t) = ins {
                        longjmp_bits |= 1u64 << p.tag_bit[&t.tag];
                    }
                }
            }
        }
    }
    eprintln!("longjmp tag bits: {longjmp_bits:#x}");
    {
        let snapshot = summ.clone();
        let terminate_like = |p: &Prog, f: u32| {
            let n = &p.names[f as usize];
            n.contains("terminate") || n == "abort" || n.starts_with("abort(")
        };
        for f in 0..n as u32 {
            let FunctionKind::Local(lf) = &p.m.funcs.get(p.fid(f)).kind else { continue };
            let seqs = all_seqs(lf);
            let mut parent: HashMap<InstrSeqId, (InstrSeqId, usize)> = HashMap::new();
            for (sid, seq) in &seqs {
                for (ix, (ins, _)) in seq.instrs.iter().enumerate() {
                    match ins {
                        Instr::Block(b) => {
                            parent.insert(b.seq, (*sid, ix));
                        }
                        Instr::Loop(b) => {
                            parent.insert(b.seq, (*sid, ix));
                        }
                        Instr::TryTable(t) => {
                            parent.insert(t.seq, (*sid, ix));
                        }
                        _ => {}
                    }
                }
            }
            let mut t: Tags = 0;
            for (_, seq) in &seqs {
                for (ins, _) in &seq.instrs {
                    match ins {
                        Instr::TryTable(tt) => {
                            for c in &tt.catches {
                                let (bits, label, vals): (Tags, InstrSeqId, Vec<V>) = match c {
                                    TryTableCatch::Catch { tag, label } => {
                                        let k = p.m.types.params(p.m.tags.get(*tag).ty).len();
                                        (1u64 << p.tag_bit[tag], *label, vec![V::Top; k])
                                    }
                                    TryTableCatch::CatchRef { tag, label } => {
                                        let k = p.m.types.params(p.m.tags.get(*tag).ty).len();
                                        let mut v = vec![V::Top; k];
                                        v.push(V::Exn(PROBE));
                                        (1u64 << p.tag_bit[tag], *label, v)
                                    }
                                    // A POSIX longjmp lands only in the frame that called
                                    // setjmp (an explicit catch of the longjmp tag); a C++
                                    // catch(...) does not catch it, so catch_all clauses
                                    // never count as longjmp catchers.
                                    TryTableCatch::CatchAll { label } => (TAGS_ALL & !PROBE & !longjmp_bits, *label, vec![]),
                                    TryTableCatch::CatchAllRef { label } => (TAGS_ALL & !PROBE & !longjmp_bits, *label, vec![V::Exn(PROBE)]),
                                };
                                if !precise_catchers {
                                    t |= bits;
                                    continue;
                                }
                                let landing = parent.get(&label).copied().filter(|(ps, pi)| {
                                    matches!(lf.block(*ps).instrs[*pi].0, Instr::Block(_)) && vals.len() <= 4
                                });
                                let Some((ps, pi)) = landing else {
                                    clause_stats[3] += 1;
                                    t |= bits;
                                    continue;
                                };
                                let mut arr = [V::Top; 4];
                                arr[..vals.len()].copy_from_slice(&vals);
                                let mut inj = HashMap::new();
                                inj.insert((ps, pi), Inject { ret: None, thr: 0, top: Some((vals.len() as u8, arr)) });
                                let mut cx = Ctx { p: &p, summ: &snapshot, ptarg: &mut ptarg, exn_seen: &mut exn_seen, frame_esc: &mut frame_esc, allow_spec: true, spec: &mut spec_memo, depth: 0 };
                                let r = interpret(&mut cx, f, infos[f as usize].as_ref().unwrap(), Mode::Child, &inj, None);
                                // First call on the landing, skipping SP restores and
                                // other straight-line scalar work.
                                let next_call = lf.block(ps).instrs[pi + 1..]
                                    .iter()
                                    .map(|(i, _)| i)
                                    .take_while(|i| matches!(i, Instr::LocalGet(_) | Instr::LocalSet(_) | Instr::LocalTee(_) | Instr::GlobalGet(_) | Instr::GlobalSet(_) | Instr::Const(_) | Instr::Drop(_) | Instr::Call(_)))
                                    .find_map(|i| match i {
                                        Instr::Call(c) => Some(c.func.index() as u32),
                                        _ => None,
                                    });
                                let handler = if next_call.is_some_and(|c| terminate_like(&p, c)) {
                                    false // noexcept pad: std::terminate never returns
                                } else if r.unsupported {
                                    true
                                } else if r.ret.is_some() {
                                    true
                                } else if r.thr & PROBE != 0 {
                                    false // cleanup: rethrows the caught exception
                                } else {
                                    // Terminates: a noexcept pad if it goes straight to
                                    // std::terminate/abort, otherwise a handler that
                                    // ends the process its own way (e.g. exit(1)).
                                    !next_call.is_some_and(|c| terminate_like(&p, c))
                                };
                                let terminate_pad = next_call.is_some_and(|c| terminate_like(&p, c));
                                if handler {
                                    clause_stats[0] += 1;
                                    t |= bits;
                                } else if !terminate_pad && r.thr & PROBE != 0 {
                                    clause_stats[1] += 1;
                                } else {
                                    clause_stats[2] += 1;
                                }
                            }
                        }
                        Instr::Try(_) => t = TAGS_ALL,
                        _ => {}
                    }
                }
            }
            if t != 0 {
                catches.insert(f, t);
            }
        }
    }
    eprintln!(
        "catch clauses: {} handlers, {} cleanups, {} terminate pads, {} unknown ({})",
        clause_stats[0],
        clause_stats[1],
        clause_stats[2],
        clause_stats[3],
        if precise_catchers { "precise" } else { "coarse" }
    );
    // Functions that have a catching frame at or above them on some fork
    // stack: propagate from every catcher down fork-path call edges.
    let mut below_catcher: HashMap<u32, Tags> = HashMap::new();
    {
        let mut q: VecDeque<u32> = VecDeque::new();
        for (&f, &t) in &catches {
            if r2.contains(&f) {
                below_catcher.insert(f, t);
                q.push_back(f);
            }
        }
        while let Some(g) = q.pop_front() {
            let t = below_catcher[&g];
            for (_, _, ts) in sites.get(&g).map(|v| v.as_slice()).unwrap_or(&[]) {
                for &h in ts {
                    let e = below_catcher.entry(h).or_insert(0);
                    if *e | t != *e {
                        *e |= t;
                        q.push_back(h);
                    }
                }
            }
        }
    }
    // child[g]: what control returns to g's caller in the child.
    #[derive(Clone, Copy, PartialEq)]
    struct Child {
        ret: Option<V>,
        thr: Tags,
    }
    let dead = Child { ret: None, thr: 0 };
    let mut child: HashMap<u32, Child> = HashMap::new();
    child.insert(seed_i, Child { ret: Some(V::C(0)), thr: 0 });
    if p.dyn_link {
        // A side module's own fork: its child returns anything and may throw.
        child.insert(ext_i, Child { ret: Some(V::Top), thr: TAGS_ALL });
    }
    // Side-module dispatch (dyn_link): unknown child behaviour.
    // (seed_i stands for it; it returns 0 in the child like the import.)
    // Reverse map: callee -> functions with a site targeting it.
    let mut rdeps: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&f, v) in &sites {
        for (_, _, t) in v {
            for &g in t {
                rdeps.entry(g).or_default().push(f);
            }
        }
    }
    for v in rdeps.values_mut() {
        v.sort();
        v.dedup();
    }
    let catcher_above = |g: u32, thr: Tags| -> bool {
        rdeps.get(&g).map_or(false, |v| v.iter().any(|h| below_catcher.get(h).map_or(false, |t| t & thr != 0)))
    };
    let mut why: HashMap<u32, Vec<String>> = HashMap::new();
    let mut work: VecDeque<u32> = VecDeque::new();
    let mut queued: HashSet<u32> = HashSet::new();
    for root in [seed_i, ext_i] {
        for &f in rdeps.get(&root).map(|v| v.as_slice()).unwrap_or(&[]) {
            if queued.insert(f) {
                work.push_back(f);
            }
        }
    }
    let mut cevals = 0usize;
    let snapshot = summ.clone();
    while let Some(f) = work.pop_front() {
        queued.remove(&f);
        cevals += 1;
        let mut inject = HashMap::new();
        for (sid, ix, t) in &sites[&f] {
            let mut j = Inject { ret: None, thr: 0, top: None };
            for g in t {
                if let Some(c) = child.get(g) {
                    if c.ret.is_none() && (exc_runtime || (exc_equiv && (c.thr == 0 || !catcher_above(*g, c.thr)))) {
                        continue; // closed: escapes stop at its run-time check
                    }
                    if let Some(v) = c.ret {
                        j.ret = Some(j.ret.map_or(v, |r| joinv(r, v)));
                    }
                    j.thr |= c.thr;
                }
            }
            if j.ret.is_some() || j.thr != 0 {
                inject.insert((*sid, *ix), j);
            }
        }
        if inject.is_empty() {
            continue;
        }
        let info = infos[f as usize].as_ref().unwrap();
        let mut cx = Ctx { p: &p, summ: &snapshot, ptarg: &mut ptarg, exn_seen: &mut exn_seen, frame_esc: &mut frame_esc, allow_spec: true, spec: &mut spec_memo, depth: 0 };
        let r = interpret(&mut cx, f, info, Mode::Child, &inject, None);
        let mut c = Child { ret: r.ret, thr: r.thr };
        if r.unsupported {
            c = Child { ret: Some(V::Top), thr: TAGS_ALL };
        }
        let old = *child.get(&f).unwrap_or(&dead);
        let new = Child {
            ret: match (old.ret, c.ret) {
                (None, x) | (x, None) => x,
                (Some(a), Some(b)) => Some(joinv(a, b)),
            },
            thr: old.thr | c.thr,
        };
        why.insert(f, r.why);
        if new != old || !child.contains_key(&f) {
            child.insert(f, new);
            if new != old {
                for &g in rdeps.get(&f).map(|v| v.as_slice()).unwrap_or(&[]) {
                    if queued.insert(g) {
                        work.push_back(g);
                    }
                }
            }
        }
    }
    eprintln!("child fixpoint: {} evaluations in {:.1}s", cevals, t1.elapsed().as_secs_f32());

    // ---- 3. instrumented set under sinks
    let open = |g: u32| {
        child.get(&g).map_or(false, |c| {
            c.ret.is_some() || (c.thr != 0 && !exc_runtime && !(exc_equiv && !catcher_above(g, c.thr)))
        })
    };
    let mut s_set: Vec<u32> = child.keys().copied().filter(|&f| f != seed_i && f != ext_i).collect();
    // A gate must catch the private unwind tag to abort: instrument it when
    // any handler-signature function is on the path.
    let handler_open = (0..n as u32).any(|g| p.escapes[g as usize] && p.sig_handler_keys.contains(&p.skey[g as usize]) && child.contains_key(&g));
    let mut gates_added = 0;
    if handler_open {
        for &g in &gate_fns {
            if !child.contains_key(&g) {
                s_set.push(g);
                gates_added += 1;
            }
        }
    }
    s_set.sort();
    s_set.dedup();
    let closed: Vec<u32> = s_set.iter().copied().filter(|&f| !open(f)).collect();
    let opens: Vec<u32> = s_set.iter().copied().filter(|&f| open(f)).collect();
    // Roots: open functions that are entered from outside (export/table) or
    // have no on-path caller.
    let roots: Vec<u32> = opens.iter().copied().filter(|&f| p.escapes[f as usize]).collect();

    let label = format!(
        "signal-policy={:?} param={} cancel-cuts={} itargets={} registries={} exc={} main-direct={} dyn_link={}",
        p.sig_policy, p.use_param, p.cut.len(), get("--itargets").unwrap_or_else(|| "-".into()), has("--registries"), exc_mode, !p.main_fns.is_empty(), p.dyn_link
    );
    println!("module\t{wasm}");
    println!("rules\t{label}");
    println!("instrumented_today\t{instrumented_today}");
    println!("closure_same_rules_no_sinks\t{refined_today}");
    println!("instrumented_sink\t{}", s_set.len());
    println!("gates_added\t{gates_added}");
    println!("closed(sink)\t{}", closed.len());
    println!("open\t{}", opens.len());
    println!("open_escaping_roots\t{}", roots.len());
    let mut sink_rows = vec![];
    let (mut eq, mut narrow) = (0, 0);
    for &f in &closed {
        let Some(c) = child.get(&f) else {
            sink_rows.push(format!("GATE\t{}\tsignal dispatch gate (instrumented to abort a handler fork)", p.names[f as usize]));
            continue;
        };
        let thr = c.thr;
        let mut note = String::from("no escape");
        if thr != 0 {
            // A catcher strictly above f: any on-path caller that is itself
            // below (or is) a catcher for these tags.
            let above = catcher_above(f, thr);
            if above {
                narrow += 1;
                note = format!("escape {thr:#x}; a catcher may be above");
            } else {
                eq += 1;
                note = format!("escape {thr:#x}; no catcher above (equivalent)");
            }
        }
        sink_rows.push(format!("SINK\t{}\t{note}", p.names[f as usize]));
    }
    println!("sinks_with_escape_no_catcher\t{eq}\tsinks_with_escape_catcher_above\t{narrow}");
    for r in sink_rows {
        println!("{r}");
    }
    let show_open = get("--show-open").map(|s| s.parse::<usize>().unwrap()).unwrap_or(40);
    // Open functions nearest to fork first: BFS distance from seed.
    let mut dist: HashMap<u32, u32> = HashMap::new();
    let mut q = VecDeque::new();
    dist.insert(seed_i, 0);
    q.push_back(seed_i);
    while let Some(g) = q.pop_front() {
        let d = dist[&g];
        for &f in rdeps.get(&g).map(|v| v.as_slice()).unwrap_or(&[]) {
            if child.contains_key(&f) && !dist.contains_key(&f) {
                dist.insert(f, d + 1);
                if open(f) {
                    q.push_back(f);
                }
            }
        }
    }
    let mut by_d: Vec<(u32, u32)> = opens.iter().map(|&f| (*dist.get(&f).unwrap_or(&999), f)).collect();
    by_d.sort();
    for (d, f) in by_d.iter().take(show_open) {
        let c = child[f];
        println!(
            "OPEN\td={}\t{}\tret={:?}\tthr={:#x}\t{}",
            d,
            p.names[*f as usize],
            c.ret,
            c.thr,
            why.get(f).map(|w| w.join(" | ")).unwrap_or_default()
        );
    }
    if let Some(out) = get("--out-set") {
        let mut fh = std::fs::File::create(&out).unwrap();
        for &f in &s_set {
            writeln!(fh, "{}", p.names[f as usize]).unwrap();
        }
    }
    if let Some(out) = get("--out-today") {
        let mut fh = std::fs::File::create(&out).unwrap();
        let mut v: Vec<u32> = r_set.iter().copied().filter(|&f| !p.import[f as usize]).collect();
        v.sort();
        for f in v {
            writeln!(fh, "{}", p.names[f as usize]).unwrap();
        }
    }
    // ---- oracle
    if let Some(path) = get("--oracle") {
        let text = std::fs::read_to_string(&path).unwrap();
        let mut stacks: Vec<(String, Vec<String>)> = vec![];
        for l in text.lines() {
            if let Some(h) = l.strip_prefix("-- ") {
                stacks.push((h.to_string(), vec![]));
            } else if !l.is_empty() {
                if let Some(s) = stacks.last_mut() {
                    s.1.push(l.to_string());
                }
            }
        }
        let sset: HashSet<&str> = s_set.iter().map(|&f| p.names[f as usize].as_str()).collect();
        let mut by_name: HashMap<&str, Vec<u32>> = HashMap::new();
        for i in 0..n {
            by_name.entry(p.names[i].as_str()).or_default().push(i as u32);
        }
        let mut bad = 0;
        let mut needed_total: BTreeMap<String, usize> = BTreeMap::new();
        for (h, frames) in &stacks {
            let mut needed = vec![];
            let mut boundary = None;
            for fr in frames {
                let ids = by_name.get(fr.as_str()).cloned().unwrap_or_default();
                if ids.is_empty() {
                    continue; // host frames / wrappers not in this module
                }
                needed.push(fr.clone());
                // A frame stops the walk only if every same-named function is closed.
                if ids.iter().all(|&g| child.contains_key(&g) && !open(g)) {
                    boundary = Some(fr.clone());
                    break;
                }
            }
            let missing: Vec<&String> = needed.iter().filter(|x| !sset.contains(x.as_str())).collect();
            if !missing.is_empty() {
                bad += 1;
                println!("ORACLE-UNSOUND\t{h}\tmissing {:?}", missing);
            }
            for x in &needed {
                *needed_total.entry(x.clone()).or_default() += 1;
            }
            println!(
                "ORACLE\t{h}\tframes {}\tneeded {}\tboundary {}",
                frames.len(),
                needed.len(),
                boundary.unwrap_or_else(|| "<none: full stack>".into())
            );
        }
        println!("oracle_stacks\t{}\toracle_unsound\t{}\toracle_distinct_needed\t{}", stacks.len(), bad, needed_total.len());
    }
    // ---- per-site detail for chosen functions
    if let Some(list) = get("--explain") {
        for name in list.split(',') {
            for f in p.by_name(name) {
                let Some(v) = sites.get(&f) else {
                    println!("EXPLAIN\t{name}\tnot on the fork path");
                    continue;
                };
                for (sid, ix, t) in v {
                    let mut j = Inject { ret: None, thr: 0, top: None };
                    for g in t {
                        if let Some(c) = child.get(g) {
                            if c.ret.is_none() && (exc_runtime || (exc_equiv && (c.thr == 0 || !catcher_above(*g, c.thr)))) {
                                continue;
                            }
                            if let Some(x) = c.ret {
                                j.ret = Some(j.ret.map_or(x, |r| joinv(r, x)));
                            }
                            j.thr |= c.thr;
                        }
                    }
                    let tn: Vec<&str> = t.iter().take(4).map(|&g| if g == ext_i { "<side module>" } else { p.names[g as usize].as_str() }).collect();
                    if j.ret.is_none() && j.thr == 0 {
                        println!("EXPLAIN\t{name}\tsite {:?}/{}\tcallee never returns in child\t{:?}", sid, ix, tn);
                        continue;
                    }
                    let mut inj = HashMap::new();
                    inj.insert((*sid, *ix), j);
                    let info = infos[f as usize].as_ref().unwrap();
                    let mut cx = Ctx { p: &p, summ: &snapshot, ptarg: &mut ptarg, exn_seen: &mut exn_seen, frame_esc: &mut frame_esc, allow_spec: true, spec: &mut spec_memo, depth: 0 };
                    let r = interpret(&mut cx, f, info, Mode::Child, &inj, None);
                    let verdict = if r.ret.is_none() && r.thr == 0 && !r.unsupported { "SINK" } else { "OPEN" };
                    println!(
                        "EXPLAIN\t{name}\tsite {:?}/{}\tin(ret={:?},thr={:#x})\t{verdict}\tret={:?} thr={:#x}\t{}\tcallees {:?}{}",
                        sid,
                        ix,
                        j.ret,
                        j.thr,
                        r.ret,
                        r.thr,
                        r.why.join(" | "),
                        tn,
                        if t.len() > 4 { format!(" +{}", t.len() - 4) } else { String::new() }
                    );
                }
            }
        }
    }
    // Tag legend.
    for (t, b) in &p.tag_bit {
        let tag = p.m.tags.get(*t);
        let name = match tag.kind {
            TagKind::Import(i) => {
                let im = p.m.imports.get(i);
                format!("{}.{}", im.module, im.name)
            }
            TagKind::Local => tag.name.clone().unwrap_or_default(),
        };
        println!("TAG\tbit {b}\t{name}");
    }
}
