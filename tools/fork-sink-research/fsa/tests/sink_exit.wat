;; Child branch calls a function that never returns: `spawn` is a sink, so
;; its caller `main` needs no instrumentation.
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (func $_exit (param i32) (loop $l (br $l)))
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $spawn (result i32) (local $pid i32)
    (local.set $pid (call $fork))
    (if (i32.eqz (local.get $pid)) (then (call $_exit (i32.const 127))))
    (local.get $pid))
  (func $main (export "_start") (drop (call $spawn))))
