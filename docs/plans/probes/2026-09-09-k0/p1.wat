(module
  ;; A module's own finite, statically-known GC type section.
  (type $Base    (sub    (struct (field i32))))
  (type $Derived (sub $Base (struct (field i32) (field i32))))
  (type $Other   (struct (field f64)))
  (type $ArrI32  (array (mut i32)))
  (type $ArrF64  (array (mut f64)))
  (type $ArrRef  (array (mut anyref)))
  ;; Structurally identical to $Base, declared separately: does wasm type
  ;; canonicalization make them indistinguishable (and therefore equivalent
  ;; for reconstruction)?
  (type $BaseTwin (sub (struct (field i32))))

  ;; Generated discrimination cascade, most-derived first.
  (func $disc (param $x anyref) (result i32)
    (if (ref.test (ref $Derived) (local.get $x)) (then (return (i32.const 2))))
    (if (ref.test (ref $Base)    (local.get $x)) (then (return (i32.const 1))))
    (if (ref.test (ref $Other)   (local.get $x)) (then (return (i32.const 3))))
    (if (ref.test (ref $ArrI32)  (local.get $x)) (then (return (i32.const 4))))
    (if (ref.test (ref $ArrF64)  (local.get $x)) (then (return (i32.const 5))))
    (if (ref.test (ref $ArrRef)  (local.get $x)) (then (return (i32.const 6))))
    (i32.const 0))

  (func (export "d_base")    (result i32) (call $disc (struct.new $Base (i32.const 1))))
  (func (export "d_derived") (result i32) (call $disc (struct.new $Derived (i32.const 1) (i32.const 2))))
  (func (export "d_other")   (result i32) (call $disc (struct.new $Other (f64.const 1))))
  (func (export "d_arri32")  (result i32) (call $disc (array.new $ArrI32 (i32.const 0) (i32.const 4))))
  (func (export "d_arrf64")  (result i32) (call $disc (array.new $ArrF64 (f64.const 0) (i32.const 4))))
  (func (export "d_arrref")  (result i32) (call $disc (array.new $ArrRef (ref.null any) (i32.const 4))))

  ;; Does a $BaseTwin instance test as $Base? (canonicalization)
  (func (export "twin_is_base") (result i32)
    (ref.test (ref $Base) (struct.new $BaseTwin (i32.const 9))))

  ;; Can contents be read back generically once the type is known?
  (func (export "roundtrip_arr_len") (result i32)
    (array.len (array.new $ArrI32 (i32.const 7) (i32.const 5))))
  (func (export "roundtrip_struct_field") (result i32)
    (struct.get $Derived 1 (struct.new $Derived (i32.const 10) (i32.const 20))))
)
