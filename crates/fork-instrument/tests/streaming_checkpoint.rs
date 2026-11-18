//! Checkpoint coverage: which frames a checkpoint can unwind, and the token
//! that lets libc take a checkpoint only from a stack made of them.

use std::collections::BTreeSet;

use fork_instrument::facts::{self, FactsOptions, storage::FactsStore};
use fork_instrument::streaming::{Scan, checkpoint, scan};
use walrus::ir::{Instr, Value};
use walrus::{ExportItem, FunctionKind, GlobalId, Module};
use wasm_encoder::{CustomSection, Encode};

const BUDGET: usize = 64 * 1024 * 1024;

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

fn function(scan: &Scan<'_>, name: &str) -> u32 {
    scan.functions
        .iter()
        .position(|function| function.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("function {name}")) as u32
}

fn select(scan: &Scan<'_>, facts: Option<&FactsStore>) -> BTreeSet<u32> {
    checkpoint::select(scan, &[function(scan, "kernel_checkpoint")], facts, BUDGET)
        .expect("select")
        .expect("the module has names")
}

fn names(scan: &Scan<'_>, covered: &BTreeSet<u32>) -> Vec<String> {
    let mut found: Vec<String> = covered
        .iter()
        .map(|&function| scan.functions[function as usize].name.clone().unwrap())
        .collect();
    found.sort();
    found
}

fn covered_names(wat: &str, facts: Option<&str>) -> Vec<String> {
    let bytes = with_facts(wat, facts);
    let scan = scan(&bytes).expect("scan");
    let store = facts.map(|_| {
        let store = FactsStore::from_scan(&scan, Default::default()).expect("facts");
        store
            .resolve_calls(&scan, FactsOptions::default())
            .expect("resolve calls");
        store
    });
    names(&scan, &select(&scan, store.as_ref()))
}

fn with_facts(wat: &str, facts: Option<&str>) -> Vec<u8> {
    let mut bytes = wat::parse_str(wat).expect("wat parse");
    if let Some(text) = facts {
        let hash = facts::code_sha256(&bytes).expect("code hash");
        for (name, data) in [
            (facts::SECTION, text.as_bytes()),
            (facts::CODE_HASH_SECTION, hash.as_slice()),
        ] {
            bytes.push(0);
            CustomSection {
                name: name.into(),
                data: data.into(),
            }
            .encode(&mut bytes);
        }
    }
    bytes
}

fn covered_module(wat: &str) -> (Module, GlobalId) {
    let bytes = wat::parse_str(wat).expect("wat parse");
    let scan = scan(&bytes).expect("scan");
    let covered = select(&scan, None);
    let mut output = Vec::new();
    checkpoint::cover(&scan, &covered, &mut output, Default::default(), BUDGET).expect("cover");
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&output)
        .expect("covered module validates");
    let module = Module::from_buffer(&output).expect("parse");
    let token = module
        .exports
        .iter()
        .find_map(|export| match export.item {
            ExportItem::Global(global) if export.name == checkpoint::COVER_EXPORT => Some(global),
            _ => None,
        })
        .expect("token export");
    (module, token)
}

