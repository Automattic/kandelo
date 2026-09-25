;; Externref stage E2: a native fork that holds a live raw HOST externref in
;; a LOCAL is REFUSED. `fork()` returns `-EOPNOTSUPP` (-95), no child is
;; created, and the parent carries on holding the exact host object.
;;
;; A host object cannot be copied into a fresh child instance with its
;; identity intact, and a capability a guest needs across fork belongs behind
;; a kernel object (an fd or a device), which fork already shares. So fork
;; keeps Wasm-GC and static-root references and refuses raw host externrefs,
;; on every host -- see docs/fork-reference-support.md. The native mate of
;; host/test/fork-host-externref-refusal.test.ts; the struct-field case is
;; `native_fork_host_externref_field_refused.wat`. (One fork per fixture: this
;; host's entry loop accepts a fork unwind only from the lexical entry.)
;;
;; The host object comes from `env.native_test_host_externref(handle)`, a
;; plain test-only host import (`guest.rs::define_host_externref_source`)
;; that wraps `handle` in a fresh `ExternRef`. Nothing on the fork path looks
;; it up: the refusal happens because no GC layout claims it.
;;
;; Exit codes (the parent's own; there is never a child to reap):
;;   0  = the fork was refused with -95 and the parent kept host object 42
;;   90 = fork() returned something other than exactly -95
;;   94 = after the refused fork the local no longer holds host object 42
;;
;; Built by crates/host-native/fixtures/build-fixtures.sh (`wasm-tools
;; parse`, then scripts/run-wasm-fork-instrument.sh --entry kernel.kernel_fork).
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  (import "env" "native_test_host_externref"
    (func $host_externref (param i32) (result externref)))
  (import "env" "native_test_externref_payload"
    (func $native_test_externref_payload (param externref) (result i32)))

  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))

  (func (export "__abi_version") (result i32)
    i32.const 44)

  ;; Post a REAL `SYS_EXIT_GROUP($code)` on the main syscall channel -- see
  ;; `native_fork_refs.wat`'s `$exit_group` for why this, not
  ;; `kernel.kernel_exit`, is the replay-safe exit every fixture here uses.
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

    ;; Park on the status word until the host answers, as musl's `_exit`
    ;; does. The native host answers an exit by recording it and then
    ;; publishing `CH_TEARDOWN` here, so the `unreachable` below runs only
    ;; once the exit is recorded, and the host reads it as that unwind.
    ;; Trapping straight after the notify, as this once did, races the host
    ;; and is indistinguishable from a guest fault (SIGILL).
    (loop $park
      local.get $base
      i32.const 1 ;; still PENDING
      i64.const -1
      memory.atomic.wait32
      drop
      local.get $base
      i32.atomic.load
      i32.const 1
      i32.eq
      br_if $park)
    unreachable)

  (func $refuse_local
    (local $held externref)
    (local $pid i32)

    i32.const 42
    call $host_externref
    local.set $held

    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.const -95
    i32.ne
    if
      i32.const 90
      call $exit_group
    end

    local.get $held
    call $native_test_externref_payload
    i32.const 42
    i32.ne
    if
      i32.const 94
      call $exit_group
    end)

  (func (export "_start")
    call $refuse_local
    i32.const 0
    call $exit_group
    unreachable))
