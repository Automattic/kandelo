;; Generated variants substitute only the two memory types/addresses and the
;; optional SIMD loop. The caller proves complete source/allocation bounds.
;; This module owns no Memory and can only observe its two imported ranges.
(module
  (import "env" "kernel" (memory $kernel @KERNEL_MEMORY_TYPE@))
  (import "env" "process" (memory $process @PROCESS_MEMORY_TYPE@))
  (func (export "compare")
    (param $snapshot i64) (param $source i64) (param $len i32) (result i32)
    (local $offset i64) (local $length i64)
    (local.set $length (i64.extend_i32_u (local.get $len)))
    @SIMD_LOOP@
    (block $words_done
      (loop $words
        (br_if $words_done
          (i64.lt_u
            (i64.sub (local.get $length) (local.get $offset))
            (i64.const 8)))
        (if (i64.ne
              (i64.load $kernel align=1 @KERNEL_ADDRESS@)
              (i64.load $process align=1 @PROCESS_ADDRESS@))
          (then (return (i32.const 1))))
        (local.set $offset (i64.add (local.get $offset) (i64.const 8)))
        (br $words)))
    (block $bytes_done
      (loop $bytes
        (br_if $bytes_done
          (i64.ge_u (local.get $offset) (local.get $length)))
        (if (i32.ne
              (i32.load8_u $kernel @KERNEL_ADDRESS@)
              (i32.load8_u $process @PROCESS_ADDRESS@))
          (then (return (i32.const 1))))
        (local.set $offset (i64.add (local.get $offset) (i64.const 1)))
        (br $bytes)))
    (i32.const 0)))
