;; K10 probe 4 — a WASI guest that DEFINES and EXPORTS its own memory.
;;
;; This is the `wasiModuleDefinesMemory` category (host/src/wasi-detect.ts:44).
;; It is what an ordinary wasi-sdk build produces by default: the module owns
;; its linear memory outright and Kandelo does not supply it. `worker-main.ts`
;; refuses this category today; the probe asks whether a co-resident side
;; module could serve it at all.
;;
;; Non-shared, which is what a default wasi-sdk link emits.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 8 256)

  (global $scratch i32 (i32.const 256))

  (func (export "_start") (result i32)
    (drop (call $fd_write
      (i32.const 1) (i32.const 64) (i32.const 1) (global.get $scratch)))
    (i32.load (global.get $scratch))))
