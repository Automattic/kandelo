(module
  (import "env" "memory" (memory @WIDTH@ 2))
  (import "h" "alias" (global $alias_i32 i32))
  (import "h" "alias" (global $alias_f64 f64))
  (import "h" "mutable" (global $imported (mut i64)))
  (import "env" "__channel_base" (global $channel (mut i32)))
  (type $function (func (result i32)))
  (type $node (struct (field (mut i32)) (field (mut (ref null $node))) (field (mut (ref null exn)))))
  (type $bytes (array i8))
  (type $functions (array funcref))
  (tag $payload (param i32 (ref null any)))
  (table 1 funcref)
  (elem (i32.const 0) func $source_function)
  (elem $functions func $source_function)
  (data (@POINTER@.const 64) "A")
  (data $bytes "BC")
  (data $untouched "D")
  @EXTRA_DATA@
  (global $constant i32 (i32.const 17))
  (global $starts (export "starts") (mut i32) (i32.const 0))
  (global $integer (mut i32) (i32.const 0))
  (global $float (mut f32) (f32.const 0))
  (global $double (mut f64) (f64.const 0))
  (global $vector (mut v128) (v128.const i32x4 0 0 0 0))
  (global $root (mut (ref null $node)) (ref.null $node))
  (global $alias (mut (ref null any)) (ref.null any))
  (global $exception (mut (ref null exn)) (ref.null exn))
  (global $data_array (mut (ref null $bytes)) (ref.null $bytes))
  (global $element_array (mut (ref null $functions)) (ref.null $functions))
  (global $function (mut (ref null $function)) (ref.null $function))
  (global $external (mut externref) (ref.null extern))
  (func $source_function (export "source_function") (type $function) i32.const 42)
  (func $start global.get $starts i32.const 1 i32.add global.set $starts)
  (start $start)

  (func (export "make") (param externref)
    (local $node (ref null $node)) (local $exception (ref null exn))
    i64.const 0x102030405060708 global.set $imported
    i32.const 123 global.set $integer
    i32.const 0x7fc12345 f32.reinterpret_i32 global.set $float
    i64.const 0x7ff8123456789abc f64.reinterpret_i64 global.set $double
    v128.const i64x2 0x102030405060708 0x8899aabbccddeeff global.set $vector
    struct.new_default $node local.set $node
    local.get $node i32.const 99 struct.set $node 0
    local.get $node local.get $node struct.set $node 1
    block $caught (result (ref exn))
      try_table (catch_all_ref $caught)
        i32.const 55 local.get $node throw $payload
      end
      unreachable
    end
    local.set $exception
    local.get $node local.get $exception struct.set $node 2
    local.get $node global.set $root
    local.get $node global.set $alias
    local.get $exception global.set $exception
    i32.const 0 i32.const 2 array.new_data $bytes $bytes global.set $data_array
    i32.const 0 i32.const 1 array.new_elem $functions $functions global.set $element_array
    ref.func $source_function global.set $function
    local.get 0 global.set $external
    data.drop $bytes data.drop $spare28 data.drop $spare29 data.drop $spare33
    elem.drop $functions)
  (func (export "external") (result externref) global.get $external)
  (func (export "channel") (result i32) global.get $channel)
  (func (export "verify") (result i32)
    global.get $alias_i32 i32.const 1 i32.eq
    global.get $alias_f64 f64.const 4294967297.25 f64.eq i32.and
    global.get $imported i64.const 0x102030405060708 i64.eq i32.and
    global.get $starts i32.const 1 i32.eq i32.and
    global.get $integer i32.const 123 i32.eq i32.and
    global.get $float i32.reinterpret_f32 i32.const 0x7fc12345 i32.eq i32.and
    global.get $double i64.reinterpret_f64 i64.const 0x7ff8123456789abc i64.eq i32.and
    global.get $vector i64x2.extract_lane 1 i64.const 0x8899aabbccddeeff i64.eq i32.and
    global.get $root struct.get $node 0 i32.const 99 i32.eq i32.and
    global.get $root struct.get $node 1 global.get $alias ref.cast (ref $node) ref.eq i32.and
    global.get $function ref.as_non_null call_ref $function i32.const 42 i32.eq i32.and
    global.get $data_array i32.const 1 array.get_u $bytes i32.const 67 i32.eq i32.and
    global.get $element_array i32.const 0 array.get $functions
    ref.cast (ref $function) call_ref $function i32.const 42 i32.eq i32.and)
  (func (export "verify_exception") (result i32)
    (local $value (ref null any))
    block $caught (result i32 (ref null any))
      try_table (catch $payload $caught)
        global.get $exception ref.as_non_null throw_ref
      end
      unreachable
    end
    local.set $value i32.const 55 i32.eq
    local.get $value ref.cast (ref $node) global.get $root ref.eq i32.and)
  (func (export "probe_dropped_data") i32.const 0 i32.const 1 array.new_data $bytes $bytes drop)
  (func (export "probe_dropped_elements") i32.const 0 i32.const 1 array.new_elem $functions $functions drop)
  (func (export "probe_untouched_data") @POINTER@.const 96 i32.const 0 i32.const 1 memory.init $untouched))
