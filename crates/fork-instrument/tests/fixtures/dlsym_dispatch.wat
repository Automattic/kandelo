(module
  (type $v (func (result i32)))
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (import "env" "__wasm_dlsym" (func $dlsym (param i32 i32 i32) (result i32)))
  (memory 1)
  ;; No element segment: `forker` and `value` reach the table only when the
  ;; host's dlsym(RTLD_DEFAULT, name) appends the export at run time.
  (table (export "__indirect_function_table") 1 funcref)
  (func $forker (export "forker") (type $v) (call $kernel_fork (i32.const 0)))
  (func $value (export "value") (type $v) (i32.const 42))
  ;; Calls a dlsym-installed non-forking export, then forks directly.
  (func $direct (result i32)
    (drop (call_indirect (type $v)
      (call $dlsym (i32.const 0) (i32.const 0) (i32.const 5))))
    (call $forker))
  ;; Forks through a dlsym-installed export.
  (func $through (result i32)
    (call_indirect (type $v)
      (call $dlsym (i32.const 0) (i32.const 8) (i32.const 6))))
  (func $_start (export "_start") (drop (call $direct)) (drop (call $through))))
