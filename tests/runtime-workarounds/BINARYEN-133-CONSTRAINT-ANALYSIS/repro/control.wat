;; Control input: a bounds-check shape constraint-analysis handles without
;; contradiction. It shows the pass runs to completion on this tool, so an
;; abort on the other inputs is about those inputs, not a broken install.
(module
  (func $control (export "f") (param $0 i32) (param $1 i32) (result i32)
    (if (result i32)
      (i32.lt_u (local.get $0) (local.get $1))
      (then
        (if (result i32)
          (i32.lt_u (local.get $0) (local.get $1))
          (then (i32.const 1))
          (else (i32.const 0))))
      (else (i32.const 2)))))
