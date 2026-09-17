;; K10 probe 1/3 — stand-in for `crates/wasi-module`.
;;
;; Shaped like a PIC side module: it imports the guest's shared linear memory
;; and the placement globals `__memory_base` / `__stack_pointer`, and every
;; access to its own static region is `__memory_base`-relative. It exports
;; functions with real `wasi_snapshot_preview1` signatures, including the
;; i64-carrying `fd_seek`, so probe 1 can check that a wasm->wasm import call
;; preserves i64 exactly (the TypeScript shim has to split i64 into two i32
;; words precisely because a JS import frame cannot carry one).
(module
  (import "env" "memory" (memory 1 65536 shared))
  (import "env" "__memory_base" (global $mb i32))
  (import "env" "__stack_pointer" (global $sp (mut i32)))

  ;; wasi_snapshot_preview1.fd_write(fd, iovs, iovs_len, nwritten_ptr) -> errno
  ;; Writes a witness into its OWN region (memory_base relative) and a result
  ;; into the GUEST's buffer, exercising both sides of the placement contract.
  (func (export "fd_write")
        (param $fd i32) (param $iovs i32) (param $iovs_len i32) (param $ret i32)
        (result i32)
    (i32.store (i32.add (global.get $mb) (i32.const 0)) (i32.const 0x5157))
    (i32.store (i32.add (global.get $mb) (i32.const 4)) (local.get $fd))
    (i32.store (local.get $ret) (i32.const 11))
    (i32.const 0))

  ;; wasi_snapshot_preview1.fd_seek(fd, offset i64, whence, newoffset_ptr)
  ;; Stores offset+1 so the guest can prove the full 64 bits survived the call.
  (func (export "fd_seek")
        (param $fd i32) (param $off i64) (param $whence i32) (param $ret i32)
        (result i32)
    (i64.store (local.get $ret) (i64.add (local.get $off) (i64.const 1)))
    (i32.const 0))

  ;; Host readback: what landed in the module's own region.
  (func (export "region_tag") (result i32)
    (i32.load (i32.add (global.get $mb) (i32.const 0))))
  (func (export "region_fd") (result i32)
    (i32.load (i32.add (global.get $mb) (i32.const 4))))
  (func (export "memory_base") (result i32) (global.get $mb))
  (func (export "stack_pointer") (result i32) (global.get $sp))

  ;; Touch the top and bottom of the region the host says it reserved, so a
  ;; placement that is not actually backed shows up as a trap, not silence.
  (func (export "probe_region") (param $bytes i32) (result i32)
    (i32.store (i32.add (global.get $mb) (i32.const 0)) (i32.const 0x5157))
    (i32.store
      (i32.add (global.get $mb) (i32.sub (local.get $bytes) (i32.const 4)))
      (i32.const 0x454e44))
    (i32.load
      (i32.add (global.get $mb) (i32.sub (local.get $bytes) (i32.const 4))))))
