;; K10 probe 4 — the friendlier sub-case: a guest that defines its own memory
;; but declares it SHARED. Atomics are then at least possible, so this isolates
;; the *instantiation-order* problem from the *shared-memory* problem.
;;
;; A default wasi-sdk link does not emit this; it takes explicit
;; --shared-memory --import-memory-style flags. Included so the probe can say
;; which of the two obstacles is the blocking one.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 8 256 shared)

  (global $scratch i32 (i32.const 256))

  (func (export "_start") (result i32)
    (drop (call $fd_write
      (i32.const 1) (i32.const 64) (i32.const 1) (global.get $scratch)))
    (i32.load (global.get $scratch))))
