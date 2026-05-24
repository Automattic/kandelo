;; Regression fixture for non-fork-path direct call handling at a
;; fork-path call site with an operand-stack carryover (c01554940 +
;; sub-commit 2.4c).
;;
;; The fork-path call site has an operand-stack carryover: a value
;; pushed BEFORE the call's args remains across it and is consumed
;; AFTER the call returns. Before sub-commit 2.4c this forced
;; guard-dispatch (POST_K blocks were 0 → 0 and couldn't express
;; carryovers); guard-dispatch then explicitly gated the non-fork-path
;; `setpgid` call inside a state==NORMAL if-else (c01554940). After
;; 2.4c, switch-dispatch absorbs the carryover via per-call spill
;; locals, and the non-fork-path call sits in `chunks[0]` which is
;; skipped on REWIND by br_table — no explicit gate needed.
;;
;; Expectation after the transform (post-2.4c):
;;   - `main` uses switch-dispatch (br_table emitted at top level).
;;   - The call to `kernel.setpgid` is preserved verbatim in
;;     `chunks[0]`; the br_table dispatches directly to `$POST_K` on
;;     REWIND, skipping `chunks[0]` entirely so setpgid doesn't re-fire.
;;
;; This fixture is input to the tool; assertions live in
;; tests/switch_dispatch.rs::switch_dispatch_skips_non_fork_path_direct_call_on_rewind.
;; The fixture filename (`guard_dispatch_non_fork_call.wat`) is kept
;; for git-blame continuity; the historical context above explains the
;; name's origin.

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
