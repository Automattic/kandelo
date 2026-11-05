(module
  (type $bytes (array i8))
  (type $node (struct (field (mut i32)) (field (mut (ref null $node)))
    (field (mut (ref null $bytes))) (field (mut exnref))))
  (type $child (func (param (ref $node)) (result i32)))
  (type $constant (func (result i32)))
  (import "h" "fork" (func $fork (param i32 @WIDE_PARAMETERS@) (result i32)))
  (import "h" "same" (func $same (param externref externref) (result i32)))
  (import "env" "memory" (memory @WIDTH@ 4))
  (table $dispatch @WIDTH@ 2 funcref)
  (table $values @WIDTH@ 1 anyref)
  (elem (table $dispatch) (@POINTER@.const 0) func $child $handler)
  (elem declare func $source_function)
  (data $bytes "BC")
  (tag $payload (param (ref $node)))
  (global $__stack_pointer (export "sp") (mut @POINTER@) (@POINTER@.const 196608))
  (global $operand (export "operand") (mut i64) (i64.const 11))
  (global $root (mut (ref null $node)) (ref.null $node))
  (global $external (mut externref) (ref.null extern))
  (global $root_visits (export "root_visits") (mut i32) (i32.const 0))
  (global $child_visits (export "child_visits") (mut i32) (i32.const 0))
  (func $source_function (export "source_function") (type $constant) i32.const 42)
  (func (export "prepare") (param externref)
    struct.new_default $node global.set $root
    global.get $root i32.const 7 struct.set $node 0
    global.get $root global.get $root struct.set $node 1
    global.get $root i32.const 0 i32.const 2 array.new_data $bytes $bytes struct.set $node 2
    local.get 0 global.set $external
    @POINTER@.const 0 ref.func $child table.set $dispatch
    @POINTER@.const 1 ref.func $handler table.set $dispatch
    @POINTER@.const 0 global.get $root table.set $values
    data.drop $bytes)
  (func $handler (export "handler") (type $child)
    (local $caught (ref null $node)) (local $exception exnref) (local $result i32)
    global.get $child_visits i32.const 1 i32.add global.set $child_visits
    block $caught (result (ref $node) (ref exn))
      try_table (catch_ref $payload $caught)
        local.get 0 throw $payload
      end
      unreachable
    end
    local.set $exception local.set $caught
    local.get $caught local.get $exception struct.set $node 3
    i32.const 3
    @WIDE_ARGUMENTS@
    call $fork local.set $result
    local.get $caught struct.get $node 0
    local.get $caught global.get $root ref.eq i32.add
    local.get $caught struct.get $node 2 i32.const 1 array.get_u $bytes i32.add
    block $rethrow (result (ref $node))
      try_table (catch $payload $rethrow)
        local.get $exception ref.as_non_null throw_ref
      end
      unreachable
    end
    struct.get $node 0 i32.add
    local.get $result i32.add)
  ;; The table target tail-transfers to the handler. It must route replay
  ;; without owning a saved activation or retaining its typed argument.
  (func $child (export "child") (type $child)
    local.get 0 @POINTER@.const 1 return_call_indirect $dispatch (type $child))
  (func (export "root") (param externref) (result i32)
    (local $function (ref null $constant)) (local $external externref)
    global.get $root_visits i32.const 1 i32.add global.set $root_visits
    ref.func $source_function local.set $function
    local.get 0 local.set $external
    global.get $root ref.as_non_null @POINTER@.const 0 call_indirect $dispatch (type $child)
    local.get $function ref.as_non_null call_ref $constant i32.add
    local.get $external global.get $external call $same i32.add
    global.get $root_visits i32.const 1 i32.add global.set $root_visits)
  (func (export "verify_roots") (result i32)
    @POINTER@.const 0 table.get $values ref.cast (ref $node) global.get $root ref.eq
    global.get $root struct.get $node 1 global.get $root ref.eq i32.and)
  (func (export "probe_dropped") i32.const 0 i32.const 1 array.new_data $bytes $bytes drop))
