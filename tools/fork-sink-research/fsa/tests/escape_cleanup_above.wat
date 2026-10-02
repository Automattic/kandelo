;; The child throws; the frame above only runs a cleanup and rethrows
;; (catch_all_ref + throw_ref, LLVM's C++ cleanup pad). No real handler is
;; above, so under equiv `spawn` is a sink; under --catchers coarse it is not.
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (tag $t (param i32))
  (func $dtor)
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $spawn (result i32) (local $pid i32)
    (local.set $pid (call $fork))
    (if (i32.eqz (local.get $pid)) (then (throw $t (i32.const 1))))
    (local.get $pid))
  (func $main (export "_start") (local $e exnref)
    (block $h (result exnref)
      (try_table (catch_all_ref $h) (drop (call $spawn)))
      (return))
    (local.set $e)
    (call $dtor)
    (throw_ref (local.get $e))))
