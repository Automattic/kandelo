(module
  (import "h" "fork" (func $fork (param i32) (result i32)))
  (import "env" "memory" (memory @MEMORY_WIDTH@ 4))
  (import "h" "alias" (table $process @TABLE_WIDTH@ 2 4096 funcref))
  (global $visits (export "visits") (mut i32) (i32.const 0))
  (func $visit
    (global.set $visits (i32.add (global.get $visits) (i32.const 1))))
  (func (export "_start")
    (call $visit)
    (drop (call $fork (i32.const 3))))
  (func $thread (param $argument @POINTER@) (result @POINTER@)
    (call $visit)
    (local.get $argument)
    (call $fork (i32.const 3))
    @EXTEND@
    @POINTER@.add)
  (export "__indirect_function_table" (table $process))
  (elem (@TABLE_POINTER@.const 1) $thread))
