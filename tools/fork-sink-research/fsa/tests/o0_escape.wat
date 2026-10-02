;; As o0_slot, but the frame address is passed to a callee that may rewrite
;; the slot: tracking must switch off, so `spawn` cannot be a sink.
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (global $__stack_pointer (mut i32) (i32.const 65536))
  (memory 2)
  (func $_exit (param i32) (loop $l (br $l)))
  (func $clobber (param i32) (i32.store offset=8 (local.get 0) (i32.const 1)))
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $spawn (result i32) (local $fp i32)
    (local.set $fp (i32.sub (global.get $__stack_pointer) (i32.const 16)))
    (global.set $__stack_pointer (local.get $fp))
    (i32.store offset=8 (local.get $fp) (call $fork))
    (call $clobber (local.get $fp))
    (if (i32.eqz (i32.load offset=8 (local.get $fp))) (then (call $_exit (i32.const 1))))
    (global.set $__stack_pointer (i32.add (local.get $fp) (i32.const 16)))
    (i32.load offset=8 (local.get $fp)))
  (func $main (export "_start") (drop (call $spawn))))
