(module
  (import "env" "memory" (memory 2))
  (type $node
    (struct
      (field (mut i32))
      (field (mut (ref null $node)))
      (field (mut (ref null any)))))
  (type $fixed (array i16))
  (type $data-bytes (array i8))
  (type $nullable-array (array (ref null $node)))
  (type $function (func (result i32)))
  (type $mixed (struct
    (field (mut (ref $node))) (field (mut (ref $function)))
    (field (mut (ref extern))) (field (mut (ref exn)))
    (field i16) (field v128) (field (mut (ref $node)))))
  (tag $payload (param i32 (ref null any)))
  (type $packed_mutable (array (mut i16)))
  (type $longs (array i64))
  (type $floats (array f32))
  (type $vectors (array v128))
  (type $function_array (array (ref $function)))
  (type $function_elements (array funcref))
  (type $nonnull_array (array (mut (ref $node))))
  (table $objects (export "objects") 18 (ref null any))
  (elem declare func $source_function)
  (elem $functions func $source_function)
  (data $bytes "\0b\16\21")

  (func (export "create_cycle")
    (local $node (ref null $node))
    i32.const 77
    ref.null $node
    ref.null any
    struct.new $node
    local.set $node
    local.get $node
    local.get $node
    struct.set $node 1
    i32.const 0
    local.get $node
    table.set $objects)

  (func (export "verify_cycle") (result i32)
    (local $node (ref null $node))
    i32.const 0
    table.get $objects
    ref.cast (ref $node)
    local.set $node
    local.get $node
    ref.as_non_null
    struct.get $node 0
    i32.const 77
    i32.eq
    local.get $node
    ref.as_non_null
    local.get $node
    ref.as_non_null
    struct.get $node 1
    ref.as_non_null
    ref.eq
    i32.and)

  (func (export "create_externalized_cycle")
    (param $token externref)
    (result externref)
    (local $node (ref null $node))
    i32.const 88
    ref.null $node
    local.get $token
    any.convert_extern
    struct.new $node
    local.set $node
    local.get $node
    local.get $node
    struct.set $node 1
    i32.const 1
    local.get $node
    table.set $objects
    local.get $node
    extern.convert_any)

  (func (export "verify_externalized_cycle")
    (param $root externref)
    (result i32)
    (local $node (ref null $node))
    local.get $root
    any.convert_extern
    ref.cast (ref $node)
    local.set $node
    local.get $node
    struct.get $node 0
    i32.const 88
    i32.eq
    local.get $node
    local.get $node
    struct.get $node 1
    ref.as_non_null
    ref.eq
    i32.and)

  (func (export "externalized_cycle_token")
    (param $root externref)
    (result externref)
    local.get $root
    any.convert_extern
    ref.cast (ref $node)
    struct.get $node 2
    extern.convert_any)

  (func (export "create_fixed")
    (local $array (ref null $fixed))
    i32.const 11
    i32.const 22
    array.new_fixed $fixed 2
    local.set $array
    i32.const 2
    local.get $array
    table.set $objects)

  (func (export "verify_fixed") (result i32)
    (local $array (ref null $fixed))
    i32.const 2
    table.get $objects
    ref.cast (ref $fixed)
    local.set $array
    local.get $array
    i32.const 0
    array.get_u $fixed
    i32.const 11
    i32.eq
    local.get $array
    i32.const 1
    array.get_u $fixed
    i32.const 22
    i32.eq
    i32.and)

  (func (export "create_data")
    (local $array (ref null $data-bytes))
    i32.const 0
    i32.const 3
    array.new_data $data-bytes $bytes
    local.set $array
    i32.const 3
    local.get $array
    table.set $objects)

  (func (export "verify_data") (result i32)
    (local $array (ref null $data-bytes))
    i32.const 3
    table.get $objects
    ref.cast (ref $data-bytes)
    local.set $array
    local.get $array
    i32.const 0
    array.get_u $data-bytes
    i32.const 11
    i32.eq
    local.get $array
    i32.const 1
    array.get_u $data-bytes
    i32.const 22
    i32.eq
    i32.and
    local.get $array
    i32.const 2
    array.get_u $data-bytes
    i32.const 33
    i32.eq
    i32.and)

  (func (export "create_nullable_empty")
    (local $array (ref null $nullable-array))
    ref.null $node
    i32.const 0
    array.new $nullable-array
    local.set $array
    i32.const 4
    local.get $array
    table.set $objects)

  (func (export "verify_nullable_empty") (result i32)
    i32.const 4
    table.get $objects
    ref.cast (ref $nullable-array)
    array.len
    i32.eqz)
  (func (export "create_i31")
    i32.const 5 i32.const -123456 ref.i31 table.set $objects)
  (func (export "verify_i31") (result i32)
    i32.const 5 table.get $objects ref.cast (ref i31) i31.get_s
    i32.const -123456 i32.eq)

  (func $source_function (export "source_function") (type $function) i32.const 42)
  (func $mixed (result (ref $mixed))
    i32.const 6 table.get $objects ref.cast (ref $mixed))
  (func (export "create_mixed") (param $token externref)
    (local $a (ref null $node)) (local $b (ref null $node))
    (local $exception (ref null exn)) (local $object (ref null $mixed))
    i32.const 11 ref.null $node ref.null any struct.new $node local.set $a
    i32.const 22 ref.null $node ref.null any struct.new $node local.set $b
    block $caught (result (ref exn))
      try_table (catch_all_ref $caught)
        i32.const 55 local.get $a throw $payload
      end
      unreachable
    end
    local.set $exception
    local.get $a ref.as_non_null ref.func $source_function
    local.get $token ref.as_non_null local.get $exception ref.as_non_null
    i32.const 65535 v128.const i64x2 0x102030405060708 0x8899aabbccddeeff
    local.get $a ref.as_non_null struct.new $mixed local.set $object
    local.get $object local.get $b ref.as_non_null struct.set $mixed 0
    local.get $object local.get $b ref.as_non_null struct.set $mixed 6
    ;; Close a GC -> exception -> GC cycle after the typed shell exists.
    local.get $object
    block $cycle (result (ref exn))
      try_table (catch_all_ref $cycle)
        i32.const 55 local.get $object throw $payload
      end
      unreachable
    end
    struct.set $mixed 3
    i32.const 6 local.get $object table.set $objects)
  (func (export "mixed_token") (result externref)
    call $mixed struct.get $mixed 2)
  (func (export "verify_mixed") (result i32)
    call $mixed struct.get $mixed 0 struct.get $node 0 i32.const 22 i32.eq
    call $mixed struct.get $mixed 0 call $mixed struct.get $mixed 6 ref.eq i32.and
    call $mixed struct.get $mixed 1 call_ref $function i32.const 42 i32.eq i32.and
    call $mixed struct.get_u $mixed 4 i32.const 65535 i32.eq i32.and
    call $mixed struct.get $mixed 5 i64x2.extract_lane 0 i64.const 0x102030405060708 i64.eq i32.and
    call $mixed struct.get $mixed 5 i64x2.extract_lane 1 i64.const 0x8899aabbccddeeff i64.eq i32.and)
  (func (export "verify_mixed_exception") (result i32)
    (local $root (ref null any))
    block $caught (result i32 (ref null any))
      try_table (catch $payload $caught)
        call $mixed struct.get $mixed 3 throw_ref
      end
      unreachable
    end
    local.set $root i32.const 55 i32.eq
    local.get $root ref.cast (ref $mixed) call $mixed ref.eq i32.and)

  (func (export "create_arrays")
    (local $packed (ref null $packed_mutable))
    (local $a (ref null $node)) (local $b (ref null $node))
    (local $nonnull (ref null $nonnull_array))
    i32.const 3 array.new_default $packed_mutable local.set $packed
    local.get $packed i32.const 0 i32.const 65535 array.set $packed_mutable
    local.get $packed i32.const 1 i32.const 4660 array.set $packed_mutable
    i32.const 7 local.get $packed table.set $objects
    i32.const 8 i64.const 0x102030405060708 i32.const 2 array.new $longs table.set $objects
    i32.const 9 i32.const 0x7fc12345 f32.reinterpret_i32 i32.const 2
    array.new $floats table.set $objects
    i32.const 10 v128.const i64x2 0x102030405060708 0x8899aabbccddeeff
    i32.const 2 array.new $vectors table.set $objects
    i32.const 11 ref.func $source_function i32.const 2 array.new $function_array table.set $objects
    i32.const 12 ref.func $source_function i32.const 0 array.new $function_array table.set $objects

    i32.const 11 ref.null $node ref.null any struct.new $node local.set $a
    i32.const 22 ref.null $node ref.null any struct.new $node local.set $b
    local.get $a ref.as_non_null local.get $b ref.as_non_null
    array.new_fixed $nonnull_array 2 local.set $nonnull
    local.get $nonnull i32.const 0 local.get $b ref.as_non_null array.set $nonnull_array
    i32.const 13 local.get $nonnull table.set $objects
    i32.const 14 i32.const 0 i32.const 1 array.new_elem $function_elements $functions table.set $objects
    i32.const 15 i32.const 3 array.new_default $fixed table.set $objects
    i32.const 16
    v128.const i64x2 0x102030405060708 0x8899aabbccddeeff
    v128.const i64x2 0x1122334455667788 0x7ff8123456789abc
    array.new_fixed $vectors 2 table.set $objects
    i32.const 17 array.new_fixed $nonnull_array 0 table.set $objects)

  (func (export "verify_arrays") (result i32)
    i32.const 7 table.get $objects ref.cast (ref $packed_mutable) i32.const 0
    array.get_u $packed_mutable i32.const 65535 i32.eq
    i32.const 7 table.get $objects ref.cast (ref $packed_mutable) i32.const 1
    array.get_u $packed_mutable i32.const 4660 i32.eq i32.and
    i32.const 8 table.get $objects ref.cast (ref $longs) i32.const 1
    array.get $longs i64.const 0x102030405060708 i64.eq i32.and
    i32.const 9 table.get $objects ref.cast (ref $floats) i32.const 1
    array.get $floats i32.reinterpret_f32 i32.const 0x7fc12345 i32.eq i32.and
    i32.const 10 table.get $objects ref.cast (ref $vectors) i32.const 1
    array.get $vectors i64x2.extract_lane 1 i64.const 0x8899aabbccddeeff i64.eq i32.and
    i32.const 11 table.get $objects ref.cast (ref $function_array) i32.const 1
    array.get $function_array call_ref $function i32.const 42 i32.eq i32.and
    i32.const 12 table.get $objects ref.cast (ref $function_array) array.len i32.eqz i32.and
    i32.const 13 table.get $objects ref.cast (ref $nonnull_array) i32.const 0
    array.get $nonnull_array struct.get $node 0 i32.const 22 i32.eq i32.and
    i32.const 13 table.get $objects ref.cast (ref $nonnull_array) i32.const 0 array.get $nonnull_array
    i32.const 13 table.get $objects ref.cast (ref $nonnull_array) i32.const 1 array.get $nonnull_array
    ref.eq i32.and
    i32.const 14 table.get $objects ref.cast (ref $function_elements) i32.const 0
    array.get $function_elements ref.cast (ref $function) call_ref $function i32.const 42 i32.eq i32.and
    i32.const 15 table.get $objects ref.cast (ref $fixed) i32.const 2
    array.get_u $fixed i32.eqz i32.and
    i32.const 16 table.get $objects ref.cast (ref $vectors) i32.const 1
    array.get $vectors i64x2.extract_lane 0 i64.const 0x1122334455667788 i64.eq i32.and
    i32.const 17 table.get $objects ref.cast (ref $nonnull_array) array.len i32.eqz i32.and))
