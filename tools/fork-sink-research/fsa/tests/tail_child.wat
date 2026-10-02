;; A fork-reaching tail call: `tail` is transparent, its callee's child result
;; is its own, so `root` (which returns it) stays instrumented.
(module
  (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
  (func $deep (result i32) (call $fork (i32.const 0)))
  (func $tail (result i32) (return_call $deep))
  (func $root (export "_start") (drop (call $tail))))
