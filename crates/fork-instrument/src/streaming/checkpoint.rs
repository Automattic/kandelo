//! Checkpoint coverage: instrument only the frames a checkpoint unwinds.
//!
//! A machine checkpoint waits until every thread of every process sits at a
//! syscall return, then unwinds each stack into linear memory. The
//! `kernel_checkpoint` seed reaches almost every function of a large program,
//! because every function that can make a syscall can be live at a syscall
//! return. Instrumenting that closure undoes what fork sinks save.
//!
//! A checkpoint does not need every syscall return, only the ones a thread
//! idles at. [`select`] chooses the functions on the call paths from a
//! thread's entry to the blocking calls where it waits (the park functions),
//! and from there down to the `kernel_checkpoint` call. [`cover`] makes the
//! selection sound at run time: libc takes a checkpoint only from a stack
//! whose every frame is selected, and any other syscall return leaves the
//! request pending for the thread's next syscall completion. A thread that
//! idles on an unselected path therefore never unwinds, and the freeze
//! reports that it timed out.
//!
//! ## Selection
//!
//! The call graph has the direct calls, the indirect calls the compiler
//! facts resolve to at most [`MAX_FAN_OUT`] targets (same-signature table
//! members without facts), every indirect call in a thread root, which picks
//! the thread's body (`QThread::run` overrides, for one), and musl's start
//! code calling `main`. Calls into a signal handler are not edges: a handler
//! runs inside the syscall that delivered the signal, not on a thread's idle
//! path. Functions that end only in process or thread exit are removed,
//! because a checkpoint does not capture a thread on its way out. Then, from
//! each root (`_start`, musl's thread entries `start` and `start_c11`, and
//! every `pthread_create` start routine the facts name):
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
//! The constants were measured on fbDOOM, dash, nginx, redis, cpython and
//! Quickshell: an interpreter idles behind a dispatch through more than
//! [`MAX_FAN_OUT`] targets, and stays uncovered.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use anyhow::{Context, Result, ensure};
use wasmparser::{Catch, Operator, Parser, Payload};

use super::Scan;
use crate::facts::storage::FactsStore;

mod cover;
pub use cover::cover;

/// The process import a frame asks before libc takes a checkpoint.
pub const COVERED_IMPORT: (&str, &str) = (
    wasm_posix_program_abi::abi::WPK_CHECKPOINT_COVERED_PROCESS_IMPORT.module,
    wasm_posix_program_abi::abi::WPK_CHECKPOINT_COVERED_PROCESS_IMPORT.name,
);
/// The exported global a covered caller passes its coverage through.
pub const COVER_EXPORT: &str = wasm_posix_program_abi::abi::WPK_CHECKPOINT_COVER_EXPORT;

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
const CRT_MAINS: &[&str] = &["main", "__main_argc_argv", "__original_main", "__main_void"];

/// musl's thread entries, the functions the host calls for a new thread.
/// Without facts their names are all that finds them, as for the CRT starts.
const THREAD_ENTRIES: &[&str] = &["start", "start_c11"];

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

/// How the instrumented module answers `kernel_checkpoint_covered`.
#[derive(Debug, PartialEq, Eq)]
pub enum Cover {
    /// The whole checkpoint closure is instrumented. The import stays, and
    /// the host answers 1.
    Every,
    /// Only these functions are covered; see [`cover`].
    Frames(BTreeSet<u32>),
}

/// One function body's calls and structured control. Other operators
/// collapse into one [`Node::Other`] per run; sequence 0 is the body.
struct Body {
    sequences: Vec<Vec<Node>>,
}

enum Node {
    Call(u32),
    TailCall(u32),
    Indirect { ty: u32, table: u32, tail: bool },
    Reference { tail: bool },
    Other,
    Unreachable,
    Throw(Option<u32>),
    Return,
    Br(u32),
    BrIf(u32),
    BrTable(Box<[u32]>),
    Block(u32),
    Loop(u32),
    If(u32, u32),
    Try(u32, Box<[u32]>),
    TryTable(u32, Box<[(Option<u32>, u32)]>),
}

enum Frame {
    Block(u32),
    Loop(u32),
    If { then: u32, otherwise: Option<u32> },
    Try { body: u32, handlers: Vec<u32> },
}

