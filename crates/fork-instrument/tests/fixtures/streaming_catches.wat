(module
  (import "h" "fork" (func $fork (param i32) (result i32)))
  (memory (export "memory") @MEMORY_TYPE@ 2)
  (global $__stack_pointer (export "sp") (mut @POINTER@) (@POINTER@.const 65536))
  (global $entries (export "entries") (mut i32) (i32.const 0))
  (tag $a (param i32))
  (tag $b (param i64 i32))
  (func $root (export "root") (param $mode i32) (result i32)
    (local $payload i32) (local $fork_result i32)
    global.get $entries i32.const 1 i32.add global.set $entries
    block $done (result i32)
      block $b_handler (result i64 i32 @EXCEPTION_RESULT@)
        block $a_handler (result i32 @EXCEPTION_RESULT@)
          @TRY_ARGUMENTS@
          try_table @TRY_PARAMETERS@ (result i32) (@CATCH@ $a $a_handler) (@CATCH@ $b $b_handler)
            @DROP_TRY_PARAMETERS@
            @INSIDE_FORK@
            local.get $mode i32.const 2 i32.eq
            if (result i32)
              i32.const 42
            else
              local.get $mode
              if
                i32.const 21 throw $a
              else
                i64.const 30 i32.const 12 throw $b
              end
              unreachable
            end
          end
          br $done
        end
        @DROP_EXCEPTION@
        br $done
      end
      @DROP_EXCEPTION@
      local.set $payload
      i32.wrap_i64 local.get $payload i32.add
    end
    local.set $payload
    @AFTER_FORK@
    local.get $fork_result
    local.get $payload i32.add
    local.get $mode i32.const 100 i32.mul i32.add))
