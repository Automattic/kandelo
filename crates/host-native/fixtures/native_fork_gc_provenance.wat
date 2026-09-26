;; Wasm-GC objects whose ONLY construction path is their constructor, held
;; across fork() and rebuilt in a fresh child instance by re-running the same
;; allocation instruction (docs/fork-reference-support.md, "Constructor
;; provenance").
;;
;; One source for all three hosts: the native host (crates/host-native,
;; `smoke_fork_gc_provenance_reconstructs`), Node through a real process Worker
;; (host/test/fork-gc-provenance.test.ts) and the browser
;; (apps/browser-demos/test/fork-continuation.spec.ts). It exits through a real
;; SYS_EXIT_GROUP on the main channel, which every host services, and leaves
;; the way musl's `_Exit` does on each host (see $exit_group).
;;
;; The shapes, all live in locals across every fork:
;;
;;   fx   immutable `array i32`, `array.new_fixed 3` [11 22 33]
;;   un   immutable `array i32`, `array.new 5 x4`   (uniform)
;;   df   immutable `array i32`, `array.new_default 2`
;;   d1   immutable `array i8`, `array.new_data $seg 0 4`   [100..103]
;;   d2   immutable `array i8`, `array.new_data $seg 2 4`   [102..105]
;;   d3   the SAME operands as d2 again: equal content, a DIFFERENT object
;;   d4   immutable `array i8`, `array.new_data $seg2 0 4`  [1 2 3 4]
;;   e1   immutable `array (ref $item)`, `array.new_elem $es 1 2` -> items 8, 9
;;   rows immutable `array (ref $bytes)`, `array.new_fixed 2` (d1 d2): nested
;;        references, which must be the SAME objects as d1 and d2
;;   pr   immutable struct `$pair` (fx, 42): must reference the SAME fx
;;   mi   MUTABLE non-null `array (mut (ref $item))`, `array.new_fixed 2`
;;        (70 71), then element 1 replaced by 72
;;
;; Every segment is DROPPED (`data.drop`, `elem.drop`) after the allocations
;; and before the first fork: the parent can no longer run those constructors,
;; the child's fresh instance still can, and must do so before it replays the
;; parent's drops.
;;
;; The parent forks TWICE (the second capture must not reuse the first one's
;; recipe ids), and the first child forks a GRANDCHILD (a replayed object must
;; itself be a capturable parent).
;;
;; Exit codes (the parent propagates a child's nonzero status):
;;   0      every check passed everywhere
;;   1..19  FIRST CHILD: check N failed (see $verify)
;;   21..39 GRANDCHILD: check N-20 failed
;;   41..59 SECOND CHILD: check N-40 failed
;;   61..79 PARENT after the forks: check N-60 failed
;;   90     a fork() returned a negative errno in the parent
;;   91     a fork() returned a negative errno in the first child
;;   92     wait4 did not reap the expected child
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))

  (type $item (struct (field i32)))
  (type $scalars (array i32))
  (type $bytes (array i8))
  (type $items (array (ref $item)))
  (type $rows (array (ref $bytes)))
  (type $pair (struct (field (ref $scalars)) (field i32)))
  (type $mitems (array (mut (ref $item))))

  (data $seg "\64\65\66\67\68\69")
  (data $seg2 "\01\02\03\04")
  (elem $es (ref $item)
    (item (struct.new $item (i32.const 7)))
    (item (struct.new $item (i32.const 8)))
    (item (struct.new $item (i32.const 9))))

  (global $__stack_pointer (export "__stack_pointer") (mut i32)
    (i32.const 65536))
  ;; Required for process admission on Node and the browser; this fixture
  ;; never allocates linear memory.
  (global (export "__heap_base") i32 (i32.const 65536))

  (func (export "__abi_version") (result i32)
    i32.const 44)

  ;; One raw syscall on the main channel: number, one argument.
  (func $syscall1 (param $nr i32) (param $a0 i64) (param $a1 i64) (result i64)
    (local $base i32)
    global.get $__channel_base
    local.set $base
    (i32.store offset=4 (local.get $base) (local.get $nr))
    (i64.store offset=8 (local.get $base) (local.get $a0))
    (i64.store offset=16 (local.get $base) (local.get $a1))
    (i64.store offset=24 (local.get $base) (i64.const 0))
    (i64.store offset=32 (local.get $base) (i64.const 0))
    (i64.store offset=40 (local.get $base) (i64.const 0))
    (i64.store offset=48 (local.get $base) (i64.const 0))
    (i32.atomic.store (local.get $base) (i32.const 1))
    (drop (memory.atomic.notify (local.get $base) (i32.const 1)))
    (block $complete
      (loop $wait
        (br_if $complete
          (i32.ne (i32.atomic.load (local.get $base)) (i32.const 1)))
        (drop (memory.atomic.wait32 (local.get $base) (i32.const 1) (i64.const -1)))
        (br $wait)))
    (if (result i64) (i32.load offset=64 (local.get $base))
      (then
        (i32.atomic.store (local.get $base) (i32.const 0))
        (i64.extend_i32_s (i32.sub (i32.const 0) (i32.load offset=64 (local.get $base)))))
      (else
        (i64.load offset=56 (local.get $base))
        (i32.atomic.store (local.get $base) (i32.const 0)))))

  ;; SYS_EXIT_GROUP, then what musl's `_Exit` does after it. The native host
  ;; answers the exit by publishing TEARDOWN (4) on the channel and reads the
  ;; trap that follows as the unwind (see native_fork_gc_array_cycle.wat's
  ;; $exit_group). The JavaScript hosts COMPLETE the syscall instead, and the
  ;; libc glue then leaves through `kernel.kernel_exit`, which records the
  ;; status and unwinds the worker's entry; trapping there would be reported
  ;; as a worker failure.
  (func $exit_group (param $code i32)
    (local $base i32)
    global.get $__channel_base
    local.set $base
    (i32.store offset=4 (local.get $base) (i32.const 387))
    (i64.store offset=8 (local.get $base) (i64.extend_i32_s (local.get $code)))
    (i64.store offset=16 (local.get $base) (i64.const 0))
    (i64.store offset=24 (local.get $base) (i64.const 0))
    (i64.store offset=32 (local.get $base) (i64.const 0))
    (i64.store offset=40 (local.get $base) (i64.const 0))
    (i64.store offset=48 (local.get $base) (i64.const 0))
    (i32.atomic.store (local.get $base) (i32.const 1))
    (drop (memory.atomic.notify (local.get $base) (i32.const 1)))
    (loop $park
      (drop (memory.atomic.wait32 (local.get $base) (i32.const 1) (i64.const -1)))
      (br_if $park (i32.eq (i32.atomic.load (local.get $base)) (i32.const 1))))
    (if (i32.eq (i32.atomic.load (local.get $base)) (i32.const 4))
      (then unreachable))
    (call $kernel_exit (local.get $code))
    unreachable)

  ;; Reap `$pid` (SYS_wait4 = 139, status word at 1024). Exits 92 if the reap
  ;; failed, or with the child's own exit code if it was nonzero.
  (func $reap (param $pid i32)
    (local $status i32)
    (i32.store (i32.const 1024) (i32.const -1))
    (if (i64.ne
          (call $syscall1 (i32.const 139) (i64.extend_i32_s (local.get $pid)) (i64.const 1024))
          (i64.extend_i32_s (local.get $pid)))
      (then (call $exit_group (i32.const 92))))
    (local.set $status (i32.load (i32.const 1024)))
    ;; Anything but a normal exit (a signal, a trap) is a failed reap.
    (if (i32.and (local.get $status) (i32.const 0x7f))
      (then (call $exit_group (i32.const 92))))
    (if (i32.and (i32.shr_u (local.get $status) (i32.const 8)) (i32.const 0xff))
      (then
        (call $exit_group
          (i32.and (i32.shr_u (local.get $status) (i32.const 8)) (i32.const 0xff))))))

  (func $bytes_are (param $a (ref $bytes)) (param $b0 i32) (result i32)
    ;; 1 when `$a` is 4 bytes b0, b0+1, b0+2, b0+3.
    (local $i i32)
    (if (i32.ne (array.len (local.get $a)) (i32.const 4)) (then (return (i32.const 0))))
    (block $done
      (loop $each
        (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
        (if (i32.ne (array.get_u $bytes (local.get $a) (local.get $i))
                    (i32.add (local.get $b0) (local.get $i)))
          (then (return (i32.const 0))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $each)))
    i32.const 1)

  ;; 0 when every object checks out, else the number of the first failed check.
  (func $verify
    (param $fx (ref null $scalars)) (param $un (ref null $scalars))
    (param $df (ref null $scalars))
    (param $d1 (ref null $bytes)) (param $d2 (ref null $bytes))
    (param $d3 (ref null $bytes)) (param $d4 (ref null $bytes))
    (param $e1 (ref null $items)) (param $rows (ref null $rows))
    (param $pr (ref null $pair)) (param $mi (ref null $mitems))
    (result i32)
    (local $i i32)
    ;; 1: fx is [11 22 33]
    (if (i32.or
          (i32.ne (array.len (ref.as_non_null (local.get $fx))) (i32.const 3))
          (i32.or
            (i32.ne (array.get $scalars (local.get $fx) (i32.const 0)) (i32.const 11))
            (i32.or
              (i32.ne (array.get $scalars (local.get $fx) (i32.const 1)) (i32.const 22))
              (i32.ne (array.get $scalars (local.get $fx) (i32.const 2)) (i32.const 33)))))
      (then (return (i32.const 1))))
    ;; 2: un is [5 5 5 5]
    (if (i32.ne (array.len (ref.as_non_null (local.get $un))) (i32.const 4))
      (then (return (i32.const 2))))
    (local.set $i (i32.const 0))
    (block $done
      (loop $each
        (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
        (if (i32.ne (array.get $scalars (local.get $un) (local.get $i)) (i32.const 5))
          (then (return (i32.const 2))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $each)))
    ;; 3: df is [0 0]
    (if (i32.or
          (i32.ne (array.len (ref.as_non_null (local.get $df))) (i32.const 2))
          (i32.or
            (array.get $scalars (local.get $df) (i32.const 0))
            (array.get $scalars (local.get $df) (i32.const 1))))
      (then (return (i32.const 3))))
    ;; 4..7: the array.new_data arrays hold their segment slices
    (if (i32.eqz (call $bytes_are (ref.as_non_null (local.get $d1)) (i32.const 100)))
      (then (return (i32.const 4))))
    (if (i32.eqz (call $bytes_are (ref.as_non_null (local.get $d2)) (i32.const 102)))
      (then (return (i32.const 5))))
    (if (i32.eqz (call $bytes_are (ref.as_non_null (local.get $d3)) (i32.const 102)))
      (then (return (i32.const 6))))
    (if (i32.eqz (call $bytes_are (ref.as_non_null (local.get $d4)) (i32.const 1)))
      (then (return (i32.const 7))))
    ;; 8: equal operands made two objects, and still do
    (if (ref.eq (local.get $d2) (local.get $d3)) (then (return (i32.const 8))))
    ;; 9: e1 is the segment's items 8 and 9
    (if (i32.or
          (i32.ne (array.len (ref.as_non_null (local.get $e1))) (i32.const 2))
          (i32.or
            (i32.ne (struct.get $item 0 (array.get $items (local.get $e1) (i32.const 0)))
                    (i32.const 8))
            (i32.ne (struct.get $item 0 (array.get $items (local.get $e1) (i32.const 1)))
                    (i32.const 9))))
      (then (return (i32.const 9))))
    ;; 10: rows holds THE d1 and d2, not copies
    (if (i32.or
          (i32.ne (array.len (ref.as_non_null (local.get $rows))) (i32.const 2))
          (i32.or
            (i32.eqz (ref.eq (array.get $rows (local.get $rows) (i32.const 0)) (local.get $d1)))
            (i32.eqz (ref.eq (array.get $rows (local.get $rows) (i32.const 1)) (local.get $d2)))))
      (then (return (i32.const 10))))
    ;; 11: pr holds THE fx, and 42
    (if (i32.or
          (i32.eqz (ref.eq (struct.get $pair 0 (local.get $pr)) (local.get $fx)))
          (i32.ne (struct.get $pair 1 (local.get $pr)) (i32.const 42)))
      (then (return (i32.const 11))))
    ;; 12: mi is items 70 and 72 (element 1 was replaced after construction)
    (if (i32.or
          (i32.ne (array.len (ref.as_non_null (local.get $mi))) (i32.const 2))
          (i32.or
            (i32.ne (struct.get $item 0 (array.get $mitems (local.get $mi) (i32.const 0)))
                    (i32.const 70))
            (i32.ne (struct.get $item 0 (array.get $mitems (local.get $mi) (i32.const 1)))
                    (i32.const 72))))
      (then (return (i32.const 12))))
    i32.const 0)

  (func $test
    (local $fx (ref null $scalars)) (local $un (ref null $scalars))
    (local $df (ref null $scalars))
    (local $d1 (ref null $bytes)) (local $d2 (ref null $bytes))
    (local $d3 (ref null $bytes)) (local $d4 (ref null $bytes))
    (local $e1 (ref null $items)) (local $rows (ref null $rows))
    (local $pr (ref null $pair)) (local $mi (ref null $mitems))
    (local $pid i32) (local $code i32)

    (local.set $fx (array.new_fixed $scalars 3 (i32.const 11) (i32.const 22) (i32.const 33)))
    (local.set $un (array.new $scalars (i32.const 5) (i32.const 4)))
    (local.set $df (array.new_default $scalars (i32.const 2)))
    (local.set $d1 (array.new_data $bytes $seg (i32.const 0) (i32.const 4)))
    (local.set $d2 (array.new_data $bytes $seg (i32.const 2) (i32.const 4)))
    (local.set $d3 (array.new_data $bytes $seg (i32.const 2) (i32.const 4)))
    (local.set $d4 (array.new_data $bytes $seg2 (i32.const 0) (i32.const 4)))
    (local.set $e1 (array.new_elem $items $es (i32.const 1) (i32.const 2)))
    (local.set $rows
      (array.new_fixed $rows 2 (ref.as_non_null (local.get $d1)) (ref.as_non_null (local.get $d2))))
    (local.set $pr (struct.new $pair (ref.as_non_null (local.get $fx)) (i32.const 42)))
    (local.set $mi
      (array.new_fixed $mitems 2
        (struct.new $item (i32.const 70)) (struct.new $item (i32.const 71))))
    (array.set $mitems (local.get $mi) (i32.const 1) (struct.new $item (i32.const 72)))

    ;; The parent can no longer run any of the segment constructors.
    data.drop $seg
    data.drop $seg2
    elem.drop $es

    ;; ---- first fork ----
    (local.set $pid (call $kernel_fork (i32.const 0)))
    (if (i32.lt_s (local.get $pid) (i32.const 0)) (then (call $exit_group (i32.const 90))))
    (if (i32.eqz (local.get $pid))
      (then
        (local.set $code
          (call $verify (local.get $fx) (local.get $un) (local.get $df)
            (local.get $d1) (local.get $d2) (local.get $d3) (local.get $d4)
            (local.get $e1) (local.get $rows) (local.get $pr) (local.get $mi)))
        (if (local.get $code) (then (call $exit_group (local.get $code))))
        ;; The child is itself a parent: fork a grandchild from replayed state.
        (local.set $pid (call $kernel_fork (i32.const 0)))
        (if (i32.lt_s (local.get $pid) (i32.const 0)) (then (call $exit_group (i32.const 91))))
        (if (i32.eqz (local.get $pid))
          (then
            (local.set $code
              (call $verify (local.get $fx) (local.get $un) (local.get $df)
                (local.get $d1) (local.get $d2) (local.get $d3) (local.get $d4)
                (local.get $e1) (local.get $rows) (local.get $pr) (local.get $mi)))
            (if (local.get $code)
              (then (call $exit_group (i32.add (local.get $code) (i32.const 20)))))
            (call $exit_group (i32.const 0))))
        (call $reap (local.get $pid))
        (call $exit_group (i32.const 0))))
    (call $reap (local.get $pid))

    ;; ---- second fork, from the same parent ----
    (local.set $pid (call $kernel_fork (i32.const 0)))
    (if (i32.lt_s (local.get $pid) (i32.const 0)) (then (call $exit_group (i32.const 90))))
    (if (i32.eqz (local.get $pid))
      (then
        (local.set $code
          (call $verify (local.get $fx) (local.get $un) (local.get $df)
            (local.get $d1) (local.get $d2) (local.get $d3) (local.get $d4)
            (local.get $e1) (local.get $rows) (local.get $pr) (local.get $mi)))
        (if (local.get $code)
          (then (call $exit_group (i32.add (local.get $code) (i32.const 40)))))
        (call $exit_group (i32.const 0))))
    (call $reap (local.get $pid))

    ;; ---- the parent's own objects are untouched ----
    (local.set $code
      (call $verify (local.get $fx) (local.get $un) (local.get $df)
        (local.get $d1) (local.get $d2) (local.get $d3) (local.get $d4)
        (local.get $e1) (local.get $rows) (local.get $pr) (local.get $mi)))
    (if (local.get $code)
      (then (call $exit_group (i32.add (local.get $code) (i32.const 60))))))

  (func (export "_start")
    call $test
    (call $exit_group (i32.const 0))
    unreachable))
