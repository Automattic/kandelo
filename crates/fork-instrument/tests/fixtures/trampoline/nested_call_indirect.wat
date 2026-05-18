;; Trampoline class (c): fork-path call reached via `call_indirect`
;; nested inside a `loop` body.
;;
;; **Empirical finding (sub-commit 2.1):** the *simple* nested
;; call_indirect case — call_indirect inside a loop body with no other
;; unsupported pattern — is ALREADY handled by nested switch-dispatch
;; today. The `classify_nested_pattern` walker accepts the loop scope,
;; sees no carryover / no multi-value-params / no legacy try, returns
;; `Supported`, and nested switch-dispatch emits a br_table covering
;; the call_indirect. The Explore agent's pre-implementation read of
;; instrument.rs assumed nested call_indirect would force guard-dispatch
;; via `has_nested_fork_calls` (line 630); in practice the conservative
;; "fork-bearing" classification just routes the call through nested
;; switch-dispatch (which it handles correctly).
;;
;; This fixture is therefore a *regression gate* for that today-behavior
;; rather than a trampoline case. The actual trampoline gap for class
;; (c) is *call_indirect combined with another unsupported pattern* —
;; e.g. `nested_call_indirect_with_carryover.wat` (TODO in 2.5: add the
;; real trampoline-required call_indirect fixture once we audit which
;; LLVM emission shapes actually trigger it in practice).
;;
;; Top-level call_indirect is also handled (`partition_body` splits on
;; both `Call` and `CallIndirect` at the top level — instrument.rs:940-947).

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))

  (memory (export "memory") 1)

  (type $forker_t (func (result i32)))

  (table 1 funcref)
  (elem (i32.const 0) func $do_fork)

  ;; Fork-path callee — just delegates to kernel_fork.
  (func $do_fork (result i32)
    (call $kernel_fork))

  (func $main (export "_start") (result i32)
    (local $pid i32)
    (local $i i32)

    (local.set $i (i32.const 0))
    (loop $L
      ;; Nested call_indirect to a fork-path callee.
      (local.set $pid (call_indirect (type $forker_t) (i32.const 0)))

      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $L (i32.lt_s (local.get $i) (i32.const 1)))
    )

    (local.get $pid)))
