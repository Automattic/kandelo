;; Regression fixture for the guard-dispatch path's gating of
;; non-fork-path direct calls.
;;
;; Mimics the compiled shape of os-test/basic/sys_wait/waitpid.c when
;; `main` falls back to guard-dispatch (because the fork-path call is
;; nested inside conditional control flow): the non-fork-path direct
;; call to `kernel.setpgid` sits in the body and would re-fire during
;; REWIND replay if not gated.
;;
;; The expectation after the transform:
;;   - `main` uses guard-dispatch (no top-level br_table).
;;   - The call to `kernel.setpgid` is wrapped in a state==NORMAL
;;     if-else with a result-save local.set inside the then-branch and
;;     a corresponding local.get after the if-else.
;;
;; This fixture is input to the tool; assertions live in
;; tests/switch_dispatch.rs.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
  (import "kernel" "setpgid" (func $setpgid (param i32 i32) (result i32)))

  (memory (export "memory") 1)

  (func $main (export "_start") (result i32)
    (local $pid i32)
    (local $rc  i32)

    ;; Non-fork-path direct call. Result captured into $rc. MUST be
    ;; gated: on REWIND, its kernel side effect (changing pgid) must
    ;; NOT re-fire, and consumers of $rc must see the parent's actual
    ;; return value (preserved via the result-save user local in the
    ;; frame).
    (local.set $rc (call $setpgid (i32.const 0) (i32.const 0)))

    ;; Fork-path call NESTED inside a block — forces guard-dispatch.
    (block $b
      (local.set $pid (call $kernel_fork))
      (br $b)
    )

    ;; Use $rc so the non-fork-path call's result has a consumer.
    (local.get $rc)
  )
)
