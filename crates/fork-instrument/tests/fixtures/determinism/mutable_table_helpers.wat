(module
  (type $a (func (result i32)))
  (type $b (func (param i32) (result i32)))
  (type $c (func (param i64) (result i32)))
  (type $d (func (param f64 i32) (result i32)))
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (memory 1)
  (table $left 8 funcref)
  (table $right 8 funcref)
  (func $a (type $a) i32.const 1)
  (func $b (type $b) local.get 0)
  (func $c (type $c) local.get 0 i32.wrap_i64)
  (func $d (type $d) local.get 1)
  (elem declare func $a $b $c $d)
  (func (export "_start")
    i32.const 0 ref.func $a table.set $left
    i32.const 0 ref.func $b table.set $right
    ref.null func i32.const 0 table.grow $left drop
    i32.const 0 ref.null func i32.const 0 table.fill $right
    i32.const 0 i32.const 0 i32.const 0 table.copy $left $right
    call $fork drop
    i32.const 0 call_indirect $left (type $a) drop
    i32.const 7 i32.const 0 call_indirect $right (type $b) drop
    i32.const 0 ref.func $c table.set $left
    i64.const 9 i32.const 0 call_indirect $left (type $c) drop
    i32.const 0 ref.func $d table.set $right
    f64.const 2 i32.const 5 i32.const 0 call_indirect $right (type $d) drop))
