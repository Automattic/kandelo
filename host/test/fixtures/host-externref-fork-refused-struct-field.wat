;; Externref stage E2: a fork that holds a raw HOST externref inside a Wasm-GC struct is refused.
;;
;; The host object sits in a FIELD of a Wasm-GC struct; only the struct is
;; held in a local live across `kernel_fork`. The struct itself is capturable;
;; the host object inside it is not, so the whole fork is refused rather than
;; the field quietly becoming null.
;;
;; A fork does not carry a raw HOST externref, on any host (externref stage
;; E2, docs/fork-reference-support.md): a fresh child cannot be given a host
;; object with its identity intact, and a capability a guest needs across fork
;; belongs behind a kernel object (an fd or a device), which fork already
;; shares. So the capture is refused with EOPNOTSUPP inside the fork module,
;; `fork()` returns -95, no child is created, and the parent carries on with
;; the exact object it held.
;;
;; The host object comes from `env.kandelo_test_host_object(tag)`, a plain
;; local host import supplied by the test's process-worker entry
;; (`host/test/fixtures/host-object-import-worker-entry.ts`), which hands back
;; one frozen JavaScript object per tag. `kandelo_test_host_object_tag(value)`
;; reads the tag back by identity (`===`), or -1, so the guest can prove it
;; still holds the SAME object after the refused fork. The native mate is
;; `crates/host-native/fixtures/native_fork_host_externref_refused.wat`.
;;
;; Exit codes (the parent's own; there is never a child):
;;   0  = fork() returned exactly -95, the kernel reports no child
;;        (wait4(-1, WNOHANG) fails ECHILD), and the parent's values are intact
;;   90 = fork() returned something other than exactly -95
;;   91 = a child ran (fork() returned 0), which must never happen
;;   93 = wait4(-1, WNOHANG) did not fail with ECHILD: some child exists
;;
;;   95 = after the refused fork the struct field no longer holds host object 43
;;   96 = after the refused fork the struct's scalar field is no longer 7
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  (import "env" "kandelo_test_host_object"
    (func $host_object (param i32) (result externref)))
  (import "env" "kandelo_test_host_object_tag"
    (func $host_object_tag (param externref) (result i32)))

  (type $box (struct (field i32) (field (mut externref))))

  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))
  ;; __heap_base: required for process admission (computeProcessMemoryLayout).
  ;; This fixture never allocates.
  (global (export "__heap_base") i32 (i32.const 65536))

  (func (export "__abi_version") (result i32)
    i32.const 44)

  (func $exit (param $code i32)
    local.get $code
    call $kernel_exit
    unreachable)

  ;; SYS_wait4(-1, NULL, WNOHANG, NULL) through the process channel; returns the
  ;; errno it failed with, or 0 if it succeeded. With no child at all the
  ;; kernel fails it with ECHILD (10).
  (func $wait_any_nohang_errno (result i32)
    (local $base i32)
    (local $errno i32)
    global.get $__channel_base
    local.set $base

    local.get $base
    i32.const 4
    i32.add
    i32.const 139 ;; SYS_wait4
    i32.store

    local.get $base
    i32.const 8
    i32.add
    i64.const -1 ;; pid: any child
    i64.store

    local.get $base
    i32.const 16
    i32.add
    i64.const 0 ;; status: NULL
    i64.store

    local.get $base
    i32.const 24
    i32.add
    i64.const 1 ;; options: WNOHANG
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
    local.set $errno

    local.get $base
    i32.const 0
    i32.atomic.store

    local.get $errno)

  ;; fork() must be refused: exactly -95, never a child.
  (func $expect_refused (param $pid i32)
    local.get $pid
    i32.eqz
    if
      i32.const 91
      call $exit
    end
    local.get $pid
    i32.const -95
    i32.ne
    if
      i32.const 90
      call $exit
    end
    call $wait_any_nohang_errno
    i32.const 10 ;; ECHILD
    i32.ne
    if
      i32.const 93
      call $exit
    end)

  (func $test
    (local $boxed (ref null $box))
    (local $pid i32)

    i32.const 7
    i32.const 43
    call $host_object
    struct.new $box
    local.set $boxed

    i32.const 0
    call $kernel_fork
    local.set $pid
    local.get $pid
    call $expect_refused

    local.get $boxed
    struct.get $box 1
    call $host_object_tag
    i32.const 43
    i32.ne
    if
      i32.const 95
      call $exit
    end

    local.get $boxed
    struct.get $box 0
    i32.const 7
    i32.ne
    if
      i32.const 96
      call $exit
    end)

  (func (export "_start")
    call $test
    i32.const 0
    call $exit))
