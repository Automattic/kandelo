;; Trampoline class (a): fork-path call inside a legacy `try`/`catch`
;; block.
;;
;; This routes through nested switch-dispatch. CI for the fork-instrument
;; PR showed that shipping C ports can still contain legacy `try` bodies
;; even with explicit modern-EH flags. A fork in the try body can be
;; handled like a fork inside a Block/Loop/TryTable body.
;;
;; Legacy catch-handler forks remain different: the handler receives the
;; exception payload via the exception path, so REWIND would need to
;; reconstruct that path before nested switch-dispatch can resume inside
;; the handler.
;;
;; Note: legacy `try`/`catch` is NOT supported by `wat::parse_str` in
;; some toolchain versions because it requires the legacy-EH feature
;; to be enabled. If this fixture fails to parse on the host's wat
;; crate version, the test driver in trampoline.rs falls back to
;; skipping the legacy_try_fork test.

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
