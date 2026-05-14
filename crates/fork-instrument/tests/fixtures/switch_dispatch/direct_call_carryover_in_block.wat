;; Regression fixture for sub-commit 2.5c: a direct fork-path Call
;; lives inside a nested Block body, with an i32 pushed onto the
;; Block's local operand stack BEFORE the call's args and consumed
;; AFTER the call returns.
;;
;; Pattern (inside the Block body):
;;     local.get $sp              ;; carryover (i32) on the Block's
;;                                ;;   local stack
;;     i32.const 16
;;     i32.const 8
;;     call $kernel_fork_helper   ;; fork-path direct Call (params i32 i32)
;;     i32.store offset=12        ;; consumes [sp, fork_helper_result]
;;
;; Pre-2.5c: `seq_has_unsupported_carryover` rejected any direct-call
;; carryover (instrument.rs:4823), forcing the function to
;; guard-dispatch. The nested switch-dispatch's
;; `emit_chunk_tail_for_landing` only spilled the call's args at
;; DirectCall landings; the carryover would be left on the operand
;; stack at the POST_K close, failing wasm validation.
;;
;; Post-2.5c: `compute_nested_carryover_types` types the carryover
;; statically; the per-call `carryover_spills` wiring (2.5b) pops the
;; carryover into a frame-resident spill local at the call site and
;; reloads it beneath the call's result on REWIND. Function routes to
;; nested switch-dispatch.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))

  (memory (export "memory") 1)

  ;; Fork-path callee with 2 i32 args (so the carryover position
  ;; below the args is unambiguous).
  (func $kernel_fork_helper (param i32 i32) (result i32)
    (drop (call $kernel_fork))
    (local.get 0))

  (func $main (export "_start") (result i32)
    (local $sp i32)

    (local.set $sp (i32.const 100))

    ;; Outer Block forces nested-switch routing (creates a nested
    ;; fork-bearing seq containing the direct fork-path call).
    (block
      ;; Carryover: push $sp BEFORE the helper's args.
      local.get $sp
      i32.const 16
      i32.const 8
      call $kernel_fork_helper
      i32.store offset=12)

    (i32.const 0)))
