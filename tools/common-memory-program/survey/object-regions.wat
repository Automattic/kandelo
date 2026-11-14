(module
 (import "env" "memory" (memory 2 65536 shared))
 (func (export "fields") (param $p i32) (param $v i32) (result i32)
  local.get $p local.get $v i32.store
  local.get $p local.get $p i32.store offset=4
  local.get $p i32.load local.get $p i32.load offset=8 i32.add)
 (func (export "narrow") (param $p i32) (param $v i32) (result i32)
  local.get $p local.get $v i32.store8
  local.get $p i32.load8_s
  local.get $p local.get $v i32.store16 offset=2
  local.get $p i32.load16_u offset=2 i32.add)
 (func (export "late_fault") (param $p i32) (param $v i32)
  local.get $p local.get $v i32.store
  local.get $p local.get $v i32.const 1 i32.add i32.store offset=8)
 (func $read_only (export "read_only") (param $p i32) (result i32)
  local.get $p i32.load local.get $p i32.load offset=4 i32.add)
 (func (export "arithmetic_trap") (param $p i32) (param $v i32)
  i32.const 1 i32.const 0 i32.div_u drop
  local.get $p local.get $v i32.store
  local.get $p local.get $v i32.store offset=4)
 (func (export "tee_alias") (param $p i32) (param $v i32) (result i32) (local $alias i32)
  local.get $p local.tee $alias local.get $v i32.store
  local.get $p local.get $alias i32.store offset=4
  local.get $alias)
 (func (export "zero_local") (result i32) (local $p i32)
  local.get $p i32.load local.get $p i32.load offset=4 i32.add)
 ;; Each following function is a mandatory conservative rejection control.
 (func (export "two_bases") (param i32 i32) (result i32)
  local.get 0 i32.load local.get 1 i32.load i32.add)
 (func (export "written_base") (param i32) (result i32)
  local.get 0 i32.const 4 i32.add local.set 0
  local.get 0 i32.load local.get 0 i32.load offset=4 i32.add)
 (func (export "derived") (param i32) (result i32)
  local.get 0 i32.const 4 i32.add i32.load
  local.get 0 i32.const 8 i32.add i32.load i32.add)
 (func (export "calls") (param i32) (result i32)
  local.get 0 call $read_only local.get 0 i32.load i32.add)
 (func (export "branch") (param i32) (result i32)
  local.get 0 i32.eqz
  if (result i32)
   local.get 0 i32.load local.get 0 i32.load offset=4 i32.add
  else i32.const 0 end)
 (func (export "atomic") (param i32) (result i32)
  local.get 0 i32.atomic.load local.get 0 i32.load offset=4 i32.add)
 (func (export "single") (param i32) (result i32) local.get 0 i32.load)
 (func (export "memory_pointer") (param i32) (result i32)
  local.get 0 i32.load i32.load local.get 0 i32.load offset=4 i32.add)
 (func (export "max_offset") (param i32) (result i32)
  local.get 0 i32.load offset=4294967295 local.get 0 i32.load i32.add)
)
