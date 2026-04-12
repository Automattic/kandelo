;; WASI program that prints its first argument via fd_write.
;; Tests args_sizes_get + args_get + fd_write.
;;
;; Build: wat2wasm --enable-threads --enable-memory64 wasi-args.wat -o wasi-args.wasm

(module
  (import "env" "memory" (memory i64 1 16384 shared))

  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_sizes_get"
    (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get"
    (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  ;; Layout (wasm64: iovec is 16 bytes = i64 base + i64 len):
  ;;   0-3:    argc output (i32)
  ;;   4-7:    argv_buf_size output (i32)
  ;;   8-11:   nwritten output (i32)
  ;;   32-63:  iovec (16 bytes: i64 base + i64 len)
  ;;   64-127: argv pointers (up to 16 args, 4 bytes each — shim writes i32)
  ;;   256+:   argv string buffer

  (func $start (export "_start")
    (local $argc i32)
    (local $buf_size i32)
    (local $arg1_ptr i32)
    (local $arg1_len i32)

    ;; Get sizes
    (call $args_sizes_get (i32.const 0) (i32.const 4))
    drop

    (local.set $argc (i32.load (i64.const 0)))
    (local.set $buf_size (i32.load (i64.const 4)))

    ;; If argc < 2, exit
    (if (i32.lt_u (local.get $argc) (i32.const 2))
      (then
        (call $proc_exit (i32.const 1))
      )
    )

    ;; Get args: argv ptrs at 64, argv buf at 256
    (call $args_get (i32.const 64) (i32.const 256))
    drop

    ;; arg1 pointer is at offset 64+4 = 68
    (local.set $arg1_ptr (i32.load (i64.const 68)))

    ;; Find length of arg1 by scanning for null byte
    (local.set $arg1_len (i32.const 0))
    (block $done
      (loop $scan
        (br_if $done (i32.eqz (i32.load8_u (i64.extend_i32_u (i32.add (local.get $arg1_ptr) (local.get $arg1_len))))))
        (local.set $arg1_len (i32.add (local.get $arg1_len) (i32.const 1)))
        (br $scan)
      )
    )

    ;; Set up iovec at 32: base=arg1_ptr (i64), len=arg1_len (i64)
    (i64.store (i64.const 32) (i64.extend_i32_u (local.get $arg1_ptr)))
    (i64.store (i64.const 40) (i64.extend_i32_u (local.get $arg1_len)))

    ;; fd_write(1, iovec@32, 1, nwritten@8)
    (call $fd_write (i32.const 1) (i32.const 32) (i32.const 1) (i32.const 8))
    drop

    ;; Write newline
    ;; Put "\n" at address 512
    (i32.store8 (i64.const 512) (i32.const 10))
    ;; iovec at 32: base=512, len=1
    (i64.store (i64.const 32) (i64.const 512))
    (i64.store (i64.const 40) (i64.const 1))
    (call $fd_write (i32.const 1) (i32.const 32) (i32.const 1) (i32.const 8))
    drop

    (call $proc_exit (i32.const 0))
  )
)
