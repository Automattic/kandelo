;; K10 probe 2 — the channel wait, in wasm.
;;
;; Mirrors `WasiShim.doSyscall` (`host/src/wasi-shim.ts:490-544`) exactly:
;;
;;   Atomics.store(i32, statusIdx, CH_PENDING);
;;   Atomics.notify(i32, statusIdx, 1);
;;   while (Atomics.wait(i32, statusIdx, CH_PENDING) === "ok") { }
;;   ... read CH_RETURN / CH_ERRNO ...
;;   Atomics.store(i32, statusIdx, CH_IDLE);
;;
;; `memory.atomic.wait32` returns 0 = ok (woken), 1 = not-equal, 2 = timed-out,
;; so `=== "ok"` becomes `== 0` and the re-wait loop is preserved: a spurious
;; wake that leaves the word at CH_PENDING must go back to sleep, exactly as
;; the TypeScript does.
;;
;; CHANNEL_STATUS_IDLE = 0, CHANNEL_STATUS_PENDING = 1 (host/src/generated/abi.ts:892).
(module
  (import "env" "memory" (memory 1 65536 shared))

  (global $CH_PENDING i32 (i32.const 1))
  (global $CH_IDLE i32 (i32.const 0))

  ;; Publish a pending request at $base and block until the kernel side moves
  ;; the status word away from CH_PENDING. Returns the number of times the
  ;; wait re-slept, so a spurious-wake loop is observable rather than hidden.
  (func (export "chan_call") (param $base i32) (param $timeout_ns i64) (result i32)
    (local $r i32) (local $sleeps i32)
    (i32.atomic.store (local.get $base) (global.get $CH_PENDING))
    (drop (memory.atomic.notify (local.get $base) (i32.const 1)))
    (block $done
      (loop $again
        (local.set $r
          (memory.atomic.wait32
            (local.get $base) (global.get $CH_PENDING) (local.get $timeout_ns)))
        ;; 1 = not-equal (the word already moved), 2 = timed out -> stop.
        (br_if $done (i32.ne (local.get $r) (i32.const 0)))
        (local.set $sleeps (i32.add (local.get $sleeps) (i32.const 1)))
        (br $again)))
    (i32.atomic.store (local.get $base) (global.get $CH_IDLE))
    ;; low 16 bits = final wait result, high bits = re-sleep count
    (i32.or (local.get $r) (i32.shl (local.get $sleeps) (i32.const 16))))

  ;; A bare wait, so the "did a JS Atomics.notify wake a wasm waiter" question
  ;; can be answered without the surrounding protocol.
  (func (export "bare_wait") (param $addr i32) (param $expect i32) (param $timeout_ns i64) (result i32)
    (memory.atomic.wait32 (local.get $addr) (local.get $expect) (local.get $timeout_ns)))

  ;; The reverse direction: wasm notifies a JS `Atomics.wait` waiter.
  (func (export "store_and_notify") (param $addr i32) (param $value i32) (result i32)
    (i32.atomic.store (local.get $addr) (local.get $value))
    (memory.atomic.notify (local.get $addr) (i32.const -1)))

  (func (export "atomic_load") (param $addr i32) (result i32)
    (i32.atomic.load (local.get $addr))))
