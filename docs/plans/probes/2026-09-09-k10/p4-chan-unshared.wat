;; K10 probe 4 — the channel wait against a NON-SHARED memory.
;;
;; A guest that defines its own memory (p4-guest-owns.wat) emits a non-shared
;; one. If the side module imported that memory, this is what its channel wait
;; would compile to. The question is whether `memory.atomic.wait32` is even
;; expressible and callable there, since the whole syscall channel depends on
;; it (and on JS `Atomics`, which require a SharedArrayBuffer).
(module
  (import "env" "memory" (memory 1 256))

  (func (export "bare_wait") (param $addr i32) (param $expect i32) (param $timeout_ns i64) (result i32)
    (memory.atomic.wait32 (local.get $addr) (local.get $expect) (local.get $timeout_ns)))

  (func (export "store_and_notify") (param $addr i32) (param $value i32) (result i32)
    (i32.atomic.store (local.get $addr) (local.get $value))
    (memory.atomic.notify (local.get $addr) (i32.const -1))))
