;; Reduced by wasm-reduce from FFmpeg ff_spatial_dwt (libavcodec/snow_dwt.c)
;; as it stood in ffplay.wasm just before constraint-analysis in -Os.
;; Contains no Kandelo code. Trigger: wasm-opt <this> --constraint-analysis
(module
 (type $0 (func (param i32 i32 i32 i32 i32 i32 i32)))
 (func $0 (type $0) (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 i32) (param $5 i32) (param $6 i32)
  (local.set $2
   (i32.const -2)
  )
  (if
   (i32.const 0)
   (then
    (drop
     (if (result i32)
      (i32.le_u
       (local.get $3)
       (local.get $2)
      )
      (then
       (loop (result i32)
        (i32.const 0)
       )
      )
      (else
       (i32.const 0)
      )
     )
    )
    (if
     (i32.le_u
      (local.tee $4
       (i32.add
        (i32.const 0)
        (i32.const 0)
       )
      )
      (local.get $3)
     )
     (then
      (unreachable)
     )
    )
    (loop $label
     (br_if $label
      (i32.const 0)
     )
    )
    (unreachable)
   )
  )
 )
)

