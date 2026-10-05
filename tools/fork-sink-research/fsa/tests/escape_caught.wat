;; The child throws; `main` (above the would-be sink) catches the tag. Under
;; equiv the throw keeps `spawn` open; under runtime it is a flagged sink.
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (tag $t (param i32))
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $spawn (result i32) (local $pid i32)
    (local.set $pid (call $fork))
    (if (i32.eqz (local.get $pid)) (then (throw $t (i32.const 1))))
    (local.get $pid))
  (func $main (export "_start")
    (block $h (result i32)
      (try_table (catch $t $h) (drop (call $spawn)))
      (i32.const 0))
    (drop)))
