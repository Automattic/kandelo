;; -O0 shape: the fork result round-trips through a frame slot across an
;; unrelated call. The frame address never escapes, so the slot is trusted.
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (global $__stack_pointer (mut i32) (i32.const 65536))
  (memory 2)
  (func $_exit (param i32) (loop $l (br $l)))
  (func $noise)
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $spawn (result i32) (local $fp i32)
    (local.set $fp (i32.sub (global.get $__stack_pointer) (i32.const 16)))
    (global.set $__stack_pointer (local.get $fp))
    (i32.store offset=8 (local.get $fp) (call $fork))
    (call $noise)
    (if (i32.eqz (i32.load offset=8 (local.get $fp))) (then (call $_exit (i32.const 1))))
    (global.set $__stack_pointer (i32.add (local.get $fp) (i32.const 16)))
    (i32.load offset=8 (local.get $fp)))
  (func $main (export "_start") (drop (call $spawn))))
