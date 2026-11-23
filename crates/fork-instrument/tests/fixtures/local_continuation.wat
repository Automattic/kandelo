(module
  (type $resume (func (result i32)))
  (table (export "__kandelo_local_continuation_resume_table") 16 funcref)
  (tag $unwind (export "__kandelo_local_continuation_unwind_tag"))
  (memory (export "memory") 2)
  (global $__stack_pointer (export "sp") (mut i32) (i32.const 65536))
  (global $counter (export "counter") (mut i32) (i32.const 0))

  (func $unwind_begin (export "__kandelo_local_continuation_unwind_begin") (param i32) unreachable)
  (func $unwind_end (export "__kandelo_local_continuation_unwind_end") unreachable)
  (func $rewind_begin (export "__kandelo_local_continuation_rewind_begin") (param i32) unreachable)
  (func $rewind_end (export "__kandelo_local_continuation_rewind_end") unreachable)
  (global $active (mut i32) (i32.const 0))
  (global $phase (mut i32) (i32.const 0))
  (global $repeat (mut i32) (i32.const 0))

  ;; Descriptor offset 32 holds the newest capture. Offset 36 holds the
  ;; allocation cursor. Each node stores a previous link, size and payload.
  (func (export "__kandelo_local_continuation_reserve") (param $size i32) (result i32)
    (local $node i32) (local $end i32)
    global.get $active i32.load offset=36 local.tee $node
    local.get $size i32.add i32.const 15 i32.add i32.const -8 i32.and
    local.tee $end global.get $active i32.const 2048 i32.add i32.gt_u
    if unreachable end
    global.get $active local.get $end i32.store offset=36
    local.get $node local.get $size i32.store offset=4
    local.get $node i32.const 8 i32.add)

  (func (export "__kandelo_local_continuation_commit") (param $payload i32)
    (local $node i32)
    local.get $payload i32.const 8 i32.sub local.tee $node
    global.get $active i32.load offset=32 i32.store
    global.get $active local.get $node i32.store offset=32)

  (func $peek (export "__kandelo_local_continuation_peek") (param $size i32) (result i32)
    (local $node i32)
    global.get $active i32.load offset=32 local.tee $node i32.eqz
    if unreachable end
    local.get $node i32.load offset=4 local.get $size i32.ne
    if unreachable end
    local.get $node i32.const 8 i32.add)

  (func (export "__kandelo_local_continuation_next") (param $size i32) (result i32)
    (local $payload i32)
    local.get $size call $peek local.set $payload
    global.get $active
    local.get $payload i32.const 8 i32.sub i32.load
    i32.store offset=32
    local.get $payload)

  (func $resume_peek (export "__kandelo_local_continuation_resume_peek") (param i32) (result i32)
    (local $node i32)
    global.get $active i32.load offset=32 local.tee $node i32.eqz
    if (result i32) i32.const 0 else local.get $node i32.load offset=8 i32.const 1 i32.add end)

  (func $prepare_capture
    global.get $active i32.const 0 i32.store offset=32
    global.get $active global.get $active i32.const 40 i32.add i32.store offset=36
    i32.const 1 global.set $phase)

  (func $fork (export "__kandelo_local_continuation_suspend") (param $ordinal i32) (result i32)
    global.get $phase i32.const 1 i32.eq
    if
      global.get $active call $unwind_begin
      i32.const 0 return
    end
    global.get $phase i32.const 2 i32.eq
    if
      global.get $active i32.load offset=32 if unreachable end
      call $rewind_end
      i32.const 0 global.set $phase
      global.get $repeat if call $prepare_capture end
      i32.const 0 return
    end
    local.get $ordinal i32.const 10 i32.add)

  (func (export "run") (export "__kandelo_local_continuation_dispatch")
      (param $record i32) (param $top i32) (param $arg i32) (param $resume i32)
      (result i32)
    local.get $record global.set $active
    local.get $resume i32.const 2 i32.eq global.set $repeat
    block $suspended
      try_table (result i32) (catch $unwind $suspended)
        local.get $resume
        if (result i32)
          i32.const 2 global.set $phase
          local.get $record call $rewind_begin
          i32.const 0 call $resume_peek call_indirect (type $resume)
        else
          call $prepare_capture
          local.get $top global.set $__stack_pointer
          local.get $arg call $root
        end
      end
      return
    end
    local.get $record i32.load offset=32 i32.eqz if unreachable end
    call $unwind_end
    i32.const -1)

  ;; Reference values are outside this scalar fixture. If the planner emits a
  ;; reference path here, let the test trap rather than supply a fake value.
  (func (export "__kandelo_local_continuation_vector_begin") (param i32) (result i32) unreachable)
  (func (export "__kandelo_local_continuation_vector_append") (param i32 i32) unreachable)
  (func (export "__kandelo_local_continuation_vector_finish") (param i32) (result i32) unreachable)
  (func (export "__kandelo_local_continuation_vector_get") (param i32 i32) (result i32) unreachable)
  (func (export "__kandelo_local_continuation_encode_funcref") (param funcref) (result i32) unreachable)
  (func (export "__kandelo_local_continuation_decode_funcref") (param i32) (result funcref) unreachable)
  (func (export "__kandelo_local_continuation_encode_externref") (param externref) (result i32) unreachable)
  (func (export "__kandelo_local_continuation_decode_externref") (param i32) (result externref) unreachable)
  (func (export "__kandelo_local_continuation_encode_exnref") (param exnref) (result i32) unreachable)
  (func (export "__kandelo_local_continuation_decode_exnref") (param i32) (result exnref) unreachable)
  (func (export "__kandelo_local_continuation_encode_anyref") (param anyref) (result i32) unreachable)
  (func (export "__kandelo_local_continuation_decode_anyref") (param i32) (result anyref) unreachable)

  (func $child (param i32) (result i32)
    local.get 0 if (result i32) i32.const 3 call $fork else i32.const 4 call $fork end
    local.get 0 i32.add)

  (func $root (param i32) (result i32)
    (local $prior i32)
    global.get $__stack_pointer local.tee $prior i32.const 16 i32.sub
    global.set $__stack_pointer
    local.get $prior i32.const 4 i32.sub local.get 0 i32.store
    global.get $counter i32.const 1 i32.add global.set $counter
    local.get 0 call $child
    global.get $counter i32.const 1 i32.add global.set $counter
    i32.const 2 call $fork i32.add
    local.get $prior i32.const 4 i32.sub i32.load local.get 0 i32.ne
    if unreachable end
    global.get $__stack_pointer local.get $prior i32.const 16 i32.sub i32.ne
    if unreachable end
    local.get $prior global.set $__stack_pointer)
)
