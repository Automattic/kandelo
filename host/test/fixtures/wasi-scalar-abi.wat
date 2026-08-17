;; WASI scalar-ABI regression for channel syscalls carrying i64 values.
;;
;; The file remains tiny: the large value is only a seek cursor, not an
;; allocation. This proves a position above JavaScript's safe-integer limit
;; crosses the real process/kernel channel and returns unchanged.
;;
;; Build: wat2wasm --enable-threads wasi-scalar-abi.wat -o wasi-scalar-abi.wasm

(module
  (import "env" "memory" (memory 1 16384 shared))

  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open
      (param i32 i32 i32 i32 i32 i64 i64 i32 i32)
      (result i32)))
  (import "wasi_snapshot_preview1" "fd_allocate"
    (func $fd_allocate (param i32 i64 i64) (result i32)))
  (import "wasi_snapshot_preview1" "fd_filestat_set_size"
    (func $fd_filestat_set_size (param i32 i64) (result i32)))
  (import "wasi_snapshot_preview1" "fd_seek"
    (func $fd_seek (param i32 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_tell"
    (func $fd_tell (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (data (i32.const 1024) "tmp/wasi-scalar-offset.tmp")

  (func $require_success (param $errno i32) (param $exit_code i32)
    (if (local.get $errno)
      (then (call $proc_exit (local.get $exit_code)))))

  (func $require_i64 (param $actual i64) (param $expected i64) (param $exit_code i32)
    (if (i64.ne (local.get $actual) (local.get $expected))
      (then (call $proc_exit (local.get $exit_code)))))

  (func $start (export "_start")
    (local $fd i32)

    ;; Open /tmp/wasi-scalar-offset.tmp via preopen fd 3. O_CREAT|O_TRUNC = 9.
    (call $require_success
      (call $path_open
        (i32.const 3)
        (i32.const 0)
        (i32.const 1024)
        (i32.const 26)
        (i32.const 9)
        (i64.const 0)
        (i64.const 0)
        (i32.const 0)
        (i32.const 0))
      (i32.const 10))
    (local.set $fd (i32.load (i32.const 0)))

    ;; Ftruncate carries its size in one exact i64 channel slot.
    (call $require_success
      (call $fd_filestat_set_size (local.get $fd) (i64.const 4))
      (i32.const 11))

    ;; Fallocate's Linux-compatible channel ABI includes a zero mode slot.
    ;; Keep the requested range inside the existing file so this remains a
    ;; metadata-only channel check on every host backend.
    (call $require_success
      (call $fd_allocate (local.get $fd) (i64.const 1) (i64.const 1))
      (i32.const 12))

    (call $require_success
      (call $fd_seek (local.get $fd) (i64.const 0) (i32.const 2) (i32.const 8))
      (i32.const 13))
    (call $require_i64
      (i64.load (i32.const 8))
      (i64.const 4)
      (i32.const 14))

    ;; 2^53 + 1 must not round through a JavaScript Number.
    (call $require_success
      (call $fd_seek
        (local.get $fd)
        (i64.const 9007199254740993)
        (i32.const 0)
        (i32.const 8))
      (i32.const 15))
    (call $require_i64
      (i64.load (i32.const 8))
      (i64.const 9007199254740993)
      (i32.const 16))
    (call $require_success
      (call $fd_tell (local.get $fd) (i32.const 16))
      (i32.const 17))
    (call $require_i64
      (i64.load (i32.const 16))
      (i64.const 9007199254740993)
      (i32.const 18))

    ;; A negative SEEK_CUR offset must sign-extend the high lseek word.
    (call $require_success
      (call $fd_seek (local.get $fd) (i64.const -1) (i32.const 1) (i32.const 8))
      (i32.const 19))
    (call $require_i64
      (i64.load (i32.const 8))
      (i64.const 9007199254740992)
      (i32.const 20))

    (call $require_success
      (call $fd_close (local.get $fd))
      (i32.const 21))
    (call $proc_exit (i32.const 0))
  )
)