impl Frame {
    fn label(&self) -> u32 {
        match *self {
            Frame::Block(sequence) | Frame::Loop(sequence) => sequence,
            Frame::If { then, .. } => then,
            Frame::Try { body, .. } => body,
        }
    }
}

fn decode(body: &wasmparser::FunctionBody<'_>, nodes: &mut usize) -> Result<Body> {
    let mut sequences: Vec<Vec<Node>> = vec![vec![]];
    let mut frames: Vec<Frame> = vec![];
    let mut current = vec![0u32];
    let label = |frames: &[Frame], depth: u32| -> u32 {
        frames
            .len()
            .checked_sub(depth as usize + 1)
            .map_or(0, |frame| frames[frame].label())
    };
    let mut reader = body.get_operators_reader()?;
    while !reader.eof() {
        let operator = reader.read()?;
        let node = match operator {
            Operator::Call { function_index } => Node::Call(function_index),
            Operator::ReturnCall { function_index } => Node::TailCall(function_index),
            Operator::CallIndirect {
                type_index,
                table_index,
            }
            | Operator::ReturnCallIndirect {
                type_index,
                table_index,
            } => Node::Indirect {
                ty: type_index,
                table: table_index,
                tail: matches!(operator, Operator::ReturnCallIndirect { .. }),
            },
            Operator::CallRef { .. } => Node::Reference { tail: false },
            Operator::ReturnCallRef { .. } => Node::Reference { tail: true },
            Operator::Unreachable => Node::Unreachable,
            Operator::Throw { tag_index } => Node::Throw(Some(tag_index)),
            Operator::Rethrow { .. } | Operator::ThrowRef => Node::Throw(None),
            Operator::Return => Node::Return,
            Operator::Br { relative_depth } => Node::Br(label(&frames, relative_depth)),
            Operator::BrIf { relative_depth }
            | Operator::BrOnNull { relative_depth }
            | Operator::BrOnNonNull { relative_depth }
            | Operator::BrOnCast { relative_depth, .. }
            | Operator::BrOnCastFail { relative_depth, .. } => {
                Node::BrIf(label(&frames, relative_depth))
            }
            Operator::BrTable { targets } => {
                let mut labels = vec![label(&frames, targets.default())];
                for target in targets.targets() {
                    labels.push(label(&frames, target?));
                }
                Node::BrTable(labels.into())
            }
            Operator::Block { .. }
            | Operator::Loop { .. }
            | Operator::If { .. }
            | Operator::Try { .. }
            | Operator::TryTable { .. } => {
                let sequence = u32::try_from(sequences.len())?;
                sequences.push(vec![]);
                let (frame, node) = match operator {
                    Operator::Block { .. } => (Frame::Block(sequence), Node::Block(sequence)),
                    Operator::Loop { .. } => (Frame::Loop(sequence), Node::Loop(sequence)),
                    Operator::If { .. } => (
                        Frame::If {
                            then: sequence,
                            otherwise: None,
                        },
                        Node::Other,
                    ),
                    Operator::Try { .. } => (
                        Frame::Try {
                            body: sequence,
                            handlers: vec![],
                        },
                        Node::Other,
                    ),
                    Operator::TryTable { try_table } => {
                        let catches = try_table
                            .catches
                            .iter()
                            .map(|catch| match *catch {
                                Catch::One { tag, label: depth }
                                | Catch::OneRef { tag, label: depth } => {
                                    (Some(tag), label(&frames, depth))
                                }
                                Catch::All { label: depth } | Catch::AllRef { label: depth } => {
                                    (None, label(&frames, depth))
                                }
                            })
                            .collect();
                        (Frame::Block(sequence), Node::TryTable(sequence, catches))
                    }
                    _ => unreachable!(),
                };
                if !matches!(frame, Frame::If { .. } | Frame::Try { .. }) {
                    push(&mut sequences, *current.last().unwrap(), node, nodes)?;
                }
                frames.push(frame);
                current.push(sequence);
                continue;
            }
            Operator::Else => {
                let sequence = u32::try_from(sequences.len())?;
                sequences.push(vec![]);
                if let Some(Frame::If { otherwise, .. }) = frames.last_mut() {
                    *otherwise = Some(sequence);
                }
                *current.last_mut().unwrap() = sequence;
                continue;
            }
            Operator::Catch { .. } | Operator::CatchAll => {
                let sequence = u32::try_from(sequences.len())?;
                sequences.push(vec![]);
                if let Some(Frame::Try { handlers, .. }) = frames.last_mut() {
                    handlers.push(sequence);
                }
                *current.last_mut().unwrap() = sequence;
                continue;
            }
            Operator::End | Operator::Delegate { .. } => {
                current.pop();
                let Some(frame) = frames.pop() else {
                    continue;
                };
                let node = match frame {
                    Frame::If { then, otherwise } => {
                        let otherwise = match otherwise {
                            Some(otherwise) => otherwise,
                            None => {
                                sequences.push(vec![]);
                                u32::try_from(sequences.len() - 1)?
                            }
                        };
                        Node::If(then, otherwise)
                    }
                    Frame::Try { body, handlers } => Node::Try(body, handlers.into()),
                    Frame::Block(_) | Frame::Loop(_) => continue,
                };
                push(&mut sequences, *current.last().unwrap(), node, nodes)?;
                continue;
            }
            _ => Node::Other,
        };
        push(&mut sequences, *current.last().unwrap(), node, nodes)?;
    }
    Ok(Body { sequences })
}

