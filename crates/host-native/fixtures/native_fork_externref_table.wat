;; A native fork of a program that grows and writes its OWN externref table.
;;
;; The native mate of the "a program that grows and sets its own externref
;; table forks" case in host/test/dlopen-pthread-table-replication.test.ts.
;; An externref table is saved across fork but never REPLICATED across
;; Workers: its host objects cannot exist in another Worker, so fork-instrument
;; routes its mutations through the dirty-page journal only, with no process
;; writer, commit or reconcile. Before that split the JS hosts exited 132 on
;; this program: the `table.set` was committed as a funcref mutation, and the
;; fork module was asked to describe an externref slot as a function-catalog
;; entry.
;;
;; The slots hold null, so no host object is carried (a raw host externref is
;; refused by fork on every host -- docs/fork-reference-support.md). What the
;; child must reproduce is the table's LENGTH and its null entries.
;;
;; Exit codes (parent-observed):
;;   0  = the child saw the 100-slot table and exited 0, and the parent reaped it
;;   92 = wait4 did not reap the child, or the child's status was nonzero
;;        (the child exits 9 if its table is not 100 slots long)
;;   93 = the parent's own table is not 100 slots long after the fork
;;
;; Built by crates/host-native/fixtures/build-fixtures.sh (`wasm-tools
;; parse`, then scripts/run-wasm-fork-instrument.sh --entry kernel.kernel_fork).
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  (table $tokens 0 externref)

  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))

  (func (export "__abi_version") (result i32)
    i32.const 44)

  ;; Post a REAL `SYS_EXIT_GROUP($code)` on the process's main syscall
  ;; channel, mirroring `$wait_child`'s hand-rolled channel protocol (the
  ;; same offsets: `SYSCALL_OFFSET` = base+4, `ARGS_OFFSET` = base+8,
  ;; `STATUS_OFFSET` = base+0). `exit_group` never returns, so this ends in
  ;; `unreachable` unconditionally — a recognized-as-clean
  ;; `Trap::UnreachableCodeReached` on native (`guest.rs::is_unreachable_
  ;; trap`), the SAME outcome a real musl `_exit`/`exit_group` call produces
  ;; for every OTHER (C-built) fixture in this crate.
  ;;
  ;; Deliberately NOT `kernel.kernel_exit`: that import is native's
  ;; SIGKILL-ONLY fast path (`guest.rs`'s own doc comment: "A normal exit
  ;; never calls it"), which returns a raw `wasmtime::Error`, NOT a
  ;; recognized clean trap — using it for a NORMAL exit (as an earlier
  ;; version of this fixture did, inherited from the pre-N1-I5b version)
  ;; surfaces as "guest entry failed" and leaves the real kernel process
  ;; table never told this process exited, hanging any `wait4`er (here, the
  ;; PARENT) forever. `SYS_EXIT_GROUP` is the real, replay-safe protocol
  ;; every other exit in this fixture now goes through.
  (func $exit_group (param $code i32)
    (local $base i32)
    global.get $__channel_base
    local.set $base

    local.get $base
    i32.const 4
    i32.add
    i32.const 387 ;; SYS_EXIT_GROUP
    i32.store

    local.get $base
    i32.const 8
    i32.add
    local.get $code
    i64.extend_i32_s
    i64.store

    local.get $base
    i32.const 16
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 24
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 32
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 40
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 48
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 1
    i32.atomic.store
    local.get $base
    i32.const 1
    memory.atomic.notify
    drop

    unreachable)

  (func $wait_child (param $pid i32) (result i32)
    (local $base i32)
    (local $result i32)

    global.get $__channel_base
    local.set $base

    ;; SYS_wait4(pid, &status, 0, 0)
    local.get $base
    i32.const 4
    i32.add
    i32.const 139
    i32.store

    local.get $base
    i32.const 8
    i32.add
    local.get $pid
    i64.extend_i32_s
    i64.store

    local.get $base
    i32.const 16
    i32.add
    i64.const 1024
    i64.store

    local.get $base
    i32.const 24
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 32
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 40
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 48
    i32.add
    i64.const 0
    i64.store

    local.get $base
    i32.const 1
    i32.atomic.store
    local.get $base
    i32.const 1
    memory.atomic.notify
    drop

    block $complete
      loop $wait
        local.get $base
        i32.atomic.load
        i32.const 1
        i32.ne
        br_if $complete

        local.get $base
        i32.const 1
        i64.const -1
        memory.atomic.wait32
        drop
        br $wait
      end
    end

    local.get $base
    i32.const 64
    i32.add
    i32.load
    if
      i32.const -1
      local.set $result
    else
      local.get $base
      i32.const 56
      i32.add
      i64.load
      i32.wrap_i64
      local.set $result
    end

    local.get $base
    i32.const 0
    i32.atomic.store

    local.get $result)

  (func $require_child_ok (param $pid i32)
    local.get $pid
    call $wait_child
    local.get $pid
    i32.ne
    if
      i32.const 92
      call $exit_group
    end

    i32.const 1024
    i32.load
    if
      i32.const 92
      call $exit_group
    end)

  (func $test_table
    (local $pid i32)
    ref.null extern
    i32.const 100
    table.grow $tokens
    drop
    i32.const 50
    ref.null extern
    table.set $tokens

    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      table.size $tokens
      i32.const 100
      i32.ne
      if
        i32.const 9
        call $exit_group
      end
      i32.const 0
      call $exit_group
      unreachable
    end

    table.size $tokens
    i32.const 100
    i32.ne
    if
      i32.const 93
      call $exit_group
    end

    local.get $pid
    call $require_child_ok)

  (func (export "_start")
    call $test_table
    i32.const 0
    call $exit_group
    unreachable))
