;; Function $asymmetric-contradiction from Binaryen PR #9258's regression
;; test (test/lit/passes/constraint-analysis.wast). No Kandelo code.
(module
  (func $asymmetric-contradiction (export "f") (param $0 i32) (param $1 i32)
    (if
      (i32.and
        (i32.ge_u (local.get $0) (i32.const -1))
        (i32.lt_u (local.get $0) (local.get $1)))
      (then
        (if (i32.const 0) (then))))))
