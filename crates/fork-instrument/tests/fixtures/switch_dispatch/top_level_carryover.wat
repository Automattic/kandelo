;; Regression fixture: a fork-path function whose top-level fork-path
;; call site has an operand-stack carryover — a value pushed before the
;; call's args that remains on the stack across the call and is consumed
;; *after* the call returns.
;;
;; This mimics the shape LLVM emits for expressions like
;;     *(sp + K) = makestrspace(len, glob);
;; where the store's address is pushed first, then the call's args, then
;; the call runs, then i32.store consumes [sp, ret_val].
;;
;; Switch-dispatch's `partition_body` assumes the operand stack is empty
;; except for the call's args at the split point. With a carryover, the
;; generated `$POST_K` block (type Simple(None) = 0 → 0) ends with
;; [i32] on the stack — producing wasm that fails validation.
;;
;; The fix routes any function with a top-level fork-path call site
;; having a stack carryover to the guard-dispatch scheme, whose per-call
;; if-else shim preserves the enclosing operand stack.
;;
;; This fixture is input to the tool; assertions live in
;; tests/switch_dispatch.rs.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))

  (memory (export "memory") 1)

  ;; A fork-path helper (trivially calls $kernel_fork so it's in the
  ;; fork-path closure).
  (func $makestrspace (param i32 i32) (result i32)
    (drop (call $kernel_fork))
    (local.get 0))

  (func $main (export "_start") (result i32)
    (local $sp i32)
    (local $pid i32)

    (local.set $sp (i32.const 100))
    (local.set $pid (call $kernel_fork))

    ;; Carryover pattern:
    ;;   local.get $sp            ;; push base address — STAYS on stack
    ;;   i32.const 16             ;; makestrspace arg 0
    ;;   i32.const 8              ;; makestrspace arg 1
    ;;   call $makestrspace       ;; pops 2, pushes 1 → stack: [sp, ret]
    ;;   i32.store offset=12      ;; pops 2: *(sp+12) = ret
    local.get $sp
    i32.const 16
    i32.const 8
    call $makestrspace
    i32.store offset=12

    (local.get $pid)))
