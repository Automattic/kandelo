;; Trampoline class (a): fork-path call inside a `loop` body with an
;; operand-stack carryover at the call site.
;;
;; Today this routes to guard-dispatch via the nested-pattern branch
;; in instrument.rs:259-289 — `classify_nested_pattern` returns
;; `UnsupportedCarryover` because `seq_has_unsupported_carryover`
;; detects the carryover inside the loop body. Under the trampoline
;; scheme the post-call code is extracted into its own function and
;; reached via `call_indirect $main_post_table` at the loop's REWIND
;; entry; the carryover value is spilled to a frame-resident scratch
;; slot.
;;
;; Pattern is the loop-body analogue of `top_level_carryover.wat`.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))

  (memory (export "memory") 1)

  (func $makestrspace (param i32 i32) (result i32)
    (drop (call $kernel_fork))
    (local.get 0))

  (func $main (export "_start") (result i32)
    (local $sp i32)
    (local $pid i32)
    (local $i i32)

    (local.set $sp (i32.const 100))
    (local.set $i (i32.const 0))

    ;; Single-trip loop wrapping the carryover pattern. The loop scope
    ;; itself disables top-level switch-dispatch; the carryover inside
    ;; the loop body disables nested switch-dispatch; therefore today
    ;; this routes to guard-dispatch.
    (loop $L
      ;; Carryover at the call site:
      local.get $sp            ;; STAYS on stack across the call
      i32.const 16
      i32.const 8
      call $makestrspace       ;; pops 2, pushes 1 → stack: [sp, ret]
      i32.store offset=12

      (local.set $pid (call $kernel_fork))

      ;; Single trip — break out.
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $L (i32.lt_s (local.get $i) (i32.const 1)))
    )

    (local.get $pid)))
