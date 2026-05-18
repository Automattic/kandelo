;; posix_spawn-class regression fixture for the switch-dispatch redesign.
;;
;; Mimics the shadow-stack-manipulation pattern observed in
;; posix_spawn's compiled shape: the pre-call chunk adjusts
;; `__stack_pointer` (global) and writes via that pointer before
;; reaching `kernel.kernel_fork`. Re-executing that chunk during
;; REWINDING corrupts the forked child's shadow-stack state.
;;
;; The expectation after the switch-dispatch transform:
;;   - The `global.set $__stack_pointer` sequence appears exactly ONCE
;;     in the emitted body (NORMAL path, inside chunk 0; not duplicated
;;     by any gating wrapper).
;;   - During REWINDING, chunk 0 is skipped entirely; the stack pointer
;;     is restored via the frame-save/restore path on the user-visible
;;     scalar local, not by re-running the global.set sequence.
;;
;; This fixture is input to the tool; assertions live in
;; tests/switch_dispatch.rs.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
  (import "kernel" "write_through_pointer"
    (func $write_through_pointer (param i32 i32)))

  (memory (export "memory") 1)

  (global $__stack_pointer (mut i32) (i32.const 65536))

  (func $main (export "_start") (result i32)
    (local $pid i32)
    (local $sp i32)

    ;; Reserve 16 bytes on the shadow stack.
    (global.set $__stack_pointer
      (i32.sub (global.get $__stack_pointer) (i32.const 16)))
    (local.set $sp (global.get $__stack_pointer))

    ;; Observe the stack state from the kernel (simulates side effects
    ;; that care about shadow-stack contents — mmap of a stack frame,
    ;; for instance).
    (call $write_through_pointer (local.get $sp) (i32.const 42))

    ;; Fork-path direct call.
    (local.set $pid (call $kernel_fork))

    ;; Second observation — must see the SAME sp, even in the child.
    (call $write_through_pointer (local.get $sp) (i32.const 99))

    ;; Restore shadow stack and return pid.
    (global.set $__stack_pointer
      (i32.add (global.get $__stack_pointer) (i32.const 16)))
    (local.get $pid)
  )
)
