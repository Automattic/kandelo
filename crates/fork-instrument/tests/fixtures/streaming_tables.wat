(module
  (type $signature (func (result i32)))
  (type $node (struct (field (mut i32)) (field (mut (ref null $node)))))
  (import "env" "memory" (memory @MEMORY_WIDTH@ 2 2 @SHARED@))
  (import "h" "alias" (table $alias @TABLE_WIDTH@ 2 4096 funcref))
  (import "h" "alias" (table $alias_again @TABLE_WIDTH@ 2 4096 funcref))
  (table $typed @TABLE_WIDTH@ 2 4096 (ref $signature) (ref.func $source_function))
  (table $values @TABLE_WIDTH@ 2050 4096 anyref)
  (table $readonly @TABLE_WIDTH@ 1 funcref)
  (table $external @TABLE_WIDTH@ 1 2 externref)
  (table $exceptions @TABLE_WIDTH@ 1 2 exnref)
  (elem (table $readonly) (@INDEX@.const 0) func $source_function)
  (elem $functions (ref $signature) (ref.func $source_function))
  (tag $payload (param i32 (ref null $node)))
  (global $root (mut (ref null $node)) (ref.null $node))
  (global $exception (mut exnref) (ref.null exn))
  (func $source_function (export "source_function") (type $signature) i32.const 42)
  (func (export "prepare") (param externref)
    struct.new_default $node global.set $root
    global.get $root i32.const 7 struct.set $node 0
    global.get $root global.get $root struct.set $node 1
    @INDEX@.const 1 ref.func $source_function table.set $alias
    @INDEX@.const 0 ref.func $source_function table.set $alias_again
    ref.func $source_function @INDEX@.const 5 table.grow $alias drop
    ref.func $source_function @INDEX@.const 2050 table.grow $typed drop
    @INDEX@.const 0 i32.const 0 i32.const 1 table.init $typed $functions
    @INDEX@.const 1022 global.get $root @INDEX@.const 4 table.fill $values
    @INDEX@.const 0 @INDEX@.const 1022 @INDEX@.const 2 table.copy $values $values
    @INDEX@.const 2049 i32.const 17 ref.i31 table.set $values
    global.get $root @INDEX@.const 2 table.grow $values drop
    @INDEX@.const 0 local.get 0 table.set $external
    block $caught (result exnref)
      try_table (catch_all_ref $caught)
        i32.const 29 global.get $root throw $payload
      end
      unreachable
    end
    global.set $exception
    @INDEX@.const 0 global.get $exception table.set $exceptions
    elem.drop $functions)
  (func (export "empty_and_failed_grows")
    @INDEX@.const 0 ref.func $source_function @INDEX@.const 0 table.fill $typed
    ref.func $source_function @INDEX@.const 0 table.grow $typed drop
    ref.func $source_function @INDEX@.const 4096 table.grow $typed
    @INDEX@.const -1 @INDEX@.ne if unreachable end)
  (func (export "read_only") (result i32)
    @INDEX@.const 0 call_indirect $readonly (type $signature))
  (func (export "external") (result externref) @INDEX@.const 0 table.get $external)
  (func (export "verify") (result i32)
    @INDEX@.const 1 call_indirect $alias_again (type $signature) i32.const 42 i32.eq
    @INDEX@.const 0 call_indirect $alias (type $signature) i32.const 42 i32.eq i32.and
    @INDEX@.const 2051 table.get $typed call_ref $signature i32.const 42 i32.eq i32.and
    @INDEX@.const 1023 table.get $values ref.cast (ref $node) global.get $root ref.eq i32.and
    @INDEX@.const 0 table.get $values ref.cast (ref $node) struct.get $node 1 global.get $root ref.eq i32.and
    @INDEX@.const 2049 table.get $values ref.cast (ref i31) i31.get_u i32.const 17 i32.eq i32.and
    table.size $typed @INDEX@.const 2052 @INDEX@.eq i32.and
    table.size $values @INDEX@.const 2052 @INDEX@.eq i32.and)
  (func (export "verify_exception") (result i32)
    (local $node (ref null $node))
    block $caught (result i32 (ref null $node))
      try_table (catch $payload $caught)
        @INDEX@.const 0 table.get $exceptions ref.as_non_null throw_ref
      end
      unreachable
    end
    local.set $node i32.const 29 i32.eq
    local.get $node global.get $root ref.eq i32.and)
  (func (export "probe_dropped") @INDEX@.const 0 i32.const 0 i32.const 1 table.init $typed $functions)
)
