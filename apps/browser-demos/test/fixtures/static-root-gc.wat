(module
  (type $pair (struct (field i32)))
  (global $root (ref $pair)
    (struct.new $pair (i32.const 41)))
  (table $catalog (export "catalog") 1 1 (ref null any))

  (func (export "harvest")
    i32.const 0
    global.get $root
    table.set $catalog)

  (func (export "matches_root")
    (param (ref null $pair))
    (result i32)
    local.get 0
    global.get $root
    ref.eq))
