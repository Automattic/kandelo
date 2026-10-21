//! Checkpoint coverage: instrument only the frames a checkpoint unwinds.
//!
//! A machine checkpoint waits until every thread of every process sits at a
//! syscall return, then unwinds each stack into linear memory. The
//! `kernel_checkpoint` seed reaches almost every function of a large program,
//! because every function that can make a syscall can be live at a syscall
//! return. Instrumenting that closure undoes what fork sinks save.
//!
//! A checkpoint does not need every syscall return, only the ones a thread
//! idles at. This pass selects the functions on the call paths from a thread's
//! entry to the blocking calls where it waits (the park functions), and from
//! there down to the `kernel_checkpoint` call. A run-time check makes the
//! selection sound: libc takes a checkpoint only from a stack whose every frame
//! is selected, and any other syscall return leaves the request pending for
//! the thread's next syscall completion. A thread that idles on an unselected
//! path therefore never unwinds, and the freeze reports that it timed out.
//!
//! ## Selection
//!
//! The call graph has the direct calls, the indirect calls the compiler facts
//! resolve to at most [`MAX_FAN_OUT`] targets (same-signature table members
//! without facts), every indirect call in a thread root, which picks the
//! thread's body (`QThread::run` overrides, for one), and musl's start code
//! calling `main`. Calls into a signal
//! handler are not edges: a handler runs inside the syscall that delivered the
//! signal, not on a thread's idle path. Functions that end only in process or
//! thread exit are removed, because a checkpoint does not capture a thread on
//! its way out. Then, from each root (`_start`, musl's thread entries `start`
//! and `start_c11`, and every `pthread_create` start routine the facts name):
//!
//! - the entry segment follows calls outside wait loops, to depth
//!   [`ENTRY_DEPTH`], through functions that can reach a park function. A
//!   wait loop is a loop with a call that can reach a park function;
//! - the descent follows each call inside a wait loop of the entry segment
//!   to a park function, along paths at most [`DESCENT_SLACK`] calls longer
//!   than the shortest one.
//!
//! Condition waits count as park functions only below a thread root: a main
//! thread that waits on a condition variable is waiting on a lock, not idling.
//!
//! ## The run-time check
//!
//! A token passes coverage from a covered caller to its covered callee:
//!
//! - a covered function reads the token at entry into its `cover` local and
//!   clears it;
//! - before a call whose callee is covered, a covered caller writes its own
//!   `cover` into the token; an indirect call writes it only when the table
//!   slot holds a covered function;
//! - an uncovered frame writes nothing, so a covered callee below it reads 0;
//! - an uncovered `_start` or thread entry clears the token at entry, so the
//!   token the host wrote for it never reaches a covered callee further down.
//!
//! Every call to the `kernel.kernel_checkpoint_covered` import becomes the
//! calling frame's `cover`. The host writes 1 into the exported token before
//! it enters `_start` or a thread's entry, which covers the bottom frame. A rewound frame restores its `cover` with its other locals.
//!
//! The constants were measured on fbDOOM, dash, nginx, redis, cpython and
//! Quickshell: an interpreter idles behind a dispatch through more than
//! [`MAX_FAN_OUT`] targets, and stays uncovered.

use std::collections::{HashMap, HashSet, VecDeque};

use anyhow::{Result, ensure};
use walrus::ir::*;
use walrus::*;

use wasm_posix_shared::abi::{WPK_CHECKPOINT_COVER_EXPORT, WPK_CHECKPOINT_COVERED_PROCESS_IMPORT};

use crate::facts;

const COVERED_IMPORT_MODULE: &str = WPK_CHECKPOINT_COVERED_PROCESS_IMPORT.module;
const COVERED_IMPORT_NAME: &str = WPK_CHECKPOINT_COVERED_PROCESS_IMPORT.name;

/// Indirect calls with more targets than this are not followed.
pub const MAX_FAN_OUT: usize = 8;
/// Calls the entry segment follows from a root.
pub const ENTRY_DEPTH: u32 = 8;
/// Extra calls a descent may take beyond the shortest path to a park function.
pub const DESCENT_SLACK: u32 = 1;

/// Blocking calls a thread idles in.
const PARK_FUNCTIONS: &[&str] = &[
    "poll",
    "ppoll",
    "select",
    "pselect",
    "epoll_wait",
    "epoll_pwait",
    "nanosleep",
    "clock_nanosleep",
    "__clock_nanosleep",
    "read",
    "readv",
    "recv",
    "recvfrom",
    "recvmsg",
    "accept",
    "accept4",
    "wait4",
    "waitpid",
    "waitid",
    "sigsuspend",
    "sigtimedwait",
    "pause",
];

