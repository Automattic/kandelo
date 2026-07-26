(module
  (type $box (struct (field (mut i32))))
  (import "env" "__wpk_fork_ref_gc_transit"
    (table $transit 1 (ref null any)))
  (func (export "publish") (param $value i32)
    i32.const 0
    local.get $value
    struct.new $box
    table.set $transit))
