;; Regression fixture for Path A — nested per-block switch-dispatch.
;;
;; Mimics the popen-min pattern: a fork-path call (`kernel.kernel_fork`)
;; nested inside an `if-then`, with a non-fork-path direct call (`setpgid`)
;; earlier in the body whose result feeds the if's condition. This is the
;; shape that causes guard-dispatch's REWIND body-replay to diverge from
;; NORMAL flow (gated `local.tee` etc. push default values that mismatch
;; what NORMAL computed, so the body takes a different control-flow path
;; on REWIND and the kernel_fork wrap is silently skipped).
;;
;; Expectation after Path A:
;;   - `main` uses switch-dispatch — at least one `br_table` is emitted
;;     (top-level dispatch and/or per-block dispatch inside the `if-then`).
;;   - `kernel.setpgid` is NOT re-executed during REWIND: with switch-
;;     dispatch, chunks between landing pads run only on NORMAL.
;;
;; Today (before Path A), `has_nested_fork_calls` returns true for `main`,
;; so the tool falls back to guard-dispatch and emits no `br_table` — the
;; assertion in `nested_fork_call_uses_per_block_switch_dispatch` therefore
;; FAILs today, which is the intended RED state.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
  (import "kernel" "setpgid" (func $setpgid (param i32 i32) (result i32)))

  (memory (export "memory") 1)

  (func $main (export "_start") (result i32)
    (local $pid i32)
    (local $rc i32)

    ;; Non-fork-path direct call. Its result feeds subsequent code. If
    ;; REWIND re-executes this call (or skips without preserving its
    ;; NORMAL result), control flow diverges between NORMAL and REWIND.
    (local.set $rc (call $setpgid (i32.const 0) (i32.const 0)))

    ;; Fork-path call NESTED inside a `block (result i32)` — exactly
    ;; the shape musl emits for popen → posix_spawn → __fork →
    ;; kernel_fork (inner block holds the kernel_fork call site, outer
    ;; structure threads the pid back to the caller).
    ;;
    ;; Today (before Path A) this routes to guard-dispatch and emits
    ;; no `br_table`. After Path A it routes to nested per-block
    ;; switch-dispatch and emits at least one `br_table` (function-
    ;; level dispatch + per-block dispatch inside the `block`).
    (local.set $pid
      (block (result i32)
        (call $kernel_fork)
      )
    )
    (drop (local.get $rc))
    (local.get $pid)
  )
)
