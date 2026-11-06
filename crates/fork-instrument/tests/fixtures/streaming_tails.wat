(module
  (type $unary (func (param i32) (result i32)))
  (import "h" "fork" (func $fork (type $unary)))
  (memory (export "memory") @MEMORY_TYPE@ 2)
  (table @MEMORY_TYPE@ 2 funcref)
  (global $__stack_pointer (export "sp") (mut @POINTER@) (@POINTER@.const 65536))
  (global $visits (export "visits") (mut i32) (i32.const 0))
  (global $child_visits (export "child_visits") (mut i32) (i32.const 0))
  (global $root_visits (export "root_visits") (mut i32) (i32.const 0))
  (global $operand (mut i64) (i64.const 11))

  (func $child (type $unary)
    global.get $child_visits i32.const 1 i32.add global.set $child_visits
    local.get 0 call $fork
    i32.const 7 i32.add)

  (func $tail_direct (type $unary)
    global.get $visits i32.const 1 i32.add global.set $visits
    local.get 0 i32.eqz
    if
      i32.const 3 return_call $child
    end
    local.get 0 i32.const 1 i32.sub return_call $tail_direct)

  (func $tail_indirect (type $unary)
    local.get 0 @POINTER@.const 0 return_call_indirect (type $unary))

  (func $tail_ref (type $unary)
    local.get 0 ref.func $fork return_call_ref $unary)

  (func $root (export "root") (param $route i32) (param $depth i32) (result i32)
    global.get $root_visits i32.const 1 i32.add global.set $root_visits
    local.get $route i32.eqz
    if (result i32)
      local.get $depth call $tail_direct
    else
      local.get $route i32.const 1 i32.eq
      if (result i32)
        i32.const 3 call $tail_indirect
      else
        i32.const 3 call $tail_ref
      end
    end
    i32.const 10 i32.add)

  ;; The wide call forces virtual argument spills. Its fork returns normally;
  ;; the following tail transfer must release this activation's scratch first.
  (func $scratch_tail (export "scratch_tail") (result i32)
    @WIDE_ARGUMENTS@
    call $wide drop
    i32.const 3 return_call $fork)
  (func $wide (param @WIDE_PARAMETERS@) (result i32)
    i32.const 1 call $fork)
  (elem (@POINTER@.const 0) func $fork $child))
