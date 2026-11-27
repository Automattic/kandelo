(module
 (import "env" "memory" (memory 1 65536 shared))
 (func (export "exchange") (param $lock i32)
  (block $done (loop $retry
   local.get $lock i32.const 1 i32.atomic.rmw.xchg i32.eqz br_if $done
   br $retry))
  local.get $lock i32.const 0 i32.atomic.store)
 (func (export "readfirst") (param $lock i32)
  (block $done (loop $retry
   local.get $lock i32.atomic.load br_if $retry
   local.get $lock i32.const 1 i32.atomic.rmw.xchg i32.eqz br_if $done
   br $retry))
  local.get $lock i32.const 0 i32.atomic.store)
 (func (export "store") (param $lock i32)
  local.get $lock i32.const 0 i32.atomic.store))