fn instructions(module: &Module, name: &str) -> Vec<Instr> {
    let function = module
        .funcs
        .iter()
        .find(|function| function.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("function {name}"));
    let FunctionKind::Local(local) = &function.kind else {
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
    // `log` and `write` return before the thread idles, and `die` only exits:
    // no idle stack holds them.
    assert_eq!(
        covered_names(MACHINE, None),
        ["_start", "main", "poll", "run", "syscall", "take"]
    );
}

#[test]
fn a_covered_frame_passes_its_coverage_and_an_uncovered_frame_answers_no() {
    let (module, token) = covered_module(MACHINE);

    let run = instructions(&module, "run");
    assert!(
        matches!(run[0], Instr::GlobalGet(ref get) if get.global == token),
        "reads the token first"
    );
    let writes = run
        .iter()
        .filter(|instr| matches!(instr, Instr::GlobalSet(set) if set.global == token))
        .count();
    // The prologue clears the token, and the call to the covered `poll`
    // passes coverage on; the call to the uncovered `log` passes none.
    assert_eq!(writes, 2);

    let take = instructions(&module, "take");
    assert!(
        take.iter().any(|instr| matches!(instr, Instr::LocalGet(_))),
        "answers its own coverage"
    );
    let write = instructions(&module, "write");
    assert!(
        !write
            .iter()
            .any(|instr| matches!(instr, Instr::GlobalGet(get) if get.global == token))
    );

    // A frame outside the selection answers no, whatever its callers did.
    let stray = instructions(&module, "stray");
    assert!(
        matches!(stray[0], Instr::Const(ref constant) if matches!(constant.value, Value::I32(0)))
    );
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
    // A cancellation in `poll`'s syscall exits the thread through a cleanup
    // handler that can park. That thread is on its way out, not idle.
    assert_eq!(
        covered_names(CANCELLATION, None),
        ["_start", "poll", "syscall", "take"]
    );
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
    // The host writes the token and calls musl's `start`, which calls the
    // start routine: an uncovered `start` would hand `worker` a token of 0.
    assert_eq!(
        covered_names(THREADS, Some(THREAD_FACTS)),
        ["_start", "poll", "start", "syscall", "take", "worker"]
    );
}

#[test]
fn finds_the_thread_entry_by_name_without_facts() {
    // Without facts only musl's name finds `start`, and a thread idling in
    // `worker` would otherwise unwind from a stack missing both frames.
    assert_eq!(
        covered_names(THREADS, None),
        ["_start", "poll", "start", "syscall", "take", "worker"]
    );
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
    let bytes = wat::parse_str(IDLE_THREAD).expect("wat parse");
    let scan = scan(&bytes).expect("scan");
    let covered = select(&scan, None);
    assert!(!covered.contains(&function(&scan, "_start")));
    assert!(covered.contains(&function(&scan, "syscall")));
    let (module, token) = covered_module(IDLE_THREAD);

    // `_start` -> `write` -> `syscall` passes through two uncovered frames.
    // Left set, the host's token would cover `syscall` on that stack.
    let start = instructions(&module, "_start");
    assert!(
        matches!(start[0], Instr::Const(ref constant) if matches!(constant.value, Value::I32(0)))
    );
    assert!(matches!(start[1], Instr::GlobalSet(ref set) if set.global == token));
    let write = instructions(&module, "write");
    assert!(
        !write
            .iter()
            .any(|instr| matches!(instr, Instr::GlobalSet(set) if set.global == token))
    );
}

const COVERED_SLOT: &str = r#"
(module
  (type $body (func))
  (import "kernel" "kernel_checkpoint" (func $kernel_checkpoint))
  (import "kernel" "kernel_checkpoint_covered" (func $kernel_checkpoint_covered (result i32)))
  (memory 1)
  (table 2 funcref)
  (elem (i32.const 0) $quiet $poll)
  (func $take (if (call $kernel_checkpoint_covered) (then (call $kernel_checkpoint))))
  (func $syscall (call $take))
  (func $quiet (type $body))
  (func $poll (type $body) (call $syscall))
  (func $_start (export "_start")
    (loop $events (call_indirect (type $body) (i32.load (i32.const 0))) (br $events))))
"#;

#[test]
fn an_indirect_call_passes_coverage_only_into_a_covered_slot() {
    let (module, token) = covered_module(COVERED_SLOT);
    let start = instructions(&module, "_start");
    let dispatch = start
        .iter()
        .position(|instr| matches!(instr, Instr::CallIndirect(_)))
        .expect("the dispatch stays");
    let Instr::Call(test) = &start[dispatch - 5] else {
        panic!(
            "the slot is tested before the dispatch: {:?}",
            &start[..dispatch]
        );
    };
    assert!(matches!(start[dispatch - 2], Instr::GlobalSet(ref set) if set.global == token));
    // Slot 1 holds the covered `poll`; slot 0 the uncovered `quiet`.
    let slots: Vec<i32> = instructions_of(&module, test.func)
        .iter()
        .filter_map(|instr| match instr {
            Instr::Const(constant) => match constant.value {
                Value::I32(slot) => Some(slot),
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(slots, [0, 1], "the test starts from 0 and compares slot 1");
}

fn instructions_of(module: &Module, function: walrus::FunctionId) -> Vec<Instr> {
    let FunctionKind::Local(local) = &module.funcs.get(function).kind else {
        panic!("the slot test is local");
    };
    local
        .block(local.entry_block())
        .instrs
        .iter()
        .map(|(instr, _)| instr.clone())
        .collect()
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
    // Nine bodies is past the fan-out a dispatch elsewhere is followed to; a
    // thread root's dispatch picks the thread's body, so each one is a stack
    // a thread idles on.
    let covered = covered_names(
        THREAD_BODIES,
        Some("#kandelo-calltypes\t5\nR\tthread\trun_thread\n"),
    );
    let bodies = covered
        .iter()
        .filter(|name| name.starts_with("body"))
        .count();
    assert_eq!(bodies, 9);
}

const SHARES: &str = r#"
(module
  (import "kernel" "kernel_checkpoint" (func $checkpoint))
  (func $seven (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint))
  (func $eight (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint) (call $checkpoint))
  (func $none)
  (func $one (call $checkpoint)))
"#;

#[test]
fn coverage_pays_off_below_nine_tenths_of_the_closure_operators() {
    let bytes = wat::parse_str(SHARES).expect("wat parse");
    let scan = scan(&bytes).expect("scan");
    let set = |names: &[&str]| -> BTreeSet<u32> {
        names.iter().map(|name| function(&scan, name)).collect()
    };
    // Each body ends in `end`: `seven` has 8 operators, `one` 2, `none` 1.
    assert!(checkpoint::pays_off(
        &scan,
        &set(&["seven", "checkpoint"]),
        &set(&["seven", "one", "checkpoint"])
    ));
    assert!(!checkpoint::pays_off(
        &scan,
        &set(&["eight", "checkpoint"]),
        &set(&["eight", "none", "checkpoint"])
    ));
}

#[test]
fn a_covered_tail_call_keeps_its_transport_after_the_rewrite() {
    // The rewrite moves every operator of a covered body. The tail call from
    // `syscall` must still be found at its new offset.
    let input = wat::parse_str(
        r#"
        (module
          (import "kernel" "kernel_checkpoint" (func $kernel_checkpoint))
          (import "kernel" "kernel_checkpoint_covered" (func $kernel_checkpoint_covered (result i32)))
          (memory 1)
          (func $take (if (call $kernel_checkpoint_covered) (then (call $kernel_checkpoint))))
          (func $syscall (return_call $take))
          (func $poll (call $syscall))
          (func $write (call $syscall))
          (func $quiet)
          (func $_start (export "_start")
            (call $write) (call $quiet) (call $quiet) (call $quiet)
            (loop $events (call $poll) (br $events))))
        "#,
    )
    .expect("wat parse");
    let output = fork_instrument::instrument(
        &input,
        &fork_instrument::Options {
            checkpoint_import: Some("kernel.kernel_checkpoint".into()),
            ..Default::default()
        },
    )
    .expect("instrument");
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&output)
        .expect("instrumented module validates");
    assert!(
        Module::from_buffer(&output)
            .expect("parse")
            .exports
            .iter()
            .any(|export| export.name == checkpoint::COVER_EXPORT),
        "the selection pays off"
    );
}

#[test]
fn a_frame_without_a_covered_callee_is_not_covered() {
    // The entry segment stops at `eight`, eight calls from `_start`, and
    // leaves `idle` uncovered. No covered stack holds `eight` or its callers,
    // and the planner has no landing in `eight` to record it at.
    let input = wat::parse_str(
        r#"
        (module
          (import "kernel" "kernel_checkpoint" (func $kernel_checkpoint))
          (import "kernel" "kernel_checkpoint_covered" (func $kernel_checkpoint_covered (result i32)))
          (memory 1)
          (func $take (if (call $kernel_checkpoint_covered) (then (call $kernel_checkpoint))))
          (func $syscall (call $take))
          (func $poll (call $syscall))
          (func $idle
            nop nop nop nop nop nop nop nop nop nop nop nop nop nop nop nop
            nop nop nop nop nop nop nop nop nop nop nop nop nop nop nop nop
            (loop $events (call $poll) (br $events)))
          (func $eight (call $idle))
          (func $seven (call $eight))
          (func $six (call $seven))
          (func $five (call $six))
          (func $four (call $five))
          (func $three (call $four))
          (func $two (call $three))
          (func $one (call $two))
          (func $_start (export "_start") (call $one)))
        "#,
    )
    .expect("wat parse");
    let scan = scan(&input).expect("scan");
    assert_eq!(
        names(&scan, &select(&scan, None)),
        ["poll", "syscall", "take"]
    );
    let output = fork_instrument::instrument(
        &input,
        &fork_instrument::Options {
            checkpoint_import: Some("kernel.kernel_checkpoint".into()),
            ..Default::default()
        },
    )
    .expect("instrument");
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&output)
        .expect("instrumented module validates");
    assert!(
        Module::from_buffer(&output)
            .expect("parse")
            .exports
            .iter()
            .any(|export| export.name == checkpoint::COVER_EXPORT),
        "the selection pays off"
    );
}
