;; ABI 44 real-worker fixture: a live host externref minted through
;; `call_indirect` and carried across `kernel_fork`.
;;
;; WHAT THIS USED TO PROVE, AND WHY IT CHANGED. `call_indirect` exists here to
;; defeat the fork-instrument provenance-wrapper pass, which rewrites only
;; DIRECT calls: the reference arrived with no recorded mint-time provenance,
;; and provenance was the only way the host could learn its broker handle. So
;; the fork was REFUSED -- EOPNOTSUPP, no child, parent intact -- and this
;; fixture asserted that refusal.
;;
;; The module asks the host for the handle now, and the host reads it off the
;; broker token itself (`__wpk_fork_host_externref_handle`, the reverse of
;; `resolve_externref`). How the value was minted stopped mattering, so this
;; same reference is capturable and the fork COMPLETES. The boundary did not
;; vanish -- a reference the broker never minted still answers 0 and is still
;; refused -- it moved from "how was it minted" to "is it a broker reference at
;; all", which no guest program can reach: every externref crossing the import
;; mailbox is registered for wire. `fork-module-externref-capture-seam.test.ts`
;; asserts the refusal where it can still be reached, one level down.
;;
;; So this fixture now pins the CAPABILITY that replaced the gate, and keeps
;; every guarantee the old one carried:
;;
;;   * the fork completes -- a negative pid means the refusal came back;
;;   * the CHILD's reconstructed reference resolves to the SAME owner-minted
;;     host identity (96/97), which is the whole point of capturing it;
;;   * the PARENT is unaffected (93/94) and reaps its child (95);
;;   * there is no pump/gate hang: the test holds the run to a bounded budget.
;;
;; Exit codes:
;;   90 = the minted reference was null before the fork.
;;   91 = it did not resolve to the owner identity before the fork.
;;   92 = `fork()` returned a NEGATIVE value: the fork was refused, which is
;;        the behaviour this fixture used to require and now forbids.
;;   93 = the parent's own reference was null after the fork.
;;   94 = the parent's reference no longer resolves to the owner identity.
;;   95 = the parent could not reap its child.
;;   96 = the CHILD's reconstructed reference was null.
;;   97 = the CHILD's reference resolved to a DIFFERENT identity.
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  ;; Host reference producer/verifier, wired by the test to the process
  ;; externref owner (broker). `get_ext` is reached ONLY via `call_indirect`
  ;; below (never a direct `call`), so the provenance-wrapper pass leaves its
  ;; result with no recorded provenance — see this file's doc comment.
  (import "env" "get_ext" (func $get_ext (result externref)))
  (import "env" "check_ext" (func $check_ext (param externref) (result i32)))

  (type $get_ext_ty (func (result externref)))

  ;; The one-element indirect-call table: slot 0 is the SAME `get_ext` import,
  ;; populated via an ACTIVE element segment (bootstrap-time, not a runtime
  ;; `table.set`) so the provenance pass's direct-call rewrite has no call site
  ;; to find here — only the `call_indirect` below ever reaches it.
  (table $indirect 1 funcref)
  (elem (table $indirect) (i32.const 0) func $get_ext)

  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))

  ;; __heap_base: required for process admission by the
  ;; computeProcessMemoryLayout guard in host/src/process-memory.ts.
  ;; This fixture never allocates, so the value only needs to sit at
  ;; the first page boundary past the reserved stack page.
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

  (func (export "_start")
    (local $ref externref)
    (local $pid i32)

    ;; Mint a live host externref via `call_indirect` — NOT a direct `call` —
    ;; so it carries no recorded provenance. Table index 0 -> `$get_ext`.
    i32.const 0
    call_indirect $indirect (type $get_ext_ty)
    local.set $ref

    ;; Parent guard: the reference must exist and already resolve to the
    ;; owner-minted identity before forking.
    local.get $ref
    ref.is_null
    if
      i32.const 90
      call $kernel_exit
      unreachable
    end
    local.get $ref
    call $check_ext
    i32.eqz
    if
      i32.const 91
      call $kernel_exit
      unreachable
    end

    ;; Fork with the reference live across the boundary. It is capturable now,
    ;; so a child IS created and reconstructs it.
    i32.const 0
    call $kernel_fork
    local.set $pid

    local.get $pid
    i32.eqz
    if
      ;; CHILD: the reference is reconstructed by this fresh instance's replay.
      local.get $ref
      ref.is_null
      if
        i32.const 96
        call $kernel_exit
        unreachable
      end
      local.get $ref
      call $check_ext
      i32.eqz
      if
        i32.const 97
        call $kernel_exit
        unreachable
      end
      i32.const 0
      call $kernel_exit
      unreachable
    end

    ;; A NEGATIVE pid is the old refusal coming back.
    local.get $pid
    i32.const 0
    i32.lt_s
    if
      i32.const 92
      call $kernel_exit
      unreachable
    end

    ;; PARENT survives unaffected: its own local still resolves to the SAME
    ;; owner-minted identity after the fork's unwind and rewind.
    local.get $ref
    ref.is_null
    if
      i32.const 93
      call $kernel_exit
      unreachable
    end
    local.get $ref
    call $check_ext
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
      i32.const 95
      call $kernel_exit
      unreachable
    end

    i32.const 0
    call $kernel_exit
    unreachable))
