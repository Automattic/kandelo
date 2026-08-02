(module
  (import "env" "memory" (memory 1 4 shared))

  ;; Access through Wasm so the fixture observes the engine's compiled memory
  ;; bounds, not only the JavaScript Memory wrapper's current buffer length.
  (func (export "store_then_load")
    (param $address i32)
    (param $value i32)
    (result i32)
    local.get $address
    local.get $value
    i32.store
    local.get $address
    i32.load))
