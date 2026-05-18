;; Regression fixture: a sub-region landing whose preceding chunk has
;; a 1-i32 stack carryover. Exact shape that LLVM-O2 emits for
;; `errno = posix_spawn(&pid, ...)` after inlining posix_spawn into
;; the caller — the source of the prior pre-existing
;; `posix_spawnattr_setpgroup -O2` ECHILD failure (see the in-source
;; comment in `instrument.rs::seq_has_unsupported_carryover`).
;;
;; Pattern:
;;     local.get $errno_addr        ;; carryover (i32) — pushed before
;;     block (result i32)            ;; sub-region with kernel_fork
;;       call $kernel_fork           ;; the actual fork-path call
;;     end
;;     i32.store                     ;; consumes [errno_addr, fork_result]
;;
;; Expectation after the per-block switch-dispatch transform:
;;   - `main` uses switch-dispatch — at least one `br_table` is emitted
;;     (NOT routed to guard-dispatch as it was prior to the
;;     carryover-spilling extension).
;;   - Output module validates as legal wasm.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))

  (memory (export "memory") 1)

  (func $main (export "_start") (result i32)
    (local $errno_addr i32)

    ;; Set up an "errno address" — a stable i32 carryover source.
    (local.set $errno_addr (i32.const 16))

    ;; Carryover pattern: push errno_addr BEFORE the fork-bearing
    ;; block, consume after the block.
    (local.get $errno_addr)
    (i32.store
      (block (result i32)
        (call $kernel_fork)
      )
    )

    (i32.const 0)
  )
)
