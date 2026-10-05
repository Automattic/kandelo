;; The child returns through `daemonize` into `main`: both stay instrumented.
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $daemonize (result i32) (call $fork))
  (func $main (export "_start") (drop (call $daemonize))))
