;; Two translation units each define a static `cleanup`. Only b.c's reaches
;; fork. a.c's `caller` registers its own `cleanup` with pthread_cleanup_push
;; and runs it through `_pthread_cleanup_pop`'s indirect call, which (by its
;; source type) can only reach a.c's handler. Resolving the registered handler
;; by name alone made `caller` look fork-reaching through b.c's `cleanup`.
(module
  (type $v (func))
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (memory 1)
  (table 2 funcref)
  (elem (i32.const 0) $cleanup_a $cleanup_b)
  ;; a.c
  (func $cleanup_a (@name "cleanup") (type $v))
  (func $caller (call $_pthread_cleanup_pop (i32.const 0)))
  ;; b.c
  (func $cleanup_b (@name "cleanup") (type $v) (drop (call $kernel_fork (i32.const 0))))
  ;; pthread_cleanup_pop.c
  (func $_pthread_cleanup_pop (param i32) (call_indirect (type $v) (local.get 0)))
  (func $_start (export "_start") (call $caller) (call $cleanup_b)))
