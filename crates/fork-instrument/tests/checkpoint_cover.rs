//! Checkpoint coverage: which frames a checkpoint can unwind, and the token
//! that lets libc take a checkpoint only from a stack made of them.

use std::collections::HashSet;

use fork_instrument::checkpoint_cover::{inject, pays_off, plan};
use walrus::ir::{Instr, Value};
use walrus::{FunctionId, FunctionKind, Module};

const MACHINE: &str = r#"
(module
  (import "kernel" "kernel_checkpoint" (func $kernel_checkpoint))
  (import "kernel" "kernel_checkpoint_covered" (func $kernel_checkpoint_covered (result i32)))
  (memory 1)
  (func $take (if (call $kernel_checkpoint_covered) (then (call $kernel_checkpoint))))
  (func $syscall (call $take))
  (func $poll (call $syscall))
  (func $write (call $syscall))
  (func $log (call $write))
  (func $exit (loop $spin (br $spin)))
  (func $die (call $poll) (call $exit) (unreachable))
  (func $run
    (call $log)
    (loop $events (call $poll) (br $events)))
  (func $main (call $run) (call $die))
  (func $_start (export "_start") (call $main))
  (func $stray (export "stray") (drop (call $kernel_checkpoint_covered))))
"#;

fn module() -> Module {
    Module::from_buffer(&wat::parse_str(MACHINE).expect("wat parse")).expect("parse")
}

fn id(module: &Module, name: &str) -> FunctionId {
    module
        .funcs
        .iter()
        .find(|function| function.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("function {name}"))
        .id()
}

fn names(module: &Module, covered: &HashSet<FunctionId>) -> Vec<String> {
    let mut found: Vec<String> =
        covered.iter().map(|function| module.funcs.get(*function).name.clone().unwrap()).collect();
    found.sort();
    found
}

fn instructions(module: &Module, name: &str) -> Vec<Instr> {
    let FunctionKind::Local(local) = &module.funcs.get(id(module, name)).kind else {
        panic!("{name} is not local");
    };
    let mut found = vec![];
    let mut stack = vec![local.entry_block()];
    while let Some(seq) = stack.pop() {
        for (instr, _) in &local.block(seq).instrs {
            match instr {
                Instr::Block(block) => stack.push(block.seq),
                Instr::Loop(block) => stack.push(block.seq),
                Instr::IfElse(branch) => {
                    stack.push(branch.consequent);
                    stack.push(branch.alternative);
                }
                _ => {}
            }
            found.push(instr.clone());
        }
    }
    found
}

#[test]
fn covers_the_path_from_the_entry_to_the_idle_wait_and_down_to_the_checkpoint() {
    let module = module();
    let covered = plan(&module, &[id(&module, "kernel_checkpoint")], None);
    // `log` and `write` return before the thread idles, and `die` only exits:
    // no idle stack holds them.
    assert_eq!(names(&module, &covered), ["_start", "main", "poll", "run", "syscall", "take"]);
}

#[test]
fn a_covered_frame_passes_its_coverage_and_an_uncovered_frame_answers_no() {
    let mut module = module();
    let covered = plan(&module, &[id(&module, "kernel_checkpoint")], None);
    inject(&mut module, &covered).expect("inject");
    let token = module
        .exports
        .iter()
        .find_map(|export| match export.item {
            walrus::ExportItem::Global(global) if export.name == "__wpk_checkpoint_cover" => Some(global),
            _ => None,
        })
        .expect("token export");

    let run = instructions(&module, "run");
    assert!(matches!(run[0], Instr::GlobalGet(ref get) if get.global == token), "reads the token first");
    let writes = run.iter().filter(|instr| matches!(instr, Instr::GlobalSet(set) if set.global == token)).count();
    // The prologue clears the token, and the call to the covered `poll`
    // passes coverage on; the call to the uncovered `log` passes none.
    assert_eq!(writes, 2);

    let take = instructions(&module, "take");
    assert!(take.iter().any(|instr| matches!(instr, Instr::LocalGet(_))), "answers its own coverage");
    let write = instructions(&module, "write");
    assert!(!write.iter().any(|instr| matches!(instr, Instr::GlobalGet(get) if get.global == token)));

    // A frame outside the selection answers no, whatever its callers did.
    let stray = instructions(&module, "stray");
    assert!(matches!(stray[0], Instr::Const(ref constant) if matches!(constant.value, Value::I32(0))));
    assert!(!stray.iter().any(|instr| matches!(instr, Instr::Call(_))));
}

