(module
  (import "env" "memory" (memory 1 256 shared))
  (func (export "touch") (param i32) (result i32)
    local.get 0
    i32.load
    memory.size
    i32.xor))
