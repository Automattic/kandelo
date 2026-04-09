;; Minimal WASI hello world that imports memory.
;; Writes "Hello from WASI\n" to fd 1 (stdout) via fd_write.
;;
;; Build: wat2wasm --enable-threads wasi-hello.wat -o wasi-hello.wasm

(module
  ;; Import shared memory from env (--import-memory pattern)
  (import "env" "memory" (memory 1 16384 shared))

  ;; Import fd_write from wasi_snapshot_preview1
  ;; fd_write(fd: i32, iovs: i32, iovs_len: i32, nwritten: i32) -> i32
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))

  ;; Import proc_exit from wasi_snapshot_preview1
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  ;; Data: "Hello from WASI\n" at offset 1024
  (data (i32.const 1024) "Hello from WASI\n")

  ;; _start function
  (func $start (export "_start")
    ;; Set up iovec at address 0:
    ;;   iov_base (i32) = 1024 (address of string)
    ;;   iov_len  (i32) = 16   (length of string)

    ;; iov_base = 1024
    (i32.store (i32.const 0) (i32.const 1024))
    ;; iov_len = 16
    (i32.store (i32.const 4) (i32.const 16))

    ;; Call fd_write(fd=1, iovs=0, iovs_len=1, nwritten=8)
    (call $fd_write
      (i32.const 1)   ;; fd = stdout
      (i32.const 0)   ;; iovs pointer
      (i32.const 1)   ;; iovs count
      (i32.const 8))  ;; nwritten output pointer
    drop

    ;; Exit with code 0
    (call $proc_exit (i32.const 0))
  )
)