/// Condition waits, park functions below a thread root only.
const THREAD_PARK_FUNCTIONS: &[&str] = &["__pthread_cond_timedwait"];

/// musl's start code calls `main` through the pointer `_start` passes to
/// `__libc_start_main`, an indirect call with every `(i32, i32) -> i32` table
/// function as a target. The CRT contract names the one it calls.
const CRT_STARTS: &[&str] = &["__libc_start_main", "libc_start_main_stage2"];

/// musl's thread entries, the functions the host calls for a new thread.
/// Without facts their names are all that finds them, as for the CRT starts.
const THREAD_ENTRIES: &[&str] = &["start", "start_c11"];
const CRT_MAINS: &[&str] = &["main", "__main_argc_argv", "__original_main", "__main_void"];

/// musl's thread exit runs the cleanup handlers in a loop, and a handler can
/// park, so the analysis takes the loop for a wait. A thread in it is on its
/// way out.
const EXIT_FUNCTIONS: &[&str] = &["__pthread_exit"];

const LONGJMP: &str = "__wasm_longjmp";

/// What a function's paths can end in: `RETURNS` back to its caller,
/// `WAITS` in an endless loop that can park, or only `EXITS`.
const RETURNS: u8 = 0;
const WAITS: u8 = 1;
const EXITS: u8 = 2;

struct Site {
    targets: Vec<usize>,
    loops: Vec<usize>,
}

struct Graph {
    sites: Vec<Vec<Site>>,
    callers: Vec<Vec<usize>>,
}

fn signature_key(module: &Module, ty: TypeId) -> String {
    let name = |t: &ValType| match t {
        ValType::I32 => "i32",
        ValType::I64 => "i64",
        ValType::F32 => "f32",
        ValType::F64 => "f64",
        ValType::V128 => "v128",
        _ => "ref",
    };
    let ty = module.types.get(ty);
    let params: Vec<&str> = ty.params().iter().map(name).collect();
    let results: Vec<&str> = ty.results().iter().map(name).collect();
    format!("{}->{}", params.join(","), results.join(","))
}

fn exact(module: &Module, ty: TypeId) -> (Vec<ValType>, Vec<ValType>) {
    let ty = module.types.get(ty);
    (ty.params().to_vec(), ty.results().to_vec())
}

