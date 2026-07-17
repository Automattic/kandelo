(module
  (type $pass-i32 (func (param i32) (result i32)))
  (type $pass-i64 (func (param i64) (result i64)))

  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))

  (memory (export "memory") 1)

  ;; Each typed block is a distinct fork-bearing region whose body parameter
  ;; receives a synthetic local. Alternating parameter types makes a changed
  ;; allocation order visible in the emitted local declarations.
  (func $main (export "_start")
    (i32.const 11)
    (block (type $pass-i32)
      drop
      (call $kernel_fork))
    drop

    (i64.const 22)
    (block (type $pass-i64)
      drop
      (call $kernel_fork)
      i64.extend_i32_s)
    drop

    (i32.const 33)
    (block (type $pass-i32)
      drop
      (call $kernel_fork))
    drop

    (i64.const 44)
    (block (type $pass-i64)
      drop
      (call $kernel_fork)
      i64.extend_i32_s)
    drop))
