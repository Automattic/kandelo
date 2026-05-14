;; Trampoline class (a): fork-path call inside a legacy `try`/`catch`
;; block.
;;
;; Today this routes to guard-dispatch via `classify_nested_pattern`
;; returning `UnsupportedLegacyTry` (instrument.rs:4103). Legacy
;; wasm-EH (the `try`/`catch` instructions, distinct from the modern
;; `try_table`) is what the SDK currently lowers C++ EH to (see C5 in
;; the unsupported-cases review). Switch-dispatch refuses to extract
;; through legacy try/catch boundaries because the catch handler
;; receives the exception payload via an implicit operand-stack push
;; that doesn't fit the partition model.
;;
;; Under the trampoline scheme the post-call body inside the try is
;; extracted into its own function with an additional control-state
;; argument indicating whether it was reached via NORMAL flow or
;; through the catch handler.
;;
;; Note: legacy `try`/`catch` is NOT supported by `wat::parse_str` in
;; some toolchain versions because it requires the legacy-EH feature
;; to be enabled. If this fixture fails to parse on the host's wat
;; crate version, the test driver in trampoline.rs falls back to
;; skipping the legacy_try_fork tests until the modern-EH SDK flip
;; (commit 9 of the mega-PR) eliminates legacy EH entirely.

(module
  (import "kernel" "kernel_fork" (func $kernel_fork (result i32)))

  (tag $exn (param i32))

  (memory (export "memory") 1)

  (func $main (export "_start") (result i32)
    (local $pid i32)

    ;; Legacy try/catch with fork inside the try body.
    (try $T
      (do
        (local.set $pid (call $kernel_fork)))
      (catch $exn
        ;; Catch handler — discard the i32 payload, recover with -1.
        drop
        (local.set $pid (i32.const -1))))

    (local.get $pid)))
