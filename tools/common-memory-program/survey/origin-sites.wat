(module
  (import "env" "memory" (memory 2 65536 shared))
  (global (export "__stack_pointer") (mut i32) (i32.const 65536))
  (func (export "load32") (param i32) (result i32)
    local.get 0 i32.load)
  (func (export "store32") (param i32 i32)
    local.get 0 local.get 1 i32.store)
  (func (export "frame") (result i32) (local i32 i32)
    global.get 0 i32.const 16 i32.sub local.tee 0 global.set 0
    local.get 0 i32.load drop
    local.get 0 i32.const 7 i32.store
    local.get 0 i32.load local.set 1
    local.get 0 i32.const 16 i32.add global.set 0
    local.get 1)
  (func (export "invariant") (param i32 i32) (result i32) (local i32 i32)
    loop
      local.get 3 local.get 0 i32.load i32.add local.set 3
      local.get 2 i32.const 1 i32.add local.tee 2
      local.get 1 i32.lt_u br_if 0
    end
    local.get 3)
  (func (export "stride") (param i32 i32) (result i32) (local i32 i32)
    loop
      local.get 3 local.get 0 local.get 2 i32.const 2 i32.shl i32.add
      i32.load i32.add local.set 3
      local.get 2 i32.const 1 i32.add local.tee 2
      local.get 1 i32.lt_u br_if 0
    end
    local.get 3))
