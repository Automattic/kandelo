(module
  (type $v (func (result i32)))
  (type $s (func (param i32) (result i64)))
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (import "env" "__wasm_dlsym" (func $dlsym (param i32 i32 i32) (result i32)))
  (memory 1)
  ;; No main-program function has type $s: a call through it can only reach
  ;; a side-module function the dynamic linker installed.
  (table (export "__indirect_function_table") 1 funcref)
  (func $forker (type $v) (call $kernel_fork (i32.const 0)))
  ;; Calls a side-module function, then forks directly.
  (func $direct (result i32)
    (drop (call_indirect (type $s) (i32.const 7)
      (call $dlsym (i32.const 1) (i32.const 0) (i32.const 5))))
    (call $forker))
  ;; Calls a side-module function and never forks.
  (func $plugin (result i64)
    (call_indirect (type $s) (i32.const 7)
      (call $dlsym (i32.const 1) (i32.const 0) (i32.const 5))))
  (func $_start (export "_start") (drop (call $direct)) (drop (call $plugin))))
