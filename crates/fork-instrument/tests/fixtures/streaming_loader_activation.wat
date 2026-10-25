(module
  (import "h" "fork" (func $fork (param i32) (result i32)))
  (import "env" "__wasm_dlopen" (func $open (param @PARAMETERS@) (result i32)))
  (import "h" "same" (func $same (param externref externref) (result i32)))
  (import "h" "check" (func $check (param i32) (result i32)))
  (import "env" "memory" (memory @WIDTH@ 4))
  (table (export "__indirect_function_table") @TABLE_WIDTH@ 2 funcref)
  (elem (@TABLE_POINTER@.const 1) func $initializer)
  (global $root_visits (export "root_visits") (mut i32) (i32.const 0))
  (global $init_visits (export "init_visits") (mut i32) (i32.const 0))
  (global $checkpoints (export "checkpoints") (mut i32) (i32.const 0))
  (global $fork_value (export "fork_value") (mut i32) (i32.const 0))
  (global $in_checkpoint (export "in_checkpoint") (mut i32) (i32.const 0))
  (func $initializer (export "initializer")
    global.get $init_visits i32.const 1 i32.add global.set $init_visits
    i32.const 3 call $fork global.set $fork_value)
  (func (export "__wasm_posix_signal_checkpoint")
    i32.const 1 global.set $in_checkpoint
    global.get $checkpoints i32.const 1 i32.add global.set $checkpoints
    global.get $checkpoints call $check
    if i32.const 3 call $fork drop end
    i32.const 0 global.set $in_checkpoint)
  (func (export "root") (param $token externref) (result i32)
    global.get $root_visits i32.const 1 i32.add global.set $root_visits
    @ARGUMENTS@ call $open
    global.get $fork_value i32.add
    local.get $token local.get $token call $same i32.add))
