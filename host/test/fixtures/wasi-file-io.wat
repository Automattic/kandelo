;; WASI file I/O against a REAL file through the real kernel.
;;
;; The three fixtures that predate this one cover fd_write to stdout,
;; args_get, and i64 scalar fidelity. None of them opens a file, so
;; `path_open`, `fd_read`, `fd_seek` and `fd_tell` against real storage have
;; never been exercised end to end -- which is exactly the coverage K10 needs
;; before anything is allowed to replace the shim.
;;
;; The program:
;;   1. path_open("tmp/k10-file-io.txt", O_CREAT|O_TRUNC) relative to the "/"
;;      preopen, so it also exercises the shim's path resolution
;;   2. fd_write "abcdefghij"
;;   3. fd_close
;;   4. path_open the same path again
;;   5. fd_read 4 bytes, print them          -> "abcd"
;;   6. fd_tell, print the offset as a digit -> "4"
;;   7. fd_seek(+2, SEEK_CUR), fd_read 3     -> "ghi"
;;   8. fd_close, proc_exit(0)
;;
;; Expected stdout: "abcd4ghi\n"
;;
;; A failing call prints "E<site><errno>" and exits 1 -- for example "EA44"
;; means "the first path_open returned WASI ENOENT". A bare marker would say
;; only that something went wrong; naming the call site and the errno is the
;; difference between a usable failure and a puzzle.
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
  ;; 128  "E"      136 "\n"
  ;; 256  path     512 the bytes written
  ;; 1024 read buffer
  ;; 2000..2002 the failure report scratch
  (data (i32.const 128) "E")
  (data (i32.const 136) "\n")
  (data (i32.const 256) "tmp/k10-file-io.txt")
  (data (i32.const 512) "abcdefghij")

  (func $puts (param $ptr i32) (param $len i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 16))))

  ;; Print "E<site><errno>\n" and exit 1.
  (func $die (param $site i32) (param $rc i32)
    (call $puts (i32.const 128) (i32.const 1))
    (i32.store8 (i32.const 2000) (local.get $site))
    (call $puts (i32.const 2000) (i32.const 1))
    (if (i32.ge_u (local.get $rc) (i32.const 10))
      (then
        (i32.store8 (i32.const 2001)
          (i32.add (i32.const 48) (i32.div_u (local.get $rc) (i32.const 10))))
        (call $puts (i32.const 2001) (i32.const 1))))
    (i32.store8 (i32.const 2002)
      (i32.add (i32.const 48) (i32.rem_u (local.get $rc) (i32.const 10))))
    (call $puts (i32.const 2002) (i32.const 1))
    (call $puts (i32.const 136) (i32.const 1))
    (call $proc_exit (i32.const 1)))

  (func $start (export "_start")
    (local $fd i32)
    (local $rc i32)

    ;; --- create and write -------------------------------------------------
    (local.set $rc (call $path_open
      (i32.const 3)      ;; the "/" preopen
      (i32.const 1)      ;; lookupflags: SYMLINK_FOLLOW
      (i32.const 256) (i32.const 19)
      (i32.const 9)      ;; oflags: O_CREAT | O_TRUNC
      (i64.const 0) (i64.const 0)
      (i32.const 0)      ;; fdflags
      (i32.const 32)))   ;; opened fd out
    (if (local.get $rc) (then (call $die (i32.const 65) (local.get $rc))))  ;; A
    (local.set $fd (i32.load (i32.const 32)))

    (i32.store (i32.const 0) (i32.const 512))
    (i32.store (i32.const 4) (i32.const 10))
    (local.set $rc
      (call $fd_write (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 16)))
    (if (local.get $rc) (then (call $die (i32.const 66) (local.get $rc))))  ;; B
    (if (i32.ne (i32.load (i32.const 16)) (i32.const 10))
      (then (call $die (i32.const 67) (i32.load (i32.const 16)))))          ;; C

    (local.set $rc (call $fd_close (local.get $fd)))
    (if (local.get $rc) (then (call $die (i32.const 68) (local.get $rc))))  ;; D

    ;; --- reopen and read --------------------------------------------------
    (local.set $rc (call $path_open
      (i32.const 3) (i32.const 1) (i32.const 256) (i32.const 19)
      (i32.const 0)      ;; open the existing file
      (i64.const 0) (i64.const 0) (i32.const 0) (i32.const 32)))
    (if (local.get $rc) (then (call $die (i32.const 69) (local.get $rc))))  ;; E
    (local.set $fd (i32.load (i32.const 32)))

    (i32.store (i32.const 0) (i32.const 1024))
    (i32.store (i32.const 4) (i32.const 4))
    (local.set $rc
      (call $fd_read (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 16)))
    (if (local.get $rc) (then (call $die (i32.const 70) (local.get $rc))))  ;; F
    (if (i32.ne (i32.load (i32.const 16)) (i32.const 4))
      (then (call $die (i32.const 71) (i32.load (i32.const 16)))))          ;; G
    (call $puts (i32.const 1024) (i32.const 4))       ;; "abcd"

    ;; --- fd_tell ----------------------------------------------------------
    (local.set $rc (call $fd_tell (local.get $fd) (i32.const 64)))
    (if (local.get $rc) (then (call $die (i32.const 72) (local.get $rc))))  ;; H
    (if (i64.ne (i64.load (i32.const 64)) (i64.const 4))
      (then (call $die (i32.const 73) (i32.wrap_i64 (i64.load (i32.const 64))))))  ;; I
    (i32.store8 (i32.const 1100)
      (i32.add (i32.const 48) (i32.wrap_i64 (i64.load (i32.const 64)))))
    (call $puts (i32.const 1100) (i32.const 1))       ;; "4"

    ;; --- relative seek ----------------------------------------------------
    (local.set $rc
      (call $fd_seek (local.get $fd) (i64.const 2) (i32.const 1) (i32.const 64)))
    (if (local.get $rc) (then (call $die (i32.const 74) (local.get $rc))))  ;; J
    (if (i64.ne (i64.load (i32.const 64)) (i64.const 6))
      (then (call $die (i32.const 75) (i32.wrap_i64 (i64.load (i32.const 64))))))  ;; K

    (i32.store (i32.const 0) (i32.const 1024))
    (i32.store (i32.const 4) (i32.const 3))
    (local.set $rc
      (call $fd_read (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 16)))
    (if (local.get $rc) (then (call $die (i32.const 76) (local.get $rc))))  ;; L
    (if (i32.ne (i32.load (i32.const 16)) (i32.const 3))
      (then (call $die (i32.const 77) (i32.load (i32.const 16)))))          ;; M
    (call $puts (i32.const 1024) (i32.const 3))       ;; "ghi"

    (local.set $rc (call $fd_close (local.get $fd)))
    (if (local.get $rc) (then (call $die (i32.const 78) (local.get $rc))))  ;; N

    (call $puts (i32.const 136) (i32.const 1))        ;; "\n"
    (call $proc_exit (i32.const 0))))