fn push(sequences: &mut [Vec<Node>], sequence: u32, node: Node, nodes: &mut usize) -> Result<()> {
    let nodes_in = &mut sequences[sequence as usize];
    if matches!(node, Node::Other) && matches!(nodes_in.last(), Some(Node::Other)) {
        return Ok(());
    }
    *nodes = nodes
        .checked_sub(1)
        .context("checkpoint coverage exceeds its node budget")?;
    nodes_in.push(node);
    Ok(())
}

struct Site {
    targets: Vec<u32>,
    loops: Vec<u32>,
}

struct Graph {
    sites: Vec<Vec<Site>>,
    callers: Vec<Vec<u32>>,
}

struct Names<'s> {
    by_name: HashMap<&'s str, u32>,
    names: Vec<Option<&'s str>>,
}

impl<'s> Names<'s> {
    fn new(scan: &'s Scan<'_>) -> Self {
        let names: Vec<_> = scan.functions.iter().map(|f| f.name.as_deref()).collect();
        let mut by_name = HashMap::new();
        for (index, name) in names.iter().enumerate() {
            if let Some(name) = name {
                by_name.entry(*name).or_insert(index as u32);
            }
        }
        Names { by_name, names }
    }

    /// A function by its exact name, or by a C++ name without its parameter
    /// list when exactly one function has that name.
    fn lookup(&self, name: &str) -> Option<u32> {
        if let Some(&index) = self.by_name.get(name) {
            return Some(index);
        }
        let prefix = format!("{name}(");
        let mut found = self
            .names
            .iter()
            .enumerate()
            .filter(|(_, candidate)| candidate.is_some_and(|c| c.starts_with(&prefix)));
        let first = found.next()?;
        found.next().is_none().then_some(first.0 as u32)
    }
}

/// Function slots of each table, from active segments at constant offsets.
pub(super) fn table_slots(scan: &Scan<'_>) -> Vec<(u32, u32, u32)> {
    let mut slots = Vec::new();
    for element in &scan.elements {
        let Some((table, Some(base))) = element.active else {
            continue;
        };
        for (index, item) in element.items.iter().enumerate() {
            if let super::ValueProof::Function(function) = *item {
                slots.push((table, (base as u32).wrapping_add(index as u32), function));
            }
        }
    }
    slots
}

fn same_type(scan: &Scan<'_>, a: u32, b: u32) -> bool {
    let types = scan.types.as_ref();
    let signature = |ty: u32| {
        types
            .get(types.core_type_at_in_module(ty))
            .unwrap()
            .composite_type
            .unwrap_func()
            .clone()
    };
    signature(a) == signature(b)
}

fn facts_signature(scan: &Scan<'_>, ty: u32) -> String {
    let types = scan.types.as_ref();
    let function = types
        .get(types.core_type_at_in_module(ty))
        .unwrap()
        .composite_type
        .unwrap_func();
    let name = |value: &wasmparser::ValType| match value {
        wasmparser::ValType::I32 => "i32",
        wasmparser::ValType::I64 => "i64",
        wasmparser::ValType::F32 => "f32",
        wasmparser::ValType::F64 => "f64",
        wasmparser::ValType::V128 => "v128",
        _ => "ref",
    };
    let list =
        |values: &[wasmparser::ValType]| values.iter().map(name).collect::<Vec<_>>().join(",");
    format!("{}->{}", list(function.params()), list(function.results()))
}

