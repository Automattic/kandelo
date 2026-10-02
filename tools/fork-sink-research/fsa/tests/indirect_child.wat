;; The child branch makes an indirect call; one possible target returns, so
;; `spawn` falls through to `return` in the child: not a sink.
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (type $v (func))
  (table 2 funcref)
  (elem (i32.const 0) $stop $go)
  (func $stop (loop $l (br $l)))
  (func $go)
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $spawn (param $k i32) (result i32) (local $pid i32)
    (local.set $pid (call $fork))
    (if (i32.eqz (local.get $pid)) (then (call_indirect (type $v) (local.get $k))))
    (local.get $pid))
  (func $main (export "_start") (drop (call $spawn (i32.const 1)))))
