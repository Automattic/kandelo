;; K10 probe 1 — stand-in for a WASI guest.
;;
;; Imports the `wasi_snapshot_preview1` namespace exactly the way a real
;; wasi-libc program does, and imports (does not define) its memory, which is
;; what `wasiModuleDefinesMemory` already requires of every WASI guest Kandelo
;; will run (`host/src/worker-main.ts`).
;;
;; The host supplies these imports from ANOTHER INSTANCE'S EXPORTS, so every
;; call below is a wasm->wasm call with no JS frame in between.
(module
  (import "env" "memory" (memory 1 65536 shared))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_seek"
    (func $fd_seek (param i32 i64 i32 i32) (result i32)))

  ;; scratch inside the guest's own low memory
  (global $scratch i32 (i32.const 256))

  (func (export "_start") (result i32)
    (drop (call $fd_write
      (i32.const 1) (i32.const 64) (i32.const 1) (global.get $scratch)))
    (i32.load (global.get $scratch)))

  ;; Hands a full-width i64 through the wasm->wasm import boundary and returns
  ;; what came back, so the host can compare against the exact expected value.
  ;; 0x0123456789ABCDEF is chosen because it is not representable exactly as a
  ;; JS number: any accidental round trip through a JS Number corrupts it.
  (func (export "seek_roundtrip") (param $off i64) (result i64)
    (drop (call $fd_seek
      (i32.const 3) (local.get $off) (i32.const 0) (global.get $scratch)))
    (i64.load (global.get $scratch)))

  ;; The guest growing its own memory, the way wasi-libc's sbrk does. Returns
  ;; the PREVIOUS page count, which is what wasi-libc uses as the new heap
  ;; base -- the fact probe 3 turns on.
  (func (export "guest_grow") (param $pages i32) (result i32)
    (memory.grow (local.get $pages)))
  (func (export "guest_memory_size") (result i32) (memory.size)))
