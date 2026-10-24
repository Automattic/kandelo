(module
  (type $answer (func (result i32)))
  (import "h" "memory" (memory $shared @WIDTH@ 1))
  (import "h" "table" (table $shared @WIDTH@ 4 funcref))
  (import "h" "memory_base" (global $memory_base @INDEX@))
  (import "h" "table_base" (global $table_base @INDEX@))
  (import "h" "observe" (func $observe (param i32)))
  (memory $local (export "local_memory") @WIDTH@ 1)
  (table $local (export "local_table") @WIDTH@ 2 funcref)
  (global $starts (export "starts") (mut i32) (i32.const 0))

  ;; Later segments overwrite earlier ones before start observes the result.
  (elem $first (table $shared) (offset global.get $table_base @INDEX@.const 1 @INDEX@.add) func $seven)
  (elem $second (table $shared) (offset global.get $table_base @INDEX@.const 1 @INDEX@.add) func $nine)
  (elem $empty (table $shared) (offset @INDEX@.const 4) func)
  (elem $local (table $local) (offset @INDEX@.const 0) func $seven)
  (elem $passive func $seven)
  (data $first (memory $shared) (offset global.get $memory_base @INDEX@.const 1 @INDEX@.add) "AB")
  (data $second (memory $shared) (offset global.get $memory_base @INDEX@.const 2 @INDEX@.add) "Z")
  (data $empty (memory $shared) (offset @INDEX@.const 65536) "")
  (data $local (memory $local) (offset @INDEX@.const 0) "Q")
  (data $passive "R")
  (func $seven (type $answer) i32.const 7)
  (func $nine (type $answer) i32.const 9)
  (func $start
    global.get $starts i32.const 1 i32.add global.set $starts
    @INDEX@.const 9 i32.load8_u $shared
    @INDEX@.const 0 i32.load8_u $local i32.add
    @INDEX@.const 1 call_indirect $shared (type $answer) i32.add
    call $observe)
  (start $start)
  (func (export "read_table") (result i32)
    @INDEX@.const 1 call_indirect $shared (type $answer))
  (func (export "read_local_table") (result i32)
    @INDEX@.const 0 call_indirect $local (type $answer))
  (func (export "probe_active_data")
    @INDEX@.const 32 i32.const 0 i32.const 1 memory.init $shared $first)
  (func (export "probe_active_element")
    @INDEX@.const 0 i32.const 0 i32.const 1 table.init $shared $first)
  (func (export "use_passive")
    @INDEX@.const 32 i32.const 0 i32.const 1 memory.init $shared $passive
    @INDEX@.const 0 i32.const 0 i32.const 1 table.init $shared $passive))
