(module
  (type $pair (struct (field i32)))
  (type $ints (array i32))
  (import "h" "fork" (func $fork (param i32) (result i32)))
  (import "h" "callback" (func $callback (param i32) (result i32)))
  (import "h" "root" (global $imported (ref $pair)))
  (import "env" "memory" (memory @WIDTH@ 4))
  (export "callback" (func $callback))
  (global $root (export "root") (ref $pair) (struct.new $pair (i32.const 41)))
  (global $alias (ref $pair) (global.get $root))
  (global $alias2 (ref $pair) (global.get $alias))
  (global $small (ref i31) (ref.i31 (i32.const 7)))
  (global $array (export "array") (ref $ints) (array.new_fixed $ints 2 (i32.const 3) (i32.const 4)))
  (global $null (ref null $pair) (ref.null $pair))
  (global $function funcref (ref.func $source_function))
  (global $starts (export "starts") (mut i32) (i32.const 0))
  (table $default (export "default") @WIDTH@ 2 2 (ref $pair) (struct.new $pair (i32.const 73)))
  (table $empty @WIDTH@ 0 0 (ref $pair) (struct.new $pair (i32.const 999)))
  (table $alias_table @WIDTH@ 1 1 (ref $pair) (global.get $imported))
  (table $values (export "values") @WIDTH@ 3 3 (ref null $pair))
  (table $active (export "active") @WIDTH@ 1 1 (ref null $pair))
  (elem $roots (ref $pair) (global.get $root) (global.get $alias2) (struct.new $pair (i32.const 99)))
  (elem (table $active) (@POINTER@.const 0) (ref $pair) (struct.new $pair (i32.const 77)))
  (func $source_function (export "source_function") (result i32) i32.const 42)
  (func (export "initialize_values")
    @POINTER@.const 0 i32.const 0 i32.const 3 table.init $values $roots)
  (func (export "drop_roots") elem.drop $roots)
  (func (export "checkpoint") (result i32)
    (local $global (ref null $pair)) (local $default (ref null $pair))
    (local $passive (ref null $pair)) (local $active (ref null $pair))
    (local $array (ref null $ints)) (local $import (ref null $pair)) (local $small (ref null i31))
    global.get $root local.set $global
    @POINTER@.const 0 table.get $default local.set $default
    @POINTER@.const 2 table.get $values local.set $passive
    @POINTER@.const 0 table.get $active local.set $active
    global.get $array local.set $array
    global.get $imported local.set $import
    global.get $small local.set $small
    i32.const 3 call $fork drop
    local.get $global global.get $root ref.eq
    local.get $default @POINTER@.const 0 table.get $default ref.eq i32.and
    local.get $passive @POINTER@.const 2 table.get $values ref.eq i32.and
    local.get $active @POINTER@.const 0 table.get $active ref.eq i32.and
    local.get $array global.get $array ref.eq i32.and
    local.get $import global.get $imported ref.eq i32.and
    local.get $small global.get $small ref.eq i32.and)
  (func $start global.get $starts i32.const 1 i32.add global.set $starts)
  (start $start))
