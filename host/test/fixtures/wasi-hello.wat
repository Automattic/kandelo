;; Minimal WASI hello world that imports memory64.
;; Writes "Hello from WASI\n" to fd 1 (stdout) via fd_write.
;;
;; Build: wat2wasm --enable-threads --enable-memory64 wasi-hello.wat -o wasi-hello.wasm

(module
  ;; Import shared memory64 from env (--import-memory pattern)
  (import "env" "memory" (memory i64 1 16384 shared))

  ;; Import fd_write from wasi_snapshot_preview1
  ;; fd_write(fd: i32, iovs: i32, iovs_len: i32, nwritten: i32) -> i32
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))

  ;; Import proc_exit from wasi_snapshot_preview1
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  ;; Data: "Hello from WASI\n" at offset 1024
  (data (i64.const 1024) "Hello from WASI\n")

  ;; _start function
  (func $start (export "_start")
    ;; Set up iovec at address 0 (16 bytes on wasm64: i64 base + i64 len):
    ;;   iov_base (i64) = 1024 (address of string)
    ;;   iov_len  (i64) = 16   (length of string)

    ;; iov_base = 1024 (at offset 0, 8 bytes)
    (i64.store (i64.const 0) (i64.const 1024))
    ;; iov_len = 16 (at offset 8, 8 bytes)
    (i64.store (i64.const 8) (i64.const 16))

    ;; Call fd_write(fd=1, iovs=0, iovs_len=1, nwritten=32)
    (call $fd_write
      (i32.const 1)    ;; fd = stdout
      (i32.const 0)    ;; iovs pointer
      (i32.const 1)    ;; iovs count
      (i32.const 32))  ;; nwritten output pointer
    drop

    ;; Exit with code 0
    (call $proc_exit (i32.const 0))
  )
)
