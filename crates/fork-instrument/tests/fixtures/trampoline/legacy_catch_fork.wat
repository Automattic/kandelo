;; A fork from a legacy catch handler. The implicit legacy exception context
;; must be made activation-owned before nested switch replay can resume here.
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))

  (tag $number (param i32))

  (memory (export "memory") 1)

  (func $main (export "_start") (result i32)
    (try (result i32)
      (do
        i32.const 37
        throw $number)
      (catch $number
        ;; Keep the payload below the fork result to exercise the handler's
        ;; typed operand stack as well as its implicit exception context.
        call $kernel_fork
        drop))))
