;; Regression fixture: SIMD lane loads and stores ahead of a top-level
;; fork-path call with an operand-stack carryover.
;;
;; walrus folds the lane memory operations into `Instr::LoadSimd`, but
;; they do not share the plain SIMD loads' 1 -> 1 stack effect:
;;   v128.loadN_lane   pops [addr, v128], pushes v128   (2 -> 1)
;;   v128.storeN_lane  pops [addr, v128], pushes none   (2 -> 0)
;; Modelling them as 1 -> 1 overcounts the operand stack at the call, so
;; the instrumenter spills more carryovers than exist and emits a
;; `local.set` with nothing on the stack. FFmpeg's ffplay (built with
;; -msimd128 and fork-instrumented because SDL2 can fork) hit exactly
;; this in a codec's decode_frame.
;;
;; This fixture is input to the tool; assertions live in
;; tests/switch_dispatch.rs.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))

  (memory (export "memory") 1)

  (func $helper (param i32) (result i32)
    (drop (call $kernel_fork))
    (local.get 0))

  (func $main (export "_start") (result i32)
    (local $sp i32)
    (local $pid i32)

    (local.set $sp (i32.const 100))
    (local.set $pid (call $kernel_fork))

    ;; 2 -> 0: leaves the operand stack empty.
    local.get $sp
    v128.const i32x4 1 2 3 4
    v128.store32_lane 0

    ;; Carryover: the store address below, pushed before the call's arg.
    local.get $sp

    ;; 2 -> 1, then 1 -> 1: produces the call's single i32 argument.
    local.get $sp
    v128.const i32x4 0 0 0 0
    v128.load32_lane 1
    i32x4.extract_lane 1

    call $helper
    i32.store offset=12

    (local.get $pid)))