fn sequences(local: &LocalFunction) -> Vec<InstrSeqId> {
    let mut found = vec![local.entry_block()];
    let mut next = 0;
    while next < found.len() {
        let seq = found[next];
        next += 1;
        for (instr, _) in &local.block(seq).instrs {
            match instr {
                Instr::Block(Block { seq }) | Instr::Loop(Loop { seq }) => found.push(*seq),
                Instr::IfElse(IfElse { consequent, alternative }) => {
                    found.push(*consequent);
                    found.push(*alternative);
                }
                Instr::TryTable(TryTable { seq, .. }) => found.push(*seq),
                Instr::Try(Try { seq, catches }) => {
                    found.push(*seq);
                    for catch in catches {
                        if let LegacyCatch::Catch { handler, .. } | LegacyCatch::CatchAll { handler } = catch {
                            found.push(*handler);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    found
}

/// Function slots of each table, from active segments at constant offsets.
fn table_slots(module: &Module) -> HashMap<TableId, Vec<(u32, FunctionId)>> {
    let mut slots: HashMap<TableId, Vec<(u32, FunctionId)>> = HashMap::new();
    for element in module.elements.iter() {
        let ElementKind::Active { table, offset } = &element.kind else { continue };
        let ConstExpr::Value(Value::I32(base)) = offset else { continue };
        let functions: Vec<Option<FunctionId>> = match &element.items {
            ElementItems::Functions(functions) => functions.iter().copied().map(Some).collect(),
            ElementItems::Expressions(_, expressions) => expressions
                .iter()
                .map(|expression| match expression {
                    ConstExpr::RefFunc(function) => Some(*function),
                    _ => None,
                })
                .collect(),
        };
        for (index, function) in functions.into_iter().enumerate() {
            let Some(function) = function else { continue };
            slots.entry(*table).or_default().push((*base as u32 + index as u32, function));
        }
    }
    slots
}

/// Does `seq` catch the tag `__wasm_longjmp` throws? Such a loop is a setjmp
/// re-entry point, not a loop the program waits in.
fn catches_longjmp(local: &LocalFunction, seq: InstrSeqId, longjmp: &[TagId]) -> bool {
    for (instr, _) in &local.block(seq).instrs {
        let found = match instr {
            Instr::TryTable(TryTable { seq, catches }) => {
                catches.iter().any(|catch| {
                    matches!(catch, TryTableCatch::Catch { tag, .. } | TryTableCatch::CatchRef { tag, .. }
                        if longjmp.contains(tag))
                }) || catches_longjmp(local, *seq, longjmp)
            }
            Instr::Block(Block { seq }) => catches_longjmp(local, *seq, longjmp),
            Instr::IfElse(IfElse { consequent, alternative }) => {
                catches_longjmp(local, *consequent, longjmp) || catches_longjmp(local, *alternative, longjmp)
            }
            _ => false,
        };
        if found {
            return true;
        }
    }
    false
}

enum Callee {
    Direct(FunctionId),
    Indirect(TypeId, TableId),
}

fn walk(
    local: &LocalFunction,
    seq: InstrSeqId,
    longjmp: &[TagId],
    stack: &mut Vec<usize>,
    loops: &mut usize,
    out: &mut Vec<(Callee, Vec<usize>)>,
) {
    for (instr, _) in &local.block(seq).instrs {
        match instr {
            Instr::Call(Call { func }) | Instr::ReturnCall(ReturnCall { func }) => {
                out.push((Callee::Direct(*func), stack.clone()))
            }
            Instr::CallIndirect(CallIndirect { ty, table })
            | Instr::ReturnCallIndirect(ReturnCallIndirect { ty, table }) => {
                out.push((Callee::Indirect(*ty, *table), stack.clone()))
            }
            Instr::Block(Block { seq }) | Instr::TryTable(TryTable { seq, .. }) => {
                walk(local, *seq, longjmp, stack, loops, out)
            }
            Instr::Loop(Loop { seq }) if catches_longjmp(local, *seq, longjmp) => {
                walk(local, *seq, longjmp, stack, loops, out)
            }
            Instr::Loop(Loop { seq }) => {
                stack.push(*loops);
                *loops += 1;
                walk(local, *seq, longjmp, stack, loops, out);
                stack.pop();
            }
            Instr::IfElse(IfElse { consequent, alternative }) => {
                walk(local, *consequent, longjmp, stack, loops, out);
                walk(local, *alternative, longjmp, stack, loops, out);
            }
            Instr::Try(Try { seq, catches }) => {
                walk(local, *seq, longjmp, stack, loops, out);
                for catch in catches {
                    if let LegacyCatch::Catch { handler, .. } | LegacyCatch::CatchAll { handler } = catch {
                        walk(local, *handler, longjmp, stack, loops, out);
                    }
                }
            }
            _ => {}
        }
    }
}

fn graph(
    module: &Module,
    names: &Names,
    itargets: &HashMap<(usize, String), Vec<usize>>,
    handlers: &HashSet<usize>,
    thread_roots: &HashSet<usize>,
) -> Graph {
    let n = names.count;
    let mut members: HashMap<(TableId, (Vec<ValType>, Vec<ValType>)), Vec<usize>> = HashMap::new();
    for (table, entries) in table_slots(module) {
        for (_, function) in entries {
            let key = (table, exact(module, module.funcs.get(function).ty()));
            members.entry(key).or_default().push(function.index());
        }
    }
    let longjmp: Vec<TagId> = names
        .lookup(LONGJMP)
        .and_then(|function| match &module.funcs.get(names.ids[function]).kind {
            FunctionKind::Local(local) => {
                let mut tags = vec![];
                for seq in sequences(local) {
                    for (instr, _) in &local.block(seq).instrs {
                        if let Instr::Throw(Throw { tag }) = instr {
                            tags.push(*tag);
                        }
                    }
                }
                Some(tags)
            }
            _ => None,
        })
        .unwrap_or_default();
    let mains: Vec<usize> = CRT_MAINS.iter().filter_map(|name| names.lookup(name)).collect();
    let mut sites: Vec<Vec<Site>> = (0..n).map(|_| vec![]).collect();
    for function in module.funcs.iter() {
        let FunctionKind::Local(local) = &function.kind else { continue };
        let index = function.id().index();
        let mut raw = vec![];
        walk(local, local.entry_block(), &longjmp, &mut vec![], &mut 0, &mut raw);
        for (callee, loops) in raw {
            let targets = match callee {
                Callee::Direct(target) => vec![target.index()],
                Callee::Indirect(ty, table) => {
                    let wanted = exact(module, ty);
                    let found: Vec<usize> = match itargets.get(&(index, signature_key(module, ty))) {
                        Some(found) => found
                            .iter()
                            .copied()
                            .filter(|target| exact(module, module.funcs.get(names.ids[*target]).ty()) == wanted)
                            .collect(),
                        None => members.get(&(table, wanted)).cloned().unwrap_or_default(),
                    };
                    let found: Vec<usize> = found.into_iter().filter(|target| !handlers.contains(target)).collect();
                    if found.len() > MAX_FAN_OUT && !thread_roots.contains(&index) { vec![] } else { found }
                }
            };
            sites[index].push(Site { targets, loops });
        }
        if function.name.as_deref().is_some_and(|name| CRT_STARTS.contains(&name)) {
            sites[index].push(Site { targets: mains.clone(), loops: vec![] });
        }
    }
    let mut callers: Vec<Vec<usize>> = vec![vec![]; n];
    for (caller, list) in sites.iter().enumerate() {
        for site in list {
            for target in &site.targets {
                callers[*target].push(caller);
            }
        }
    }
    for list in callers.iter_mut() {
        list.sort_unstable();
        list.dedup();
    }
    Graph { sites, callers }
}

struct Names {
    count: usize,
    ids: Vec<FunctionId>,
    by_name: HashMap<String, usize>,
    names: Vec<String>,
}

impl Names {
    fn new(module: &Module) -> Self {
        let count = module.funcs.iter().map(|function| function.id().index() + 1).max().unwrap_or(0);
        let mut ids = vec![module.funcs.iter().next().map(|f| f.id()); count];
        let mut names = vec![String::new(); count];
        let mut by_name = HashMap::new();
        for function in module.funcs.iter() {
            let index = function.id().index();
            ids[index] = Some(function.id());
            if let Some(name) = &function.name {
                names[index] = name.clone();
                by_name.entry(name.clone()).or_insert(index);
            }
        }
        Names { count, ids: ids.into_iter().map(|id| id.unwrap()).collect(), by_name, names }
    }

    /// A function by its exact name, or by a C++ name without its parameter
    /// list when exactly one function has that name.
    fn lookup(&self, name: &str) -> Option<usize> {
        if let Some(index) = self.by_name.get(name) {
            return Some(*index);
        }
        let prefix = format!("{name}(");
        let mut found = self.names.iter().enumerate().filter(|(_, candidate)| candidate.starts_with(&prefix));
        let first = found.next()?;
        found.next().is_none().then_some(first.0)
    }
}

/// Does `seq` hold a call that can reach a park function? Any indirect call
/// counts.
fn can_park(local: &LocalFunction, seq: InstrSeqId, reaches: &[bool]) -> bool {
    struct Calls<'a> {
        reaches: &'a [bool],
        parks: bool,
    }
    impl<'instr> ir::Visitor<'instr> for Calls<'_> {
        fn visit_call(&mut self, instr: &Call) {
            self.parks |= self.reaches[instr.func.index()];
        }
        fn visit_return_call(&mut self, instr: &ReturnCall) {
            self.parks |= self.reaches[instr.func.index()];
        }
        fn visit_call_indirect(&mut self, _: &CallIndirect) {
            self.parks = true;
        }
        fn visit_return_call_indirect(&mut self, _: &ReturnCallIndirect) {
            self.parks = true;
        }
        fn visit_call_ref(&mut self, _: &CallRef) {
            self.parks = true;
        }
        fn visit_return_call_ref(&mut self, _: &ReturnCallRef) {
            self.parks = true;
        }
    }
    let mut calls = Calls { reaches, parks: false };
    ir::dfs_in_order(&mut calls, local, seq);
    calls.parks
}

/// Can control leave `seq` at its end? Lowers `best` to the best outcome a
/// path reached (a return, or an endless loop that can park) and records the
/// sequences a branch targets.
fn falls_through(
    local: &LocalFunction,
    seq: InstrSeqId,
    outcome: &[u8],
    reaches: &[bool],
    targets: &mut HashSet<InstrSeqId>,
    best: &mut u8,
) -> bool {
    let mut previous_call: Option<u8> = None;
    for (instr, _) in &local.block(seq).instrs {
        let this_call = match instr {
            Instr::Call(Call { func }) => Some(outcome[func.index()]),
            _ => None,
        };
        match instr {
            Instr::Unreachable(_) => {
                if previous_call == Some(WAITS) {
                    *best = (*best).min(WAITS);
                }
                return false;
            }
            Instr::Throw(_) | Instr::Rethrow(_) | Instr::ThrowRef(_) => {
                *best = RETURNS;
                return false;
            }
            Instr::Return(_) | Instr::ReturnCallIndirect(_) | Instr::ReturnCallRef(_) => {
                *best = RETURNS;
                return false;
            }
            Instr::ReturnCall(ReturnCall { func }) => {
                *best = (*best).min(outcome[func.index()]);
                return false;
            }
            Instr::Call(Call { func }) if outcome[func.index()] != RETURNS => {
                *best = (*best).min(outcome[func.index()]);
                return false;
            }
            Instr::Br(Br { block }) => {
                targets.insert(*block);
                return false;
            }
            Instr::BrIf(BrIf { block })
            | Instr::BrOnNull(BrOnNull { block })
            | Instr::BrOnNonNull(BrOnNonNull { block }) => {
                targets.insert(*block);
            }
            Instr::BrTable(BrTable { blocks, default }) => {
                targets.extend(blocks.iter().copied());
                targets.insert(*default);
                return false;
            }
            Instr::Block(Block { seq }) => {
                let through = falls_through(local, *seq, outcome, reaches, targets, best);
                if !through && !targets.contains(seq) {
                    return false;
                }
            }
            Instr::Loop(Loop { seq }) => {
                if !falls_through(local, *seq, outcome, reaches, targets, best) {
                    if can_park(local, *seq, reaches) {
                        *best = (*best).min(WAITS);
                    }
                    return false;
                }
            }
            Instr::IfElse(IfElse { consequent, alternative }) => {
                let then = falls_through(local, *consequent, outcome, reaches, targets, best);
                let otherwise = falls_through(local, *alternative, outcome, reaches, targets, best);
                if !then && !otherwise && !targets.contains(consequent) && !targets.contains(alternative) {
                    return false;
                }
            }
            Instr::Try(Try { seq, catches }) => {
                falls_through(local, *seq, outcome, reaches, targets, best);
                for catch in catches {
                    if let LegacyCatch::Catch { handler, .. } | LegacyCatch::CatchAll { handler } = catch {
                        falls_through(local, *handler, outcome, reaches, targets, best);
                    }
                }
            }
            Instr::TryTable(TryTable { seq, catches }) => {
                falls_through(local, *seq, outcome, reaches, targets, best);
                for catch in catches {
                    let (TryTableCatch::Catch { label, .. }
                    | TryTableCatch::CatchRef { label, .. }
                    | TryTableCatch::CatchAll { label }
                    | TryTableCatch::CatchAllRef { label }) = catch;
                    targets.insert(*label);
                }
            }
            _ => {}
        }
        previous_call = this_call;
    }
    true
}

/// The functions whose every path ends in process or thread exit, as a
/// greatest fixpoint: assume every local function exits, then keep only the
/// ones no path of which returns or waits. Entry points (exports, the CRT
/// start functions, `main`, thread roots) stay in the graph; they also end in
/// `exit`, but every covered stack starts at one.
fn exit_only(module: &Module, names: &Names, graph: &Graph, park: &[usize], entries: &HashSet<usize>) -> Vec<bool> {
    let n = names.count;
    let is_park: HashSet<usize> = park.iter().copied().collect();
    let mut outcome: Vec<u8> = (0..n)
        .map(|index| {
            let local = matches!(module.funcs.get(names.ids[index]).kind, FunctionKind::Local(_));
            if local && !is_park.contains(&index) { EXITS } else { RETURNS }
        })
        .collect();
    loop {
        let mut reaches = vec![false; n];
        let mut queue: VecDeque<usize> = park.iter().copied().collect();
        for index in &queue {
            reaches[*index] = true;
        }
        while let Some(function) = queue.pop_front() {
            for caller in &graph.callers[function] {
                if !reaches[*caller] && outcome[*caller] != EXITS {
                    reaches[*caller] = true;
                    queue.push_back(*caller);
                }
            }
        }
        let mut changed = false;
        for function in module.funcs.iter() {
            let FunctionKind::Local(local) = &function.kind else { continue };
            let index = function.id().index();
            if is_park.contains(&index) {
                continue;
            }
            if function.name.as_deref().is_some_and(|name| EXIT_FUNCTIONS.contains(&name)) {
                continue;
            }
            let mut targets = HashSet::new();
            let mut best = EXITS;
            let entry = local.entry_block();
            if falls_through(local, entry, &outcome, &reaches, &mut targets, &mut best) || targets.contains(&entry) {
                best = RETURNS;
            }
            if best != outcome[index] {
                outcome[index] = best;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    (0..n).map(|index| outcome[index] == EXITS && !entries.contains(&index)).collect()
}

/// The entry segment and the descent from `roots` to `park`.
fn select(graph: &Graph, pruned: &[bool], park: &[usize], roots: &[usize], n: usize) -> Vec<bool> {
    let mut distance = vec![u32::MAX; n];
    let mut queue: VecDeque<usize> = VecDeque::new();
    for function in park {
        distance[*function] = 0;
        queue.push_back(*function);
    }
    while let Some(function) = queue.pop_front() {
        for caller in &graph.callers[function] {
            if distance[*caller] == u32::MAX && !pruned[*caller] {
                distance[*caller] = distance[function] + 1;
                queue.push_back(*caller);
            }
        }
    }
    let reaches = |function: usize| distance[function] != u32::MAX;
    let looped: Vec<Vec<bool>> = graph
        .sites
        .iter()
        .map(|sites| {
            let waiting: HashSet<usize> = sites
                .iter()
                .filter(|site| site.targets.iter().any(|target| reaches(*target)))
                .flat_map(|site| site.loops.iter().copied())
                .collect();
            sites.iter().map(|site| site.loops.iter().any(|id| waiting.contains(id))).collect()
        })
        .collect();

    let mut entry = vec![false; n];
    let mut depth = vec![0u32; n];
    let mut queue: VecDeque<usize> = VecDeque::new();
    for root in roots {
        if reaches(*root) && !entry[*root] {
            entry[*root] = true;
            queue.push_back(*root);
        }
    }
    while let Some(function) = queue.pop_front() {
        if depth[function] >= ENTRY_DEPTH {
            continue;
        }
        for (index, site) in graph.sites[function].iter().enumerate() {
            if looped[function][index] {
                continue;
            }
            for target in &site.targets {
                if reaches(*target) && !entry[*target] {
                    entry[*target] = true;
                    depth[*target] = depth[function] + 1;
                    queue.push_back(*target);
                }
            }
        }
    }

    let mut selected = entry.clone();
    let mut budget = vec![i64::MIN; n];
    let mut queue: VecDeque<(usize, u32)> = VecDeque::new();
    for function in (0..n).filter(|function| entry[*function]) {
        for (index, site) in graph.sites[function].iter().enumerate() {
            if !looped[function][index] {
                continue;
            }
            let Some(shortest) = site.targets.iter().filter(|t| reaches(**t)).map(|t| distance[*t]).min() else {
                continue;
            };
            let allowed = shortest + DESCENT_SLACK;
            for target in &site.targets {
                if reaches(*target) && distance[*target] <= allowed && budget[*target] < allowed as i64 {
                    budget[*target] = allowed as i64;
                    queue.push_back((*target, allowed));
                }
            }
        }
    }
    while let Some((function, allowed)) = queue.pop_front() {
        selected[function] = true;
        if allowed == 0 {
            continue;
        }
        for site in &graph.sites[function] {
            for target in &site.targets {
                let next = allowed - 1;
                if reaches(*target) && distance[*target] <= next && budget[*target] < next as i64 {
                    budget[*target] = next as i64;
                    queue.push_back((*target, next));
                }
            }
        }
    }
    selected
}

/// The covered functions. `facts` resolves indirect calls and names the
/// thread start routines and signal handlers; without them, indirect calls
/// resolve by table signature and the roots are `_start` and musl's thread
/// entries.
pub fn plan(module: &Module, checkpoints: &[FunctionId], facts: Option<&facts::TakenFacts>) -> HashSet<FunctionId> {
    let names = Names::new(module);
    let n = names.count;
    let mut itargets: HashMap<(usize, String), Vec<usize>> = HashMap::new();
    let mut thread_roots: Vec<usize> = vec![];
    let mut handlers: HashSet<usize> = HashSet::new();
    if let Some(taken) = facts {
        if let Ok((call_facts, _)) = facts::call_facts(module, &taken.section, Default::default()) {
            for (function, signature, targets) in call_facts.itargets {
                itargets.insert(
                    (function as usize, signature),
                    targets.into_iter().map(|target| target as usize).collect(),
                );
            }
        }
        for (registry, function) in facts::registrations(&taken.section).unwrap_or_default() {
            let Some(index) = names.lookup(&function) else { continue };
            match registry.as_str() {
                "thread" => thread_roots.push(index),
                "signal" => {
                    handlers.insert(index);
                }
                _ => {}
            }
        }
        // The host enters a new thread at musl's hub, not at its start routine.
        let hubs = facts::hubs(module, &taken.section, "thread").unwrap_or_default();
        thread_roots.extend(hubs.into_iter().map(|function| function as usize));
    } else {
        thread_roots.extend(THREAD_ENTRIES.iter().filter_map(|name| names.lookup(name)));
    }
    thread_roots.sort_unstable();
    thread_roots.dedup();
    let graph = graph(module, &names, &itargets, &handlers, &thread_roots.iter().copied().collect());
    let local = |index: usize| matches!(module.funcs.get(names.ids[index]).kind, FunctionKind::Local(_));
    let parks = |list: &[&str]| -> Vec<usize> {
        list.iter().filter_map(|name| names.by_name.get(*name).copied()).filter(|index| local(*index)).collect()
    };
    let park = parks(PARK_FUNCTIONS);
    let thread_park = parks(THREAD_PARK_FUNCTIONS);

    let mut entries: HashSet<usize> = module
        .exports
        .iter()
        .filter_map(|export| match export.item {
            ExportItem::Function(function) => Some(function.index()),
            _ => None,
        })
        .collect();
    entries.extend(CRT_STARTS.iter().chain(CRT_MAINS).filter_map(|name| names.lookup(name)));
    entries.extend(thread_roots.iter().copied());
    let pruned = exit_only(module, &names, &graph, &park, &entries);

    let start: Vec<usize> = module
        .exports
        .iter()
        .filter(|export| export.name == "_start")
        .filter_map(|export| match export.item {
            ExportItem::Function(function) => Some(function.index()),
            _ => None,
        })
        .collect();
    let roots: Vec<usize> = start.iter().chain(&thread_roots).copied().collect();
    let mut selected = select(&graph, &pruned, &park, &roots, n);
    if !thread_park.is_empty() {
        let threads = select(&graph, &pruned, &thread_park, &thread_roots, n);
        for index in 0..n {
            selected[index] |= threads[index];
        }
    }

    // Below every park function, the frames down to the `kernel_checkpoint`
    // call: the syscall wrapper and the libc glue that takes the request.
    let mut reaches_checkpoint = vec![false; n];
    let mut queue: VecDeque<usize> = checkpoints.iter().map(|function| function.index()).collect();
    for index in &queue {
        reaches_checkpoint[*index] = true;
    }
    while let Some(function) = queue.pop_front() {
        for caller in &graph.callers[function] {
            if !reaches_checkpoint[*caller] && !pruned[*caller] {
                reaches_checkpoint[*caller] = true;
                queue.push_back(*caller);
            }
        }
    }
    let mut below = vec![false; n];
    let mut queue: VecDeque<usize> = park.iter().chain(&thread_park).copied().collect();
    for index in &queue {
        below[*index] = true;
    }
    while let Some(function) = queue.pop_front() {
        for site in &graph.sites[function] {
            for target in &site.targets {
                if reaches_checkpoint[*target] && !below[*target] {
                    below[*target] = true;
                    queue.push_back(*target);
                }
            }
        }
    }

    (0..n)
        .filter(|index| (selected[*index] || below[*index]) && local(*index))
        .map(|index| names.ids[index])
        .collect()
}

/// Answer every `kernel_checkpoint_covered()` with 1, for a module whose whole
/// checkpoint closure is instrumented.
pub fn cover_every_stack(module: &mut Module) {
    let Some(covered_import) = module.imports.iter().find_map(|import| match import.kind {
        ImportKind::Function(function)
            if import.module == COVERED_IMPORT_MODULE && import.name == COVERED_IMPORT_NAME =>
        {
            Some(function)
        }
        _ => None,
    }) else {
        return;
    };
    let ids: Vec<FunctionId> = module.funcs.iter().map(|function| function.id()).collect();
    for id in ids {
        let FunctionKind::Local(local) = &mut module.funcs.get_mut(id).kind else { continue };
        for seq in sequences(local) {
            for (instr, _) in local.block_mut(seq).instrs.iter_mut() {
                if matches!(instr, Instr::Call(Call { func }) if *func == covered_import) {
                    *instr = Instr::Const(Const { value: Value::I32(1) });
                }
            }
        }
    }
}

/// A function `(slot: i32) -> i32` that answers whether `slot` holds a
/// covered function.
fn slot_test(module: &mut Module, covered_slots: &[u32]) -> FunctionId {
    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[ValType::I32]);
    let slot = module.locals.add(ValType::I32);
    let mut body = builder.func_body();
    body.i32_const(0);
    for covered in covered_slots {
        body.local_get(slot).i32_const(*covered as i32).binop(BinaryOp::I32Eq).binop(BinaryOp::I32Or);
    }
    let function = builder.finish(vec![slot], &mut module.funcs);
    module.funcs.get_mut(function).name = Some("__wpk_checkpoint_cover_slot".into());
    function
}

/// Add the token, the per-frame `cover` locals, the call-site writes, and the
/// `kernel_checkpoint_covered()` answers.
pub fn inject(module: &mut Module, covered: &HashSet<FunctionId>) -> Result<()> {
    let covered_import = module.imports.iter().find_map(|import| match import.kind {
        ImportKind::Function(function)
            if import.module == COVERED_IMPORT_MODULE && import.name == COVERED_IMPORT_NAME =>
        {
            Some(function)
        }
        _ => None,
    });
    let token = module.globals.add_local(ValType::I32, true, false, ConstExpr::Value(Value::I32(0)));
    module.exports.add(WPK_CHECKPOINT_COVER_EXPORT, token);

    let mut slot_tests: HashMap<TableId, FunctionId> = HashMap::new();
    for (table, entries) in table_slots(module) {
        ensure!(!module.tables.get(table).table64, "checkpoint coverage models 32-bit tables only");
        let mut covered_slots: Vec<u32> =
            entries.iter().filter(|(_, function)| covered.contains(function)).map(|(slot, _)| *slot).collect();
        covered_slots.sort_unstable();
        covered_slots.dedup();
        if covered_slots.is_empty() {
            continue;
        }
        slot_tests.insert(table, slot_test(module, &covered_slots));
    }

    let host_entries: HashSet<FunctionId> = module
        .exports
        .iter()
        .filter(|export| export.name == "_start")
        .filter_map(|export| match export.item {
            ExportItem::Function(function) => Some(function),
            _ => None,
        })
        .chain(
            module
                .funcs
                .iter()
                .filter(|function| function.name.as_deref().is_some_and(|name| THREAD_ENTRIES.contains(&name)))
                .map(|function| function.id()),
        )
        .collect();

    let mut ids: Vec<FunctionId> = module.funcs.iter().map(|function| function.id()).collect();
    ids.sort();
    for id in ids {
        let (cover, slot) = if covered.contains(&id) {
            (Some(module.locals.add(ValType::I32)), Some(module.locals.add(ValType::I32)))
        } else {
            (None, None)
        };
        let FunctionKind::Local(local) = &mut module.funcs.get_mut(id).kind else { continue };
        for seq in sequences(local) {
            let old = std::mem::take(&mut local.block_mut(seq).instrs);
            let mut new = Vec::with_capacity(old.len());
            for (instr, at) in old {
                match (&instr, cover) {
                    (Instr::Call(Call { func }), _) if Some(*func) == covered_import => {
                        new.push((
                            match cover {
                                Some(cover) => Instr::LocalGet(LocalGet { local: cover }),
                                None => Instr::Const(Const { value: Value::I32(0) }),
                            },
                            at,
                        ));
                        continue;
                    }
                    (Instr::Call(Call { func }) | Instr::ReturnCall(ReturnCall { func }), Some(cover))
                        if covered.contains(func) =>
                    {
                        new.push((Instr::LocalGet(LocalGet { local: cover }), at));
                        new.push((Instr::GlobalSet(GlobalSet { global: token }), at));
                    }
                    (
                        Instr::CallIndirect(CallIndirect { table, .. })
                        | Instr::ReturnCallIndirect(ReturnCallIndirect { table, .. }),
                        Some(cover),
                    ) if slot_tests.contains_key(table) => {
                        let slot = slot.unwrap();
                        new.push((Instr::LocalSet(LocalSet { local: slot }), at));
                        new.push((Instr::LocalGet(LocalGet { local: slot }), at));
                        new.push((Instr::Call(Call { func: slot_tests[table] }), at));
                        new.push((Instr::LocalGet(LocalGet { local: cover }), at));
                        new.push((Instr::Binop(Binop { op: BinaryOp::I32And }), at));
                        new.push((Instr::GlobalSet(GlobalSet { global: token }), at));
                        new.push((Instr::LocalGet(LocalGet { local: slot }), at));
                    }
                    _ => {}
                }
                new.push((instr, at));
            }
            local.block_mut(seq).instrs = new;
        }
        let read = match cover {
            Some(cover) => vec![Instr::GlobalGet(GlobalGet { global: token }), Instr::LocalSet(LocalSet { local: cover })],
            None if host_entries.contains(&id) => vec![],
            None => continue,
        };
        let entry = local.entry_block();
        let at = local.block(entry).instrs.first().map(|(_, at)| *at).unwrap_or_default();
        let prologue = read.into_iter().chain([
            Instr::Const(Const { value: Value::I32(0) }),
            Instr::GlobalSet(GlobalSet { global: token }),
        ]);
        let instrs = &mut local.block_mut(entry).instrs;
        for (index, instr) in prologue.into_iter().enumerate() {
            instrs.insert(index, (instr, at));
        }
    }
    Ok(())
}
