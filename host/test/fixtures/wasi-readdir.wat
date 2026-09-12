;; WASI directory reading against a REAL directory through the real kernel.
;;
;; `fd_readdir` has never had a fixture, and it is where K10's defect 5 lives:
;; the TypeScript shim issues a fresh `getdents64` on every call and then skips
;; `cookie` entries of whatever came back -- but `getdents64` has already
;; advanced the directory fd, so a resumed read returns the NEXT batch and
;; discards entries from it. Anything past one batch is silently lost.
;;
;; This fixture stays deliberately inside the single-batch case, which is what
;; the TypeScript gets right, so it is a clean regression baseline for BOTH
;; implementations. The multi-batch case that separates them is pinned in
;; Rust, where the batch size can be controlled
;; (`crates/wasi-module/tests/entry_points.rs`, `defect_5_*`).
;;
;; The program:
;;   1. path_create_directory("tmp/k10-readdir")
;;   2. create two files inside it
;;   3. path_open the directory (O_DIRECTORY)
;;   4. fd_readdir into a buffer
;;   5. print one ASCII digit: how many entries were returned whose name
;;      length is 5 ("alpha" and "bravo"); "." and ".." have length 1 and 2
;;      and are skipped, so the answer is stable regardless of whether the
;;      kernel reports them.
;;
;; Expected stdout: "2\n"
;;
;; Build: wat2wasm --enable-threads wasi-readdir.wat -o wasi-readdir.wasm

(module
  (import "env" "memory" (memory 1 16384 shared))

  (import "wasi_snapshot_preview1" "path_create_directory"
    (func $mkdir (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open
      (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_readdir"
    (func $fd_readdir (param i32 i32 i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  ;; 0    iovec
  ;; 16   nwritten / bufused
  ;; 32   opened fd
  ;; 128  "E"
  ;; 136  "\n"
  ;; 256  "k10-readdir"
  ;; 320  "k10-readdir/alpha"
  ;; 384  "k10-readdir/bravo"
  ;; 1024 dirent buffer (4 KiB)
  (data (i32.const 128) "E")
  (data (i32.const 136) "\n")
  (data (i32.const 256) "tmp/k10-readdir")
  (data (i32.const 320) "tmp/k10-readdir/alpha")
  (data (i32.const 384) "tmp/k10-readdir/bravo")

  (func $puts (param $ptr i32) (param $len i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 16))))

  (func $die
    (call $puts (i32.const 128) (i32.const 1))
    (call $proc_exit (i32.const 1)))

  ;; Create `path` (length `len`) as an empty file under the "/" preopen.
  (func $touch (param $path i32) (param $len i32)
    (if (call $path_open
          (i32.const 3) (i32.const 1) (local.get $path) (local.get $len)
          (i32.const 9)      ;; O_CREAT | O_TRUNC
          (i64.const 0) (i64.const 0) (i32.const 0) (i32.const 32))
      (then (call $die)))
    (if (call $fd_close (i32.load (i32.const 32)))
      (then (call $die))))

  (func $start (export "_start")
    (local $fd i32)
    (local $used i32)
    (local $off i32)
    (local $namelen i32)
    (local $matches i32)
    (local $rc i32)

    ;; A pre-existing directory from an earlier run is fine; only a failure
    ;; that is NOT "already exists" (WASI EEXIST = 20) is fatal.
    (local.set $rc (call $mkdir (i32.const 3) (i32.const 256) (i32.const 15)))
    (if (i32.and
          (i32.ne (local.get $rc) (i32.const 0))
          (i32.ne (local.get $rc) (i32.const 20)))
      (then (call $die)))

    (call $touch (i32.const 320) (i32.const 21))
    (call $touch (i32.const 384) (i32.const 21))

    ;; Open the directory itself.
    (if (call $path_open
          (i32.const 3) (i32.const 1) (i32.const 256) (i32.const 15)
          (i32.const 2)      ;; O_DIRECTORY
          (i64.const 0) (i64.const 0) (i32.const 0) (i32.const 32))
      (then (call $die)))
    (local.set $fd (i32.load (i32.const 32)))

    (if (call $fd_readdir
          (local.get $fd)
          (i32.const 1024)   ;; buffer
          (i32.const 4096)   ;; buffer length
          (i64.const 0)      ;; cookie: start at the beginning
          (i32.const 16))    ;; bufused out
      (then (call $die)))
    (local.set $used (i32.load (i32.const 16)))
    (if (i32.eqz (local.get $used))
      (then (call $die)))

    ;; Walk the WASI dirents: 24-byte header then the name.
    ;;   0 d_next(u64) 8 d_ino(u64) 16 d_namlen(u32) 20 d_type(u8)+3pad
    (local.set $off (i32.const 0))
    (block $done
      (loop $next
        ;; Stop if a full header does not fit in what was returned.
        (br_if $done
          (i32.gt_u
            (i32.add (local.get $off) (i32.const 24))
            (local.get $used)))
        (local.set $namelen
          (i32.load (i32.add (i32.const 1024)
                             (i32.add (local.get $off) (i32.const 16)))))
        ;; Stop if the name is truncated -- a partial final entry.
        (br_if $done
          (i32.gt_u
            (i32.add (i32.add (local.get $off) (i32.const 24)) (local.get $namelen))
            (local.get $used)))
        (if (i32.eq (local.get $namelen) (i32.const 5))
          (then (local.set $matches (i32.add (local.get $matches) (i32.const 1)))))
        (local.set $off
          (i32.add (local.get $off)
                   (i32.add (i32.const 24) (local.get $namelen))))
        (br $next)))

    (if (call $fd_close (local.get $fd))
      (then (call $die)))

    ;; Print the count as one ASCII digit.
    (i32.store8 (i32.const 2048)
      (i32.add (i32.const 48) (local.get $matches)))
    (call $puts (i32.const 2048) (i32.const 1))
    (call $puts (i32.const 136) (i32.const 1))
    (call $proc_exit (i32.const 0))))
