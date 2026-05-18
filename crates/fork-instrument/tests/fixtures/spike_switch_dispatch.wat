;; Spike fixture for the switch-dispatch redesign described in
;; docs/plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md.
;;
;; Hand-authored approximation of the post-redesign transform applied
;; to a main function that performs:
;;
;;   1. a non-fork-path direct call: side_effect(42)
;;   2. a fork-path direct call: kernel_fork()
;;   3. a non-fork-path direct call using the fork result: side_effect(fork_result)
;;
;; Shape proven here:
;;
;; - Preamble at function entry reads frame header + call_idx when state
;;   is REWINDING.
;; - Nested block structure: (block $unwind_save (block $POST_0
;;   (block $dispatch_normal ...))), with a `br_table` inside a
;;   REWINDING guard that lands execution at `$POST_0` (skipping the
;;   non-fork-path side_effect call in the chunk that precedes the
;;   fork-path call site).
;; - Post-call Phase 6e / UNWINDING propagation scaffolding.
;; - Postamble reached only via `br $unwind_save` during UNWINDING.
;;
;; The five exported wpk_fork_* functions and the two runtime globals
;; are hand-emitted to match what `crates/fork-instrument/src/runtime.rs`
;; would produce, so the module satisfies the host's instrumentation
;; check (`wpk_fork_state` export lookup).

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))
  (import "kernel" "side_effect" (func $side_effect (param i32)))

  (memory (export "memory") 1)

  (global $_wpk_fork_state (mut i32) (i32.const 0))
  (global $_wpk_fork_buf (mut i32) (i32.const 0))

  ;; ---- wpk_fork_unwind_begin(buf) ----
  (func $wpk_fork_unwind_begin (export "wpk_fork_unwind_begin") (param $buf i32)
    (global.set $_wpk_fork_state (i32.const 1))
    (global.set $_wpk_fork_buf (local.get $buf))
    ;; Seed current_pos = frames_start_offset. Header = 2 * ptr (8 bytes
    ;; on wasm32) + 0 saved globals. So frames start at offset 8.
    (i32.store (local.get $buf) (i32.const 8))
  )

  ;; ---- wpk_fork_unwind_end() ----
  (func $wpk_fork_unwind_end (export "wpk_fork_unwind_end")
    (global.set $_wpk_fork_state (i32.const 0))
  )

  ;; ---- wpk_fork_rewind_begin(buf) ----
  (func $wpk_fork_rewind_begin (export "wpk_fork_rewind_begin") (param $buf i32)
    (global.set $_wpk_fork_state (i32.const 2))
    (global.set $_wpk_fork_buf (local.get $buf))
  )

  ;; ---- wpk_fork_rewind_end() ----
  (func $wpk_fork_rewind_end (export "wpk_fork_rewind_end")
    (global.set $_wpk_fork_state (i32.const 0))
  )

  ;; ---- wpk_fork_state() -> i32 ----
  (func $wpk_fork_state (export "wpk_fork_state") (result i32)
    (global.get $_wpk_fork_state)
  )

  ;; Main function with a single fork-path call, two non-fork-path calls
  ;; flanking it, instrumented in the new switch-dispatch shape.
  ;;
  ;; Frame layout (total 20 bytes):
  ;;   +0  i32 func_index
  ;;   +4  i32 call_idx
  ;;   +8  i32 catch_region_id  (unused in spike; always 0)
  ;;   +12 i32 exnref_slot      (unused in spike; always 0)
  ;;   +16 i32 user_local: fork_result
  (func $main (export "_start") (result i32)
    (local $call_idx_local i32)
    (local $frame_ptr_local i32)
    (local $catch_region_id_local i32)
    (local $exnref_slot_local i32)
    (local $fork_result i32)

    ;; === 1. PREAMBLE ===
    ;; Only runs when state == REWINDING.
    (if (i32.eq (global.get $_wpk_fork_state) (i32.const 2))
      (then
        ;; frame_ptr = *(buf + 0) - 20
        (local.set $frame_ptr_local
          (i32.sub
            (i32.load (global.get $_wpk_fork_buf))
            (i32.const 20)))
        ;; *(buf + 0) = frame_ptr  (pop frame)
        (i32.store
          (global.get $_wpk_fork_buf)
          (local.get $frame_ptr_local))
        ;; Restore call_idx_local + catch + exnref + user scalar locals.
        (local.set $call_idx_local
          (i32.load offset=4 (local.get $frame_ptr_local)))
        (local.set $catch_region_id_local
          (i32.load offset=8 (local.get $frame_ptr_local)))
        (local.set $exnref_slot_local
          (i32.load offset=12 (local.get $frame_ptr_local)))
        (local.set $fork_result
          (i32.load offset=16 (local.get $frame_ptr_local)))
      )
    )

    ;; === 2. DISPATCH + WRAPPER + POST LABELS ===
    (block $unwind_save
      (block $POST_0
        (block $dispatch_normal
          (if (i32.eq (global.get $_wpk_fork_state) (i32.const 2))
            (then
              ;; br_table labels: [$POST_0, $unwind_save]
              ;;   idx == 0 -> $POST_0
              ;;   idx >= 1 -> $unwind_save (defensive default; spike has
              ;;               only one fork-path call site)
              (br_table $POST_0 $unwind_save (local.get $call_idx_local))
            )
          )
          ;; NORMAL path falls through to the chunk below.
        )
        ;; --- chunk 0: non-fork-path ops on the NORMAL path only ---
        ;; This MUST NOT execute during REWINDING.
        (call $side_effect (i32.const 42))
        ;; (no args to spill for kernel_fork)
      )
      ;; --- $POST_0 landing: reached on NORMAL fallthrough OR via
      ;;     br_table idx=0 during REWINDING dispatch. ---
      (call $kernel_fork)
      (local.set $fork_result)
      ;; Phase 6e: no catch region active in the spike, skip.
      (local.set $call_idx_local (i32.const 0))
      ;; UNWINDING propagation: if the callee just unwound, save our
      ;; frame via $unwind_save.
      (if (i32.eq (global.get $_wpk_fork_state) (i32.const 1))
        (then (br $unwind_save)))
      ;; --- chunk 1: tail, after the last fork-path call ---
      (call $side_effect (local.get $fork_result))
      (return (local.get $fork_result))
    )

    ;; === 3. POSTAMBLE (reached only via br $unwind_save) ===
    (local.set $frame_ptr_local
      (i32.load (global.get $_wpk_fork_buf)))
    (i32.store offset=0  (local.get $frame_ptr_local) (i32.const 0))       ;; func_index
    (i32.store offset=4  (local.get $frame_ptr_local) (local.get $call_idx_local))
    (i32.store offset=8  (local.get $frame_ptr_local) (local.get $catch_region_id_local))
    (i32.store offset=12 (local.get $frame_ptr_local) (local.get $exnref_slot_local))
    (i32.store offset=16 (local.get $frame_ptr_local) (local.get $fork_result))
    (i32.store
      (global.get $_wpk_fork_buf)
      (i32.add (local.get $frame_ptr_local) (i32.const 20)))
    ;; Default return for the function's result type.
    (i32.const 0)
  )
)
