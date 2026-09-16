(module
  (type $Obj (sub (struct (field i32))))
  (global $saved (mut anyref) (ref.null any))

  ;; P2a: pure in-wasm round trip. Is a GC object still ref.eq to itself
  ;; after extern.convert_any -> any.convert_extern?
  (func (export "p2a") (result i32)
    (local $x (ref $Obj))
    (local.set $x (struct.new $Obj (i32.const 42)))
    (ref.eq (local.get $x)
            (ref.cast (ref eq)
              (any.convert_extern (extern.convert_any (local.get $x))))))

  ;; P2b: round trip THROUGH THE HOST. `make` hands JS an externref derived
  ;; from a GC object; JS gives it back to `check`, which must recover
  ;; identity. This is the actual fork scenario.
  (func (export "make") (result externref)
    (local $x (ref $Obj))
    (local.set $x (struct.new $Obj (i32.const 7)))
    (global.set $saved (local.get $x))
    (extern.convert_any (local.get $x)))

  (func (export "check") (param $e externref) (result i32)
    (local $a anyref)
    (local.set $a (any.convert_extern (local.get $e)))
    (if (i32.eqz (ref.test (ref eq) (local.get $a))) (then (return (i32.const 0))))
    (if (i32.eqz (ref.test (ref eq) (global.get $saved))) (then (return (i32.const 0))))
    (ref.eq (ref.cast (ref eq) (local.get $a))
            (ref.cast (ref eq) (global.get $saved))))

  ;; Can the concrete type still be recovered after the host round trip?
  (func (export "check_type") (param $e externref) (result i32)
    (ref.test (ref $Obj) (any.convert_extern (local.get $e))))

  ;; P2c CONTROL: a genuine HOST externref (a plain JS object). The
  ;; 2026-09-03 probe found this is NOT eq-comparable once internalized.
  ;; Expect 0 on every engine; that is the real floor.
  (func (export "check_host_externref_is_eq") (param $e externref) (result i32)
    (ref.test (ref eq) (any.convert_extern (local.get $e))))
)
