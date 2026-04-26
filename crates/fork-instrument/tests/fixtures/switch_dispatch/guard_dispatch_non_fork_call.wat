;; Regression fixture for the guard-dispatch path's gating of
;; non-fork-path direct calls (c01554940).
;;
;; The fork-path call site has an operand-stack carryover: a value
;; pushed BEFORE the call's args remains across it and is consumed
;; AFTER the call returns. The nested per-block switch-dispatch
;; transform's POST_K blocks are 0 → 0 — they can't express
;; carryovers — so this function falls back to guard-dispatch, which
;; exercises the c01554940 fix this test verifies.
;;
;; Expectation after the transform:
;;   - `main` uses guard-dispatch (no top-level br_table).
;;   - The call to `kernel.setpgid` is wrapped in a state==NORMAL
;;     if-else with a result-save local.set inside the then-branch.
;;
;; This fixture is input to the tool; assertions live in
;; tests/switch_dispatch.rs.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
  (import "kernel" "setpgid" (func $setpgid (param i32 i32) (result i32)))

  (memory (export "memory") 1)

  (func $main (export "_start") (result i32)
    (local $rc  i32)

    ;; Non-fork-path direct call. Result captured into $rc. MUST be
    ;; gated: on REWIND, its kernel side effect (changing pgid) must
    ;; NOT re-fire, and consumers of $rc must see the parent's actual
    ;; return value (preserved via the result-save user local in the
    ;; frame).
    (local.set $rc (call $setpgid (i32.const 0) (i32.const 0)))

    ;; Operand-stack carryover at fork-path call site:
    ;;   i32.const 100         ;; address (carryover)
    ;;   call $kernel_fork     ;; pushes pid (1 i32)
    ;;   i32.store offset=4    ;; consumes [addr, pid]
    ;; This shape forces guard-dispatch (per-block switch-dispatch
    ;; cannot express carryovers).
    i32.const 100
    (call $kernel_fork)
    i32.store offset=4

    (local.get $rc)
  )
)
