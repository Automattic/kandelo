;; Trampoline class (a): fork-path call inside a multi-value-params
;; block.
;;
;; Today this routes to guard-dispatch via `classify_nested_pattern`
;; returning `UnsupportedMultiValueParams` (instrument.rs:4124). The
;; nested switch-dispatch refuses to extract through a block whose
;; type signature consumes multiple operand-stack values from the
;; enclosing scope, because the spilled-args mechanism only covers
;; the call's own args.
;;
;; Under the trampoline scheme the entire prefix of values consumed
;; by the block becomes part of the carryover save, and the post-call
;; extraction function takes them as parameters.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))

  (memory (export "memory") 1)

  ;; A block type that consumes [i32 i32] and produces [i32]. Defining
  ;; it as a function type and referencing it via `(type 0)` is how
  ;; wasm encodes multi-value-params blocks.
  (type $two_to_one (func (param i32 i32) (result i32)))

  (func $main (export "_start") (result i32)
    (local $pid i32)

    ;; Push two values onto the stack BEFORE the block. The block
    ;; consumes them as its params and returns one i32.
    i32.const 7
    i32.const 11
    (block $B (type $two_to_one)
      ;; Inside the block: the two params are on the stack as
      ;; the block's locals. Add them, then call kernel_fork
      ;; (which consumes 0 and pushes 1). Then drop the fork
      ;; result and return the sum.
      i32.add
      call $kernel_fork
      drop)

    (local.set $pid)
    (local.get $pid)))
