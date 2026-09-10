;; WASI file I/O against a REAL file through the real kernel.
;;
;; The three fixtures that predate this one cover fd_write to stdout,
;; args_get, and i64 scalar fidelity. None of them opens a file, so
;; `path_open`, `fd_read`, `fd_seek` and `fd_tell` against real storage have
;; never been exercised end to end -- which is exactly the coverage K10 needs
;; before anything is allowed to replace the shim.
;;
;; The program:
;;   1. path_open("k10-file-io.txt", O_CREAT|O_TRUNC) relative to the "/"
;;      preopen, so it also exercises the shim's path resolution
;;   2. fd_write "abcdefghij"
;;   3. fd_close
;;   4. path_open the same path read-only
;;   5. fd_read 4 bytes, print them        -> "abcd"
;;   6. fd_tell, print the offset as a digit -> "4"
;;   7. fd_seek(+2, SEEK_CUR), fd_read 3, print -> "ghi"
;;   8. fd_close, proc_exit(0)
;;
;; Expected stdout: "abcd4ghi\n"
;;
;; Any failing call prints "E" and exits non-zero, so a regression shows up as
;; a wrong exit code AND a distinguishable stdout rather than a silent pass.
;;
;; Build: wat2wasm --enable-threads wasi-file-io.wat -o wasi-file-io.wasm

(module
  (import "env" "memory" (memory 1 16384 shared))

  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open
      (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_seek"
    (func $fd_seek (param i32 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_tell"
    (func $fd_tell (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  ;; 0    iovec (base, len)
  ;; 16   nread / nwritten
  ;; 32   opened fd
  ;; 64   fd_tell / fd_seek result (u64)
  ;; 128  "E"
  ;; 136  "\n"
  ;; 256  path
  ;; 512  the bytes written
  ;; 1024 the read buffer
  (data (i32.const 128) "E")
  (data (i32.const 136) "\n")
  (data (i32.const 256) "k10-file-io.txt")
  (data (i32.const 512) "abcdefghij")

  ;; Write `len` bytes at `ptr` to fd 1.
  (func $puts (param $ptr i32) (param $len i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 16))))

  ;; Print "E" and exit 1.
  (func $die
    (call $puts (i32.const 128) (i32.const 1))
    (call $proc_exit (i32.const 1)))

  (func $start (export "_start")
    (local $fd i32)
    (local $n i32)

    ;; --- create and write -------------------------------------------------
    ;; oflags: O_CREAT(1) | O_TRUNC(8) = 9
    (if (call $path_open
          (i32.const 3)      ;; the "/" preopen
          (i32.const 1)      ;; lookupflags: SYMLINK_FOLLOW
          (i32.const 256)    ;; path
          (i32.const 15)     ;; path length
          (i32.const 9)      ;; oflags: CREAT | TRUNC
          (i64.const 0)      ;; fs_rights_base (Kandelo does not model rights)
          (i64.const 0)      ;; fs_rights_inheriting
          (i32.const 0)      ;; fdflags
          (i32.const 32))    ;; opened fd out
      (then (call $die)))
    (local.set $fd (i32.load (i32.const 32)))

    (i32.store (i32.const 0) (i32.const 512))
    (i32.store (i32.const 4) (i32.const 10))
    (if (call $fd_write (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 16))
      (then (call $die)))
    (if (i32.ne (i32.load (i32.const 16)) (i32.const 10))
      (then (call $die)))
    (if (call $fd_close (local.get $fd))
      (then (call $die)))

    ;; --- reopen and read --------------------------------------------------
    (if (call $path_open
          (i32.const 3) (i32.const 1) (i32.const 256) (i32.const 15)
          (i32.const 0)      ;; no oflags: open the existing file
          (i64.const 0) (i64.const 0) (i32.const 0) (i32.const 32))
      (then (call $die)))
    (local.set $fd (i32.load (i32.const 32)))

    (i32.store (i32.const 0) (i32.const 1024))
    (i32.store (i32.const 4) (i32.const 4))
    (if (call $fd_read (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 16))
      (then (call $die)))
    (local.set $n (i32.load (i32.const 16)))
    (if (i32.ne (local.get $n) (i32.const 4))
      (then (call $die)))
    (call $puts (i32.const 1024) (i32.const 4))   ;; expect "abcd"

    ;; --- fd_tell ----------------------------------------------------------
    (if (call $fd_tell (local.get $fd) (i32.const 64))
      (then (call $die)))
    ;; Print the offset as a single ASCII digit. It must be 4.
    (i32.store8 (i32.const 1100)
      (i32.add (i32.const 48) (i32.wrap_i64 (i64.load (i32.const 64)))))
    (call $puts (i32.const 1100) (i32.const 1))   ;; expect "4"

    ;; --- fd_seek relative -------------------------------------------------
    ;; +2 from the current position (4) lands on index 6 -> "ghi"
    (if (call $fd_seek
          (local.get $fd) (i64.const 2) (i32.const 1) (i32.const 64))
      (then (call $die)))
    (if (i64.ne (i64.load (i32.const 64)) (i64.const 6))
      (then (call $die)))

    (i32.store (i32.const 0) (i32.const 1024))
    (i32.store (i32.const 4) (i32.const 3))
    (if (call $fd_read (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 16))
      (then (call $die)))
    (if (i32.ne (i32.load (i32.const 16)) (i32.const 3))
      (then (call $die)))
    (call $puts (i32.const 1024) (i32.const 3))   ;; expect "ghi"

    (if (call $fd_close (local.get $fd))
      (then (call $die)))

    (call $puts (i32.const 136) (i32.const 1))    ;; "\n"
    (call $proc_exit (i32.const 0))))