const CANCELLATION: &str = r#"
(module
  (type $cleanup (func (param i32)))
  (import "kernel" "kernel_checkpoint" (func $kernel_checkpoint))
  (import "kernel" "kernel_checkpoint_covered" (func $kernel_checkpoint_covered (result i32)))
  (memory 1)
  (table 1 funcref)
  (elem (i32.const 0) $handler)
  (func $take (if (call $kernel_checkpoint_covered) (then (call $kernel_checkpoint))))
  (func $syscall (call $take) (if (i32.load (i32.const 0)) (then (call $cancel))))
  (func $cancel (if (i32.load (i32.const 4)) (then (call $__pthread_exit))))
  (func $__pthread_exit
    (block $done
      (loop $handlers
        (br_if $done (i32.eqz (i32.load (i32.const 8))))
        (call_indirect (type $cleanup) (i32.const 0) (i32.const 0))
        (br $handlers)))
    (loop $exit (call $syscall) (br $exit)))
  (func $poll (call $syscall))
  (func $handler (type $cleanup) (call $poll))
  (func $_start (export "_start") (loop $events (call $poll) (br $events))))
"#;

#[test]
fn the_frames_below_an_idle_wait_stop_at_thread_exit() {
    let module = Module::from_buffer(&wat::parse_str(CANCELLATION).expect("wat parse")).expect("parse");
    let covered = plan(&module, &[id(&module, "kernel_checkpoint")], None);
    // A cancellation in `poll`'s syscall exits the thread through a cleanup
    // handler that can park. That thread is on its way out, not idle.
    assert_eq!(names(&module, &covered), ["_start", "poll", "syscall", "take"]);
}

const THREADS: &str = r#"
(module
  (type $routine (func (param i32) (result i32)))
  (import "kernel" "kernel_checkpoint" (func $kernel_checkpoint))
  (import "kernel" "kernel_checkpoint_covered" (func $kernel_checkpoint_covered (result i32)))
  (memory 1)
  (table 2 funcref)
  (elem (i32.const 0) $start $worker)
  (func $take (if (call $kernel_checkpoint_covered) (then (call $kernel_checkpoint))))
  (func $syscall (call $take))
  (func $poll (call $syscall))
  (func $__pthread_exit (loop $spin (br $spin)))
  (func $worker (type $routine) (loop $events (call $poll) (br $events)) (i32.const 0))
  (func $start (type $routine)
    (drop (call_indirect (type $routine) (local.get 0) (i32.const 1)))
    (call $__pthread_exit)
    (unreachable))
  (func $pthread_create (param i32) (result i32) (i32.const 0))
  (func $_start (export "_start")
    (drop (call $pthread_create (i32.const 1)))
    (loop $events (call $poll) (br $events))))
"#;

const THREAD_FACTS: &str = "#kandelo-calltypes\t5
M\tsrc/thread/pthread_create.c
F\tstart\t1\tE\t1\tstart
S\tstart\t0\ti32->i32\ticall\t_ZTSFPvS_E
D\tstart\t1\t1
M\tsrc/worker.c
F\tworker\t1\tE\t0\tworker
T\tworker\t_ZTSFPvS_E
D\tworker\t0\t0
R\tthread\tworker
";

#[test]
fn covers_the_thread_entry_the_host_calls_below_the_start_routine() {
    let module = Module::from_buffer(&wat::parse_str(THREADS).expect("wat parse")).expect("parse");
    let facts = fork_instrument::facts::TakenFacts { section: THREAD_FACTS.as_bytes().to_vec(), code_hash: None };
    let covered = plan(&module, &[id(&module, "kernel_checkpoint")], Some(&facts));
    // The host writes the token and calls musl's `start`, which calls the
    // start routine: an uncovered `start` would hand `worker` a token of 0.
    assert_eq!(names(&module, &covered), ["_start", "poll", "start", "syscall", "take", "worker"]);
}

#[test]
fn finds_the_thread_entry_by_name_without_facts() {
    let module = Module::from_buffer(&wat::parse_str(THREADS).expect("wat parse")).expect("parse");
    let covered = plan(&module, &[id(&module, "kernel_checkpoint")], None);
    // Without facts only musl's name finds `start`, and a thread idling in
    // `worker` would otherwise unwind from a stack missing both frames.
    assert_eq!(names(&module, &covered), ["_start", "poll", "start", "syscall", "take", "worker"]);
}

const IDLE_THREAD: &str = r#"
(module
  (type $routine (func (param i32) (result i32)))
  (import "kernel" "kernel_checkpoint" (func $kernel_checkpoint))
  (import "kernel" "kernel_checkpoint_covered" (func $kernel_checkpoint_covered (result i32)))
  (memory 1)
  (table 1 funcref)
  (elem (i32.const 0) $start)
  (func $take (if (call $kernel_checkpoint_covered) (then (call $kernel_checkpoint))))
  (func $syscall (call $take))
  (func $poll (call $syscall))
  (func $write (call $syscall))
  (func $_start (export "_start") (call $write))
  (func $start (type $routine) (loop $events (call $poll) (br $events)) (i32.const 0)))
