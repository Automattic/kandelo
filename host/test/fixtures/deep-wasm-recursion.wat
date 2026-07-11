(module
  (func $recurse (export "recurse") (param $depth i32) (result i32)
    local.get $depth
    i32.eqz
    if (result i32)
      i32.const 0
    else
      local.get $depth
      i32.const 1
      i32.sub
      call $recurse
      i32.const 1
      i32.add
    end))
