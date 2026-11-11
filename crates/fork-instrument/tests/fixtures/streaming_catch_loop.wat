(module
  (import "h" "fork" (func $fork (param i32) (result i32)))
  (memory (export "memory") @MEMORY_TYPE@ 2)
  (global $__stack_pointer (export "sp") (mut @POINTER@) (@POINTER@.const 65536))
  (tag $jump (param i32))
  (func $root (export "root") (param $mode i32) (result i32)
    (local $caught i32) (local $result i32)
    block $done
      loop $input
        block $handler @HANDLER_RESULT@
          try_table (@CATCH_CLAUSE@)
            local.get $caught i32.eqz
            if
              i32.const 99 throw $jump
            end
            i32.const 3 call $fork local.set $result
            br $done
          end
          unreachable
        end
        @HANDLE_EXCEPTION@
        local.set $caught
        br $input
      end
    end
    local.get $caught local.get $result i32.add))
