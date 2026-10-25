(module
  (type $node (struct (field (mut (ref null $node))) (field (mut (ref null exn)))))
  (type $bytes (array i8))
  (tag $payload (param (ref null any)))
  (data $data "BC")
  (global $root (mut (ref null $node)) (ref.null $node))
  (global $exception (mut (ref null exn)) (ref.null exn))
  (global $array (mut (ref null $bytes)) (ref.null $bytes))
  (func (export "make")
    (local $node (ref null $node)) (local $exception (ref null exn))
    struct.new_default $node local.set $node
    local.get $node local.get $node struct.set $node 0
    block $caught (result (ref exn))
      try_table (catch_all_ref $caught) local.get $node throw $payload end
      unreachable
    end
    local.set $exception
    local.get $node local.get $exception struct.set $node 1
    local.get $node global.set $root
    local.get $exception global.set $exception
    i32.const 0 i32.const 2 array.new_data $bytes $data global.set $array
    data.drop $data)
  (func (export "verify") (result i32)
    (local $value (ref null any))
    block $caught (result (ref null any))
      try_table (catch $payload $caught)
        global.get $exception ref.as_non_null throw_ref
      end
      unreachable
    end
    local.set $value
    local.get $value ref.cast (ref $node) global.get $root ref.eq
    global.get $root struct.get $node 0 global.get $root ref.eq i32.and
    global.get $array i32.const 1 array.get_u $bytes i32.const 67 i32.eq i32.and)
  (func (export "probe_dropped") i32.const 0 i32.const 1 array.new_data $bytes $data drop))