"#;

#[test]
fn an_uncovered_entry_clears_the_token_the_host_wrote() {
    let mut module = Module::from_buffer(&wat::parse_str(IDLE_THREAD).expect("wat parse")).expect("parse");
    let covered = plan(&module, &[id(&module, "kernel_checkpoint")], None);
    assert!(!covered.contains(&id(&module, "_start")));
    assert!(covered.contains(&id(&module, "syscall")));
    inject(&mut module, &covered).expect("inject");
    let token = module
        .exports
        .iter()
        .find_map(|export| match export.item {
            walrus::ExportItem::Global(global) if export.name == "__wpk_checkpoint_cover" => Some(global),
            _ => None,
        })
        .expect("token export");

    // `_start` -> `write` -> `syscall` passes through two uncovered frames.
    // Left set, the host's token would cover `syscall` on that stack.
    let start = instructions(&module, "_start");
    assert!(matches!(start[0], Instr::Const(ref constant) if matches!(constant.value, Value::I32(0))));
    assert!(matches!(start[1], Instr::GlobalSet(ref set) if set.global == token));
    let write = instructions(&module, "write");
    assert!(!write.iter().any(|instr| matches!(instr, Instr::GlobalSet(set) if set.global == token)));
}

const THREAD_BODIES: &str = r#"
(module
  (type $body (func))
  (import "kernel" "kernel_checkpoint" (func $kernel_checkpoint))
  (import "kernel" "kernel_checkpoint_covered" (func $kernel_checkpoint_covered (result i32)))
  (memory 1)
  (table 9 funcref)
  (elem (i32.const 0) $body0 $body1 $body2 $body3 $body4 $body5 $body6 $body7 $body8)
  (func $take (if (call $kernel_checkpoint_covered) (then (call $kernel_checkpoint))))
  (func $syscall (call $take))
  (func $poll (call $syscall))
  (func $body0 (type $body) (loop $events (call $poll) (br $events)))
  (func $body1 (type $body) (loop $events (call $poll) (br $events)))
  (func $body2 (type $body) (loop $events (call $poll) (br $events)))
  (func $body3 (type $body) (loop $events (call $poll) (br $events)))
  (func $body4 (type $body) (loop $events (call $poll) (br $events)))
  (func $body5 (type $body) (loop $events (call $poll) (br $events)))
  (func $body6 (type $body) (loop $events (call $poll) (br $events)))
  (func $body7 (type $body) (loop $events (call $poll) (br $events)))
  (func $body8 (type $body) (loop $events (call $poll) (br $events)))
  (func $run_thread (param i32) (result i32)
    (call_indirect (type $body) (i32.load (local.get 0)))
    (i32.const 0))
  (func $_start (export "_start") (loop $events (call $poll) (br $events))))
"#;

#[test]
fn a_thread_root_reaches_every_body_its_dispatch_can_pick() {
    let module = Module::from_buffer(&wat::parse_str(THREAD_BODIES).expect("wat parse")).expect("parse");
    let facts = "#kandelo-calltypes\t5\nR\tthread\trun_thread\n";
    let facts = fork_instrument::facts::TakenFacts { section: facts.as_bytes().to_vec(), code_hash: None };
    let covered = plan(&module, &[id(&module, "kernel_checkpoint")], Some(&facts));
    // Nine bodies is past the fan-out a dispatch elsewhere is followed to; a
    // thread root's dispatch picks the thread's body, so each one is a stack
    // a thread idles on.
    let bodies = names(&module, &covered).into_iter().filter(|name| name.starts_with("body")).count();
    assert_eq!(bodies, 9);
}

const SHARES: &str = r#"
(module
  (import "kernel" "kernel_checkpoint" (func $checkpoint))
  (func $eight (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint))
  (func $nine (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint))
  (func $one (call $checkpoint))
  (func $two (call $checkpoint) (call $checkpoint)))
"#;

#[test]
fn coverage_pays_off_below_nine_tenths_of_the_closure_instructions() {
    let module = Module::from_buffer(&wat::parse_str(SHARES).expect("wat parse")).expect("parse");
    let set = |names: &[&str]| -> HashSet<FunctionId> { names.iter().map(|name| id(&module, name)).collect() };
    assert!(pays_off(&module, &set(&["eight", "checkpoint"]), &set(&["eight", "two", "checkpoint"])));
    assert!(!pays_off(&module, &set(&["nine", "checkpoint"]), &set(&["nine", "one", "checkpoint"])));
}
