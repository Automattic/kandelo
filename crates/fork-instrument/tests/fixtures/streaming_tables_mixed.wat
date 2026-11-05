(module
  (import "env" "memory" (memory 2))
  (type $signature (func (result i32)))
  (table $narrow 2 5 funcref)
  (table $wide i64 2 5 funcref)
  (elem declare func $source_function)
  (func $source_function (export "source_function") (type $signature) i32.const 42)
  (func (export "prepare")
    i32.const 1 ref.func $source_function table.set $narrow
    i64.const 1 ref.func $source_function table.set $wide
    ref.func $source_function i32.const 2 table.grow $narrow drop
    ref.func $source_function i64.const 2 table.grow $wide drop)
  (func (export "verify") (result i32)
    i32.const 2 call_indirect $narrow (type $signature) i32.const 42 i32.eq
    i64.const 3 call_indirect $wide (type $signature) i32.const 42 i32.eq i32.and
    table.size $narrow i32.const 4 i32.eq i32.and
    table.size $wide i64.const 4 i64.eq i32.and))
