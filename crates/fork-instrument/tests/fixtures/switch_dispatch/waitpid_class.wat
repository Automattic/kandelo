;; waitpid-class regression fixture for the switch-dispatch redesign.
;;
;; Mimics the compiled shape of tests/sortix/os-test/basic/sys_wait/waitpid.c at the
;; instrumented-call-site level: a fork-path function that also makes a
;; non-fork-path direct call (here, `kernel.setpgid`) before reaching
;; `kernel.kernel_fork`.
;;
;; The expectation after the switch-dispatch transform:
;;   - The call to `kernel.setpgid` sits in chunk 0 (outside $POST_0).
;;   - During REWINDING, the top-level br_table jumps directly to
;;     $POST_0 and the `kernel.setpgid` call is NEVER re-executed.
;;
;; This fixture is input to the tool; assertions live in
;; tests/switch_dispatch.rs.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
  (import "kernel" "setpgid" (func $setpgid (param i32 i32) (result i32)))

  (memory (export "memory") 1)

  (func $main (export "_start") (result i32)
    (local $pid i32)

    ;; Non-fork-path direct call — MUST NOT re-fire during rewind.
    (drop (call $setpgid (i32.const 0) (i32.const 0)))

    ;; Fork-path direct call — the one dispatch should land at.
    (local.set $pid (call $kernel_fork))

    ;; Return the pid (parent) or zero (child).
    (local.get $pid)
  )
)
