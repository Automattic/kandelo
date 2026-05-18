;; Trampoline class (b): top-level fork-path call with operand-stack
;; carryover.
;;
;; Today this routes to guard-dispatch via the top-level branch in
;; instrument.rs:303-304 (`has_top_level_stack_carryovers`). Under the
;; trampoline scheme (sub-commit 2.4 of the mega-PR) the same function
;; will route to switch-dispatch + a per-function dispatch table; the
;; carryover value is spilled to a frame-resident scratch slot rather
;; than left on the operand stack across the call.
;;
;; Pattern mimics LLVM's emission for `*(sp + K) = makestrspace(...);`
;; where the store's base address is pushed before the call's args.
;;
;; This is a copy of `tests/fixtures/switch_dispatch/top_level_carryover.wat`
;; — kept duplicated rather than re-pathed so the trampoline test suite
;; can evolve independently of the existing guard-dispatch regression
;; fixture without disturbing the latter.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))

  (memory (export "memory") 1)

  ;; A fork-path helper (trivially calls $kernel_fork so it's in the
  ;; fork-path closure).
  (func $makestrspace (param i32 i32) (result i32)
    (drop (call $kernel_fork))
    (local.get 0))

  (func $main (export "_start") (result i32)
    (local $sp i32)
    (local $pid i32)

    (local.set $sp (i32.const 100))
    (local.set $pid (call $kernel_fork))

    ;; Carryover pattern:
    ;;   local.get $sp            ;; push base address — STAYS on stack
    ;;   i32.const 16             ;; makestrspace arg 0
    ;;   i32.const 8              ;; makestrspace arg 1
    ;;   call $makestrspace       ;; pops 2, pushes 1 → stack: [sp, ret]
    ;;   i32.store offset=12      ;; pops 2: *(sp+12) = ret
    local.get $sp
    i32.const 16
    i32.const 8
    call $makestrspace
    i32.store offset=12

    (local.get $pid)))
