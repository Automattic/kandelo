(module
 (import "env" "memory" (memory 2 65536 shared))
 (import "env" "remap" (func $remap (param i32)))
 (func (export "sum4") (param $p i32) (result i32) (local $a i32) (local $b i32) (local $c i32) (local $d i32)
  local.get $p i32.load local.set $a local.get $p i32.load offset=4 local.set $b
  local.get $p i32.load offset=8 local.set $c local.get $p i32.load offset=12 local.set $d
  i64.const 1 drop local.get $a local.get $b i32.add local.get $c i32.add local.get $d i32.add)
 (func (export "prefix") (param $p i32)
  local.get $p i32.const 1 i32.store local.get $p i32.const 2 i32.store offset=4
  local.get $p i32.const 3 i32.store offset=8 local.get $p i32.const 4 i32.store offset=12)
 (func (export "pointer_values") (param $p i32) (param $v i32) (result i32)
  local.get $p local.get $v i32.store local.get $p i32.load drop
  local.get $p local.get $v i32.store offset=4 local.get $p i32.load offset=4 drop
  i64.const 0 drop local.get $p i32.load offset=4)
 (func (export "trap_order") (param $p i32)
  local.get $p i32.const 1 i32.store local.get $p i32.const 2 i32.store offset=4
  local.get $p i32.load offset=8 drop i32.const 1 i32.const 0 i32.div_s drop
  local.get $p i32.const 4 i32.store offset=12)
 (func (export "call_boundary") (param $p i32) (result i32) (local $a i32) (local $b i32) (local $c i32) (local $d i32)
  local.get $p i32.const 1 i32.store local.get $p i32.const 2 i32.store offset=4
  local.get $p i32.const 3 i32.store offset=8 local.get $p i32.const 4 i32.store offset=12
  local.get $p call $remap
  local.get $p i32.load local.set $a local.get $p i32.load offset=4 local.set $b
  local.get $p i32.load offset=8 local.set $c local.get $p i32.load offset=12 local.set $d
  local.get $a local.get $b i32.add local.get $c i32.add local.get $d i32.add)
 (func (export "outer_value") (param $p i32) (result i32)
  i32.const 100 local.get $p i32.load i32.add local.get $p i32.load offset=4 i32.add
  local.get $p i32.load offset=8 i32.add local.get $p i32.load offset=12 i32.add)
 (func (export "base_mutate") (param $p i32)
  local.get $p i32.const 1 i32.store local.get $p i32.const 2 i32.store offset=4
  local.get $p i32.const 65536 i32.add local.set $p
  local.get $p i32.const 3 i32.store local.get $p i32.const 4 i32.store offset=4)
 (func (export "branches") (param $p i32) (param $flag i32)
  local.get $flag if
   local.get $p i32.const 11 i32.store local.get $p i32.const 12 i32.store offset=4
   local.get $p i32.const 13 i32.store offset=8 local.get $p i32.const 14 i32.store offset=12
  else
   local.get $p i32.const 21 i32.store local.get $p i32.const 22 i32.store offset=4
   local.get $p i32.const 23 i32.store offset=8 local.get $p i32.const 24 i32.store offset=12
  end)
)