/// Does `sequence` catch the tag `__wasm_longjmp` throws? Such a loop is a
/// setjmp re-entry point, not a loop the program waits in.
fn catches_longjmp(body: &Body, sequence: u32, longjmp: &[u32]) -> bool {
    body.sequences[sequence as usize]
        .iter()
        .any(|node| match node {
            Node::TryTable(inner, catches) => {
                catches
                    .iter()
                    .any(|(tag, _)| tag.is_some_and(|tag| longjmp.contains(&tag)))
                    || catches_longjmp(body, *inner, longjmp)
            }
            Node::Block(inner) => catches_longjmp(body, *inner, longjmp),
            Node::If(then, otherwise) => {
                catches_longjmp(body, *then, longjmp) || catches_longjmp(body, *otherwise, longjmp)
            }
            _ => false,
        })
}

enum Callee {
    Direct(u32),
    Indirect(u32, u32),
}

fn walk(
    body: &Body,
    sequence: u32,
    longjmp: &[u32],
    stack: &mut Vec<u32>,
    loops: &mut u32,
    out: &mut Vec<(Callee, Vec<u32>)>,
) {
    for node in &body.sequences[sequence as usize] {
        match node {
            Node::Call(function) | Node::TailCall(function) => {
                out.push((Callee::Direct(*function), stack.clone()))
            }
            Node::Indirect { ty, table, .. } => {
                out.push((Callee::Indirect(*ty, *table), stack.clone()))
            }
            Node::Block(inner) | Node::TryTable(inner, _) => {
                walk(body, *inner, longjmp, stack, loops, out)
            }
            Node::Loop(inner) if catches_longjmp(body, *inner, longjmp) => {
                walk(body, *inner, longjmp, stack, loops, out)
            }
            Node::Loop(inner) => {
                stack.push(*loops);
                *loops += 1;
                walk(body, *inner, longjmp, stack, loops, out);
                stack.pop();
            }
            Node::If(then, otherwise) => {
                walk(body, *then, longjmp, stack, loops, out);
                walk(body, *otherwise, longjmp, stack, loops, out);
            }
            Node::Try(inner, handlers) => {
                walk(body, *inner, longjmp, stack, loops, out);
                for handler in handlers.iter() {
                    walk(body, *handler, longjmp, stack, loops, out);
                }
            }
            _ => {}
        }
    }
}

struct Program<'s, 'a> {
    scan: &'s Scan<'a>,
    names: Names<'s>,
    bodies: Vec<Option<Body>>,
}

impl Program<'_, '_> {
    fn local(&self, function: u32) -> bool {
        self.bodies[function as usize].is_some()
    }

