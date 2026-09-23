;; Externref stage E2's carve-out, proven through a real fresh fork Worker: an
;; `externref` that is an `extern.convert_any` VIEW of the program's OWN Wasm-GC
;; object is not a host object, and a fork that holds one SUCCEEDS.
;;
;; A fork refuses a raw HOST externref with EOPNOTSUPP (see
;; `host-externref-fork-refused-*.wat`). This is the case most at risk of being
;; refused by mistake: the guest's `__wpk_fork_ref_encode_externref` converts
;; the view back (`any.convert_extern`) before classifying it, so the view is
;; captured as the typed struct it names, and the child rebuilds that struct.
;;
;; The view is held in an externref LOCAL live across `kernel_fork`, and the
;; struct it views is also aliased through a mutable reference global. The
;; child checks that the view converts back to a `$node` holding 77 and that it
;; is the SAME object as the global's (`ref.eq`) -- one reconstructed identity,
;; not two copies -- then exits 0. The parent checks its own view the same way
;; and reaps the child.
;;
;; Exit codes:
;;   0  = child and parent both verified the view
;;   91 = CHILD: the view did not convert back to the same `$node` holding 77
;;   92 = wait4 did not reap the child, or the child exited nonzero
;;   94 = PARENT: its own view no longer names the same `$node` holding 77
;;   95 = PARENT: fork() failed (the view was refused as if it were a host object)
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))

  (type $node (struct (field (mut i32))))

  (global $saved (mut (ref null $node)) (ref.null $node))
  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))
  ;; __heap_base: required for process admission (computeProcessMemoryLayout).
  ;; This fixture never allocates.
  (global (export "__heap_base") i32 (i32.const 65536))

  (func (export "__abi_version") (result i32)
    i32.const 44)

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

  ;; 1 when `$view` converts back to the `$node` in `$saved` holding 77.
  (func $view_ok (param $view externref) (result i32)
    (local $node (ref null $node))
    local.get $view
    any.convert_extern
    ref.test (ref $node)
    i32.eqz
    if
      i32.const 0
      return
    end
    local.get $view
    any.convert_extern
    ref.cast (ref $node)
    local.set $node

    local.get $node
    global.get $saved
    ref.eq

    local.get $node
    struct.get $node 0
    i32.const 77
    i32.eq
    i32.and)

  (func (export "_start")
    (local $view externref)
    (local $pid i32)

    i32.const 77
    struct.new $node
    global.set $saved

    global.get $saved
    extern.convert_any
    local.set $view

    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      local.get $view
      call $view_ok
      i32.eqz
      if
        i32.const 91
        call $kernel_exit
        unreachable
      end
      i32.const 0
      call $kernel_exit
      unreachable
    end

    local.get $pid
    i32.const 0
    i32.lt_s
    if
      i32.const 95
      call $kernel_exit
      unreachable
    end

    local.get $view
    call $view_ok
    i32.eqz
    if
      i32.const 94
      call $kernel_exit
      unreachable
    end

    local.get $pid
    call $wait_child
    local.get $pid
    i32.ne
    if
      i32.const 92
      call $kernel_exit
      unreachable
    end

    i32.const 1024
    i32.load
    if
      i32.const 92
      call $kernel_exit
      unreachable
    end

    i32.const 0
    call $kernel_exit
    unreachable))
