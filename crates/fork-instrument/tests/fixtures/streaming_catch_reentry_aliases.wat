(module
  (import "h" "fork" (func $fork (param i32) (result i32)))
  (import "h" "value" (func $value (result externref)))
  (import "h" "check" (func $check (param externref) (result i32)))
  (memory (export "memory") @MEMORY_TYPE@ 2)
  (global $__stack_pointer (export "sp") (mut @POINTER@) (@POINTER@.const 65536))
  (tag $outer (param v128 externref))
  (tag $inner (param v128 externref))
  (tag $probe)
  (func $root (export "root") (param i32) (result i32)
    (local $outer_caught i32) (local $phase i32) (local $catches i32)
    (local $total i32)
    (local $outer_exception exnref) (local $outer_alias exnref)
    (local $inner_exception exnref) (local $inner_alias exnref)
    block $done
      loop $outer_input
        block $outer_handler @OUTER_RESULTS@
          try_table (@OUTER_CLAUSE@ $outer_handler)
            local.get $outer_caught i32.eqz
            if
              v128.const i32x4 41 1 2 3 call $value throw $outer
            end
            loop $inner_input
              block $inner_handler @INNER_RESULTS@
                try_table (@INNER_CLAUSE@ $inner_handler)
                  local.get $phase i32.eqz
                  if
                    v128.const i32x4 42 1 2 3 call $value throw $inner
                  end
                  ;; These captures follow ordinary re-entry. The synthetic
                  ;; catch is retired, but all four guest references are live.
                  local.get $total local.get $phase call $fork
                  i32.add local.set $total
                  local.get $phase i32.const 1 i32.eq
                  if local.get $inner_alias ref.as_non_null throw_ref end
                  br $done
                end
                unreachable
              end
              local.set $inner_exception @INNER_DROP_PAYLOAD@
              local.get $inner_exception local.set $inner_alias
              local.get $catches i32.const 1 i32.add local.set $catches
              local.get $phase i32.eqz
              if
                ;; Entering another try must preserve this handler's recipe.
                block $unused
                  try_table (catch $probe $unused) nop end
                end
                local.get $total i32.const 0 call $fork
                i32.add local.set $total
              end
              local.get $phase i32.const 1 i32.add local.set $phase
              br $inner_input
            end
            unreachable
          end
          unreachable
        end
        local.set $outer_exception @OUTER_DROP_PAYLOAD@
        local.get $outer_exception local.set $outer_alias
        i32.const 1 local.set $outer_caught
        br $outer_input
      end
    end
    ;; Rethrow both aliases of both exceptions after the loop. The generated
    ;; exception codec must preserve vectors and the externref's identity.
    local.get $outer_exception call $read
    local.get $outer_alias call $read i32.add
    local.get $inner_exception call $read i32.add
    local.get $inner_alias call $read i32.add
    local.get $catches i32.const 100 i32.mul i32.add
    local.get $total i32.add)
  (func $read (param $exception exnref) (result i32)
    (local $object_value i32) (local $vector v128)
    block $payload (result v128 externref)
      try_table (catch $outer $payload) (catch $inner $payload)
        local.get $exception ref.as_non_null throw_ref
      end
      unreachable
    end
    call $check local.set $object_value
    local.tee $vector
    i32x4.extract_lane 0 local.get $object_value i32.add
    local.get $vector i32x4.extract_lane 1 i32.const 1 i32.ne if unreachable end
    local.get $vector i32x4.extract_lane 2 i32.const 2 i32.ne if unreachable end
    local.get $vector i32x4.extract_lane 3 i32.const 3 i32.ne if unreachable end))
