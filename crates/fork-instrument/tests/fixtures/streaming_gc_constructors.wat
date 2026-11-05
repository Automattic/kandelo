(module
  (memory (export "memory") @MEMORY_TYPE@ 2)
  (type $leaf (struct (field (mut i32))))
  (type $holder (struct
    (field (mut (ref $leaf))) (field i16) (field v128)
    (field (mut (ref $leaf)))))
  (type $nonnull (array (mut (ref $leaf))))
  (type $bytes (array i8))
  (type $words (array i16))
  (type $functions (array funcref))
  (type $float (array f32))
  (type $double (array f64))
  (type $vector (array v128))
  (table $objects (export "objects") 16 anyref)
  (global $effects (export "effects") (mut i32) (i32.const 0))
  (data $data "\01\02\03\04\05\06\07\08")
  (elem $functions func $one $two $three)
  (func $one (result i32) i32.const 11)
  (func $two (result i32) i32.const 22)
  (func $three (result i32) i32.const 33)
  (func $leaf (param i32) (result (ref $leaf)) local.get 0 struct.new $leaf)
  (func $mark (param $value i32) (param $digit i32) (result i32)
    global.get $effects i32.const 10 i32.mul local.get $digit i32.add global.set $effects
    local.get $value)

  ;; No function here calls fork. Constructor ownership is module-wide.
  (func (export "construct") (result i32)
    (local $a (ref null $leaf)) (local $b (ref null $leaf))
    (local $holder (ref null $holder)) (local $array (ref null $nonnull))
    i32.const 1 call $leaf local.set $a
    i32.const 2 call $leaf local.set $b
    i32.const 0 local.get $a table.set $objects
    i32.const 1 local.get $b table.set $objects

    local.get $a ref.as_non_null i32.const 65537 v128.const i32x4 1 2 3 4
    local.get $a ref.as_non_null struct.new $holder local.set $holder
    local.get $holder local.get $b ref.as_non_null struct.set $holder 0
    i32.const 2 local.get $holder table.set $objects

    local.get $a ref.as_non_null i32.const 3 array.new $nonnull local.set $array
    local.get $array i32.const 0 local.get $b ref.as_non_null array.set $nonnull
    i32.const 3 local.get $array table.set $objects
    i32.const 4 local.get $a ref.as_non_null local.get $b ref.as_non_null
    array.new_fixed $nonnull 2 table.set $objects

    i32.const 5
    i32.const 4660 i32.const 1 call $mark
    i32.const 2 i32.const 2 call $mark
    array.new $bytes table.set $objects
    i32.const 6 i32.const 3 array.new_default $words table.set $objects
    i32.const 7 i32.const 7 i32.const 8 i32.const 9 array.new_fixed $words 3 table.set $objects
    i32.const 8 i32.const 2 i32.const 2 array.new_data $words $data table.set $objects
    i32.const 9 i32.const 1 i32.const 2 array.new_elem $functions $functions table.set $objects
    i32.const 10 i32.const 0x7fc12345 f32.reinterpret_i32 i32.const 2 array.new $float table.set $objects
    i32.const 11 i64.const 0x7ff8123456789abc f64.reinterpret_i64 i32.const 2 array.new $double table.set $objects
    i32.const 12 v128.const i64x2 0x102030405060708 0x8899aabbccddeeff
    i32.const 2 array.new $vector table.set $objects
    i32.const 13 array.new_fixed $nonnull 0 table.set $objects

    ;; Mutations changed the live values, not their retained constructor seeds.
    local.get $holder struct.get $holder 0 local.get $b ref.eq
    local.get $array i32.const 0 array.get $nonnull local.get $b ref.eq i32.and)

  (func (export "bad_data")
    i32.const 99 i32.const 3 call $mark
    i32.const 1 i32.const 4 call $mark
    array.new_data $words $data drop)
  (func (export "bad_elem")
    i32.const 99 i32.const 5 call $mark
    i32.const 1 i32.const 6 call $mark
    array.new_elem $functions $functions drop)
  (func (export "drop_segments") data.drop $data elem.drop $functions)
  (func (export "dropped_data")
    i32.const 0 i32.const 1 array.new_data $words $data drop)
  (func (export "dropped_elem")
    i32.const 0 i32.const 1 array.new_elem $functions $functions drop))