    fn graph(
        &self,
        facts: Option<&FactsStore>,
        handlers: &HashSet<u32>,
        thread_roots: &HashSet<u32>,
    ) -> Result<Graph> {
        let scan = self.scan;
        let n = scan.functions.len();
        let mut members: HashMap<u32, Vec<u32>> = HashMap::new();
        for (table, _, function) in table_slots(scan) {
            members.entry(table).or_default().push(function);
        }
        let longjmp: Vec<u32> = self
            .names
            .lookup(LONGJMP)
            .and_then(|function| self.bodies[function as usize].as_ref())
            .map(|body| {
                body.sequences
                    .iter()
                    .flatten()
                    .filter_map(|node| match node {
                        Node::Throw(tag) => *tag,
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mains: Vec<u32> = CRT_MAINS
            .iter()
            .filter_map(|name| self.names.lookup(name))
            .collect();
        let mut resolved: HashMap<(u32, u32), Option<Vec<u32>>> = HashMap::new();
        let mut sites: Vec<Vec<Site>> = (0..n).map(|_| vec![]).collect();
        for (index, body) in self.bodies.iter().enumerate() {
            let Some(body) = body else {
                continue;
            };
            let caller = index as u32;
            let mut raw = vec![];
            walk(body, 0, &longjmp, &mut vec![], &mut 0, &mut raw);
            for (callee, loops) in raw {
                let targets = match callee {
                    Callee::Direct(target) => vec![target],
                    Callee::Indirect(ty, table) => {
                        let found = match facts {
                            Some(store) => match resolved.get(&(caller, ty)) {
                                Some(found) => found.clone(),
                                None => {
                                    let found =
                                        store.targets_for(caller, &facts_signature(scan, ty))?;
                                    resolved.insert((caller, ty), found.clone());
                                    found
                                }
                            },
                            None => None,
                        };
                        let found: Vec<u32> = found
                            .unwrap_or_else(|| members.get(&table).cloned().unwrap_or_default())
                            .into_iter()
                            .filter(|&target| {
                                same_type(scan, scan.functions[target as usize].ty, ty)
                                    && !handlers.contains(&target)
                            })
                            .collect();
                        if found.len() > MAX_FAN_OUT && !thread_roots.contains(&caller) {
                            vec![]
                        } else {
                            found
                        }
                    }
                };
                sites[index].push(Site { targets, loops });
            }
            if scan.functions[index]
                .name
                .as_deref()
                .is_some_and(|name| CRT_STARTS.contains(&name))
            {
                sites[index].push(Site {
                    targets: mains.clone(),
                    loops: vec![],
                });
            }
        }
        let mut callers: Vec<Vec<u32>> = vec![vec![]; n];
        for (caller, list) in sites.iter().enumerate() {
            for site in list {
                for &target in &site.targets {
                    callers[target as usize].push(caller as u32);
                }
            }
        }
        for list in &mut callers {
            list.sort_unstable();
            list.dedup();
        }
        Ok(Graph { sites, callers })
    }
}

/// Does `sequence` hold a call that can reach a park function? Any indirect
/// call counts.
fn can_park(body: &Body, sequence: u32, reaches: &[bool]) -> bool {
    body.sequences[sequence as usize]
        .iter()
        .any(|node| match node {
            Node::Call(function) | Node::TailCall(function) => reaches[*function as usize],
            Node::Indirect { .. } | Node::Reference { .. } => true,
            Node::Block(inner) | Node::Loop(inner) | Node::TryTable(inner, _) => {
                can_park(body, *inner, reaches)
            }
            Node::If(then, otherwise) => {
                can_park(body, *then, reaches) || can_park(body, *otherwise, reaches)
            }
            Node::Try(inner, handlers) => {
                can_park(body, *inner, reaches)
                    || handlers
                        .iter()
                        .any(|handler| can_park(body, *handler, reaches))
            }
            _ => false,
        })
}

/// Can control leave `sequence` at its end? Lowers `best` to the best outcome
/// a path reached (a return, or an endless loop that can park) and records
/// the sequences a branch targets.
fn falls_through(
    body: &Body,
    sequence: u32,
    outcome: &[u8],
    reaches: &[bool],
    targets: &mut HashSet<u32>,
    best: &mut u8,
) -> bool {
    let mut previous_call: Option<u8> = None;
    for node in &body.sequences[sequence as usize] {
        let this_call = match node {
            Node::Call(function) => Some(outcome[*function as usize]),
            _ => None,
        };
        match node {
            Node::Unreachable => {
                if previous_call == Some(WAITS) {
                    *best = (*best).min(WAITS);
                }
                return false;
            }
            Node::Throw(_)
            | Node::Return
            | Node::Indirect { tail: true, .. }
            | Node::Reference { tail: true } => {
                *best = RETURNS;
                return false;
            }
            Node::TailCall(function) => {
                *best = (*best).min(outcome[*function as usize]);
                return false;
            }
            Node::Call(function) if outcome[*function as usize] != RETURNS => {
                *best = (*best).min(outcome[*function as usize]);
                return false;
            }
            Node::Br(label) => {
                targets.insert(*label);
                return false;
            }
            Node::BrIf(label) => {
                targets.insert(*label);
            }
            Node::BrTable(labels) => {
                targets.extend(labels.iter().copied());
                return false;
            }
            Node::Block(inner) => {
                let through = falls_through(body, *inner, outcome, reaches, targets, best);
                if !through && !targets.contains(inner) {
                    return false;
                }
            }
            Node::Loop(inner) => {
                if !falls_through(body, *inner, outcome, reaches, targets, best) {
                    if can_park(body, *inner, reaches) {
                        *best = (*best).min(WAITS);
                    }
                    return false;
                }
            }
            Node::If(then, otherwise) => {
                let then_through = falls_through(body, *then, outcome, reaches, targets, best);
                let otherwise_through =
                    falls_through(body, *otherwise, outcome, reaches, targets, best);
                if !then_through
                    && !otherwise_through
                    && !targets.contains(then)
                    && !targets.contains(otherwise)
                {
                    return false;
                }
            }
            Node::Try(inner, handlers) => {
                falls_through(body, *inner, outcome, reaches, targets, best);
                for handler in handlers.iter() {
                    falls_through(body, *handler, outcome, reaches, targets, best);
                }
            }
            Node::TryTable(inner, catches) => {
                falls_through(body, *inner, outcome, reaches, targets, best);
                targets.extend(catches.iter().map(|(_, label)| *label));
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
fn exit_only(
    program: &Program<'_, '_>,
    graph: &Graph,
    park: &[u32],
    entries: &HashSet<u32>,
) -> Vec<bool> {
    let n = program.bodies.len();
    let is_park: HashSet<u32> = park.iter().copied().collect();
    let mut outcome: Vec<u8> = (0..n as u32)
        .map(|index| {
            if program.local(index) && !is_park.contains(&index) {
                EXITS
            } else {
                RETURNS
            }
        })
        .collect();
    loop {
        let mut reaches = vec![false; n];
        let mut queue: VecDeque<u32> = park.iter().copied().collect();
        for &index in &queue {
            reaches[index as usize] = true;
        }
        while let Some(function) = queue.pop_front() {
            for &caller in &graph.callers[function as usize] {
                if !reaches[caller as usize] && outcome[caller as usize] != EXITS {
                    reaches[caller as usize] = true;
                    queue.push_back(caller);
                }
            }
        }
        let mut changed = false;
        for (index, body) in program.bodies.iter().enumerate() {
            let Some(body) = body else {
                continue;
            };
            if is_park.contains(&(index as u32))
                || program.scan.functions[index]
                    .name
                    .as_deref()
                    .is_some_and(|name| EXIT_FUNCTIONS.contains(&name))
            {
                continue;
            }
            let mut targets = HashSet::new();
            let mut best = EXITS;
            if falls_through(body, 0, &outcome, &reaches, &mut targets, &mut best)
                || targets.contains(&0)
            {
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
    (0..n)
        .map(|index| outcome[index] == EXITS && !entries.contains(&(index as u32)))
        .collect()
}

/// The entry segment and the descent from `roots` to `park`.
fn select_paths(graph: &Graph, pruned: &[bool], park: &[u32], roots: &[u32]) -> Vec<bool> {
    let n = graph.sites.len();
    let mut distance = vec![u32::MAX; n];
    let mut queue: VecDeque<u32> = VecDeque::new();
    for &function in park {
        distance[function as usize] = 0;
        queue.push_back(function);
    }
    while let Some(function) = queue.pop_front() {
        for &caller in &graph.callers[function as usize] {
            if distance[caller as usize] == u32::MAX && !pruned[caller as usize] {
                distance[caller as usize] = distance[function as usize] + 1;
                queue.push_back(caller);
            }
        }
    }
    let reaches = |function: u32| distance[function as usize] != u32::MAX;
    let looped: Vec<Vec<bool>> = graph
        .sites
        .iter()
        .map(|sites| {
            let waiting: HashSet<u32> = sites
                .iter()
                .filter(|site| site.targets.iter().any(|&target| reaches(target)))
                .flat_map(|site| site.loops.iter().copied())
                .collect();
            sites
                .iter()
                .map(|site| site.loops.iter().any(|id| waiting.contains(id)))
                .collect()
        })
        .collect();

    let mut entry = vec![false; n];
    let mut depth = vec![0u32; n];
    let mut queue: VecDeque<u32> = VecDeque::new();
    for &root in roots {
        if reaches(root) && !entry[root as usize] {
            entry[root as usize] = true;
            queue.push_back(root);
        }
    }
    while let Some(function) = queue.pop_front() {
        if depth[function as usize] >= ENTRY_DEPTH {
            continue;
        }
        for (index, site) in graph.sites[function as usize].iter().enumerate() {
            if looped[function as usize][index] {
                continue;
            }
            for &target in &site.targets {
                if reaches(target) && !entry[target as usize] {
                    entry[target as usize] = true;
                    depth[target as usize] = depth[function as usize] + 1;
                    queue.push_back(target);
                }
            }
        }
    }

    let mut selected = entry.clone();
    let mut budget = vec![i64::MIN; n];
    let mut queue: VecDeque<(u32, u32)> = VecDeque::new();
    for function in (0..n).filter(|&function| entry[function]) {
        for (index, site) in graph.sites[function].iter().enumerate() {
            if !looped[function][index] {
                continue;
            }
            let Some(shortest) = site
                .targets
                .iter()
                .filter(|&&target| reaches(target))
                .map(|&target| distance[target as usize])
                .min()
            else {
                continue;
            };
            let allowed = shortest + DESCENT_SLACK;
            for &target in &site.targets {
                if reaches(target)
                    && distance[target as usize] <= allowed
                    && budget[target as usize] < i64::from(allowed)
                {
                    budget[target as usize] = i64::from(allowed);
                    queue.push_back((target, allowed));
                }
            }
        }
    }
    while let Some((function, allowed)) = queue.pop_front() {
        selected[function as usize] = true;
        if allowed == 0 {
            continue;
        }
        let next = allowed - 1;
        for site in &graph.sites[function as usize] {
            for &target in &site.targets {
                if reaches(target)
                    && distance[target as usize] <= next
                    && budget[target as usize] < i64::from(next)
                {
                    budget[target as usize] = i64::from(next);
                    queue.push_back((target, next));
                }
            }
        }
    }
    selected
}

/// The covered functions, or `None` when the module has no name section or
/// its bodies exceed `budget` bytes of call summaries. `facts` resolves
/// indirect calls and names the thread start routines and signal handlers;
/// without them, indirect calls resolve by table signature and the roots are
/// `_start` and musl's thread entries.
pub fn select(
    scan: &Scan<'_>,
    checkpoints: &[u32],
    facts: Option<&FactsStore>,
    budget: usize,
) -> Result<Option<BTreeSet<u32>>> {
    if scan
        .functions
        .iter()
        .all(|function| function.name.is_none())
    {
        return Ok(None);
    }
    let names = Names::new(scan);
    let mut nodes = budget / std::mem::size_of::<Node>().max(1);
    let mut bodies: Vec<Option<Body>> = (0..scan.functions.len()).map(|_| None).collect();
    let mut function = scan.imported_functions as usize;
    for payload in Parser::new(0).parse_all(scan.input()) {
        let Payload::CodeSectionEntry(body) = payload? else {
            continue;
        };
        match decode(&body, &mut nodes) {
            Ok(decoded) => bodies[function] = Some(decoded),
            Err(_) if nodes == 0 => return Ok(None),
            Err(error) => return Err(error),
        }
        function += 1;
    }
    let program = Program {
        scan,
        names,
        bodies,
    };
    let n = scan.functions.len();
    let mut thread_roots: Vec<u32> = vec![];
    let mut handlers: HashSet<u32> = HashSet::new();
    if let Some(store) = facts {
        for function in store.registered("thread")? {
            thread_roots.extend(program.names.lookup(&function));
        }
        for function in store.registered("signal")? {
            handlers.extend(program.names.lookup(&function));
        }
        // The host enters a new thread at musl's hub, not at its start routine.
        thread_roots.extend(store.hubs_of("thread")?);
    } else {
        thread_roots.extend(
            THREAD_ENTRIES
                .iter()
                .filter_map(|name| program.names.lookup(name)),
        );
    }
    thread_roots.sort_unstable();
    thread_roots.dedup();
    let graph = program.graph(facts, &handlers, &thread_roots.iter().copied().collect())?;
    let parks = |list: &[&str]| -> Vec<u32> {
        list.iter()
            .filter_map(|name| program.names.by_name.get(name).copied())
            .filter(|&index| program.local(index))
            .collect()
    };
    let park = parks(PARK_FUNCTIONS);
    let thread_park = parks(THREAD_PARK_FUNCTIONS);

    let exported = |only: Option<&str>| -> Vec<u32> {
        scan.exports
            .iter()
            .filter(|(name, kind, _)| {
                *kind == wasmparser::ExternalKind::Func
                    && only.is_none_or(|wanted| name == wanted)
            })
            .map(|(_, _, index)| *index)
            .collect()
    };
    let mut entries: HashSet<u32> = exported(None).into_iter().collect();
    entries.extend(
        CRT_STARTS
            .iter()
            .chain(CRT_MAINS)
            .filter_map(|name| program.names.lookup(name)),
    );
    entries.extend(thread_roots.iter().copied());
    let pruned = exit_only(&program, &graph, &park, &entries);

    let roots: Vec<u32> = exported(Some("_start"))
        .into_iter()
        .chain(thread_roots.iter().copied())
        .collect();
    let mut selected = select_paths(&graph, &pruned, &park, &roots);
    if !thread_park.is_empty() {
        let threads = select_paths(&graph, &pruned, &thread_park, &thread_roots);
        for index in 0..n {
            selected[index] |= threads[index];
        }
    }

    // Below every park function, the frames down to the `kernel_checkpoint`
    // call: the syscall wrapper and the libc glue that takes the request.
    let mut reaches_checkpoint = vec![false; n];
    let mut queue: VecDeque<u32> = checkpoints.iter().copied().collect();
    for &index in &queue {
        ensure!((index as usize) < n, "checkpoint seed index out of bounds");
        reaches_checkpoint[index as usize] = true;
    }
    while let Some(function) = queue.pop_front() {
        for &caller in &graph.callers[function as usize] {
            if !reaches_checkpoint[caller as usize] && !pruned[caller as usize] {
                reaches_checkpoint[caller as usize] = true;
                queue.push_back(caller);
            }
        }
    }
    let mut below = vec![false; n];
    let mut queue: VecDeque<u32> = park.iter().chain(&thread_park).copied().collect();
    for &index in &queue {
        below[index as usize] = true;
    }
    while let Some(function) = queue.pop_front() {
        for site in &graph.sites[function as usize] {
            for &target in &site.targets {
                if reaches_checkpoint[target as usize] && !below[target as usize] {
                    below[target as usize] = true;
                    queue.push_back(target);
                }
            }
        }
    }

    let mut kept: Vec<bool> = (0..n as u32)
        .map(|index| (selected[index as usize] || below[index as usize]) && program.local(index))
        .collect();
    keep_landings(&program, &mut kept, checkpoints, &reaches_checkpoint);
    Ok(Some(
        (0..n as u32)
            .filter(|&index| kept[index as usize])
            .collect(),
    ))
}

/// Drop every kept function without a call a checkpoint can unwind through:
/// a direct call into a kept function or a seed that reaches the checkpoint,
/// or an indirect call. No covered stack holds such a frame, as below the
/// last function of the entry segment, and the planner has no landing to
/// record it at. Dropping one can leave a caller without a landing.
fn keep_landings(
    program: &Program<'_, '_>,
    kept: &mut [bool],
    checkpoints: &[u32],
    reaches_checkpoint: &[bool],
) {
    let nodes = |function: usize| {
        program.bodies[function]
            .iter()
            .flat_map(|body| body.sequences.iter().flatten())
    };
    let mut callers: HashMap<u32, Vec<u32>> = HashMap::new();
    for function in (0..kept.len()).filter(|&function| kept[function]) {
        for node in nodes(function) {
            if let Node::Call(callee) = node {
                callers.entry(*callee).or_default().push(function as u32);
            }
        }
    }
    let mut queue: VecDeque<usize> = (0..kept.len()).filter(|&function| kept[function]).collect();
    while let Some(function) = queue.pop_front() {
        let lands = nodes(function).any(|node| match *node {
            Node::Call(callee) => {
                reaches_checkpoint[callee as usize]
                    && (kept[callee as usize] || checkpoints.contains(&callee))
            }
            Node::Indirect { tail, .. } | Node::Reference { tail } => !tail,
            _ => false,
        });
        if !kept[function] || lands {
            continue;
        }
        kept[function] = false;
        queue.extend(
            callers
                .get(&(function as u32))
                .into_iter()
                .flatten()
                .map(|&caller| caller as usize),
        );
    }
}

/// Whether instrumenting `instrumented` leaves enough of `closure`
/// uninstrumented to pay for the coverage token, measured in operators.
/// The fork path of bash, vim and php spans 98% or more of the closure, and
/// the token made them grow; fbDOOM, nginx and dash instrument 29% or less.
pub fn pays_off(scan: &Scan<'_>, instrumented: &BTreeSet<u32>, closure: &BTreeSet<u32>) -> bool {
    let size = |functions: &BTreeSet<u32>| -> u64 {
        functions
            .iter()
            .filter_map(|&function| scan.functions[function as usize].body.as_ref())
            .map(|body| body.operators)
            .sum()
    };
    size(instrumented) * 10 < size(closure) * 9
}
