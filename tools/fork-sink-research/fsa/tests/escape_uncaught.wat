;; The child throws and nothing in the module catches: equiv closes `spawn`.
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (tag $t (param i32))
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $spawn (result i32) (local $pid i32)
    (local.set $pid (call $fork))
    (if (i32.eqz (local.get $pid)) (then (throw $t (i32.const 1))))
    (local.get $pid))
  (func $main (export "_start") (drop (call $spawn))))
