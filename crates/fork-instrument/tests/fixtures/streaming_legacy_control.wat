(module
  (import "h" "fork" (func $fork (param i32) (result i32)))
  (import "h" "same" (func $same (param externref externref) (result i32)))
  (import "h" "raise" (func $raise))
  (import "env" "memory" (memory @WIDTH@ 4))
  (tag $e (export "e") (param i32))
  (tag $f (param i32))
  (tag $v (param v128 externref i32))
  (global $visits (export "visits") (mut i32) (i32.const 0))
  (func (export "root") (param $case i32) (param $token externref) (result i32)
    (local $fork_result i32)
    global.get $visits i32.const 1 i32.add global.set $visits
    @BODY@
    local.get $fork_result i32.add
    local.get $token local.get $token call $same i32.add))
