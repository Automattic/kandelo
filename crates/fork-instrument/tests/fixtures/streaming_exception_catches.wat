(module
  (import "h" "fork" (func $fork (param i32) (result i32)))
  (import "h" "value" (func $value (result externref)))
  (import "h" "check" (func $check (param externref) (result i32)))
  (import "h" "raise" (func $raise))
  (memory (export "memory") @MEMORY_TYPE@ 2)
  (global $__stack_pointer (export "sp") (mut @POINTER@) (@POINTER@.const 65536))
  (global $entries (export "entries") (mut i32) (i32.const 0))
  (global $handlers (export "handlers") (mut i32) (i32.const 0))
  (tag $payload (export "payload_tag") (param v128 externref))
  (func $root (export "root") (param $mode i32) (result i32)
    (local $result i32) (local $fork_result i32) (local $caught i32)
    (local $object externref) (local $vector v128) (local $exception exnref)
    @CARRY_PREFIX@
    global.get $entries i32.const 1 i32.add global.set $entries
    block $done (result i32)
      block $handler @HANDLER_RESULTS@
        try_table (result i32) (@CLAUSE@ $handler)
          local.get $mode i32.eqz
          if i32.const 3 call $fork local.set $fork_result end
          local.get $mode i32.const 2 i32.eq
          if (result i32)
            i32.const 42
          else
            local.get $mode i32.const 3 i32.eq
            if call $raise unreachable end
            v128.const i32x4 21 22 23 24 call $value throw $payload
          end
        end
        br $done
      end
      @CAPTURE_PAYLOAD@
      global.get $handlers i32.const 1 i32.add global.set $handlers
      i32.const 1 local.set $caught
      i32.const 0
    end
    local.set $result
    local.get $mode
    if i32.const 3 call $fork local.set $fork_result end
    local.get $caught
    if
      @READ_PAYLOAD@
      local.set $result
    end
    local.get $result local.get $fork_result i32.add
    local.get $mode i32.const 100 i32.mul i32.add
    @CARRY_SUFFIX@))
