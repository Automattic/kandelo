;; Externref stage E2: a native fork that holds a live raw HOST externref in
;; a FIELD of a Wasm-GC struct -- only the struct held in a local -- is
;; REFUSED. The struct itself is capturable; the host object inside it is not,
;; so the whole fork is refused (`fork()` returns -95, no child) rather than the
;; field quietly becoming null, and the parent keeps the struct and its object.
;;
;; See `native_fork_host_externref_refused.wat` for why the boundary exists and
;; where the host object comes from; this is its struct-field sibling.
;;
;; Exit codes (the parent's own; there is never a child to reap):
;;   0  = the fork was refused with -95 and the parent's struct is intact
;;   91 = fork() returned something other than exactly -95
;;   95 = after the refused fork the struct field no longer holds host object 43
;;   96 = after the refused fork the struct's scalar field is no longer 7
;;
;; Built by crates/host-native/fixtures/build-fixtures.sh.
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  (import "env" "native_test_host_externref"
    (func $host_externref (param i32) (result externref)))
  (import "env" "native_test_externref_payload"
    (func $native_test_externref_payload (param externref) (result i32)))

  (type $box (struct (field i32) (field (mut externref))))

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

  (func $refuse_struct_field
    (local $boxed (ref null $box))
    (local $pid i32)

    i32.const 7
    i32.const 43
    call $host_externref
    struct.new $box
    local.set $boxed

    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.const -95
    i32.ne
    if
      i32.const 91
      call $exit_group
    end

    local.get $boxed
    struct.get $box 1
    call $native_test_externref_payload
    i32.const 43
    i32.ne
    if
      i32.const 95
      call $exit_group
    end

    local.get $boxed
    struct.get $box 0
    i32.const 7
    i32.ne
    if
      i32.const 96
      call $exit_group
    end)

  (func (export "_start")
    call $refuse_struct_field
    i32.const 0
    call $exit_group
    unreachable))
