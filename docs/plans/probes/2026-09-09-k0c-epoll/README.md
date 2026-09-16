# K0c probe — the V8 `epoll_pwait` claim (2026-09-09)

## The claim under test

`host/src/kernel-worker.ts:12274`:

> `kernel_handle_channel` crashes in Chrome (V8 shared-memory Wasm bug) for
> `epoll_pwait`. Handle `epoll_create1`/`ctl` on the kernel but mirror the
> interest list, and convert `epoll_pwait` to poll entirely on the host.

Origin: commit `4131f2498`, **2026-04-01**, PR #141 ("fix: WordPress browser
demo — epoll, fork stack overflow, file overwrite"). The commit message says
*"epoll_pwait crashes in Chrome due to a **suspected** V8 bug with shared
Wasm memory."* The inline comment later hardened that suspicion into an
assertion of fact. It has never been re-checked, has no
`docs/browser-support.md` entry, and cites no V8 issue.

This matters beyond epoll: the mirror it justifies is a **second authority**
for the epoll interest list, and reference analysis shows it is read and
written from 10 methods including fork inheritance, exec fd-mirror pruning,
child rollback, and process teardown.

## Method

Drive `SYS_EPOLL_PWAIT` (241) through `kernel_handle_channel` on the **real**
`local-binaries/kernel.wasm` (ABI 44) — the exact call the claim names.
Deliberately minimal: no guest, no VFS, no host runtime. Just a kernel
instance on a **shared** `WebAssembly.Memory`, a process, an `eventfd` with a
nonzero counter (so the fd is genuinely `EPOLLIN`-ready and there is a real
result to write back), an epoll instance with that interest, and a channel
record.

Four configurations, because the claim is specifically about *shared* Wasm
memory:

1. Node main thread (baseline).
2. Browser page main thread, under real cross-origin isolation
   (`COOP: same-origin` + `COEP: require-corp`, `crossOriginIsolated === true`,
   so `SharedArrayBuffer` is live).
3. Browser **dedicated Worker** — the production topology, where the kernel
   actually runs.
4. Same, with a **second worker concurrently reading the kernel's
   SharedArrayBuffer**, so the memory is genuinely multi-threaded-shared
   while the kernel call runs — as process workers make it in production.

Each configuration also issues **2,000 repeat calls** after the first, since
a JIT-tiering bug would need warm-up to appear.

## Reproduce

```
node run-node.mjs        # Node baseline
node run-browsers.mjs    # Chromium + WebKit, main thread AND dedicated worker
```

Serves over a local HTTP server with COOP/COEP; uses the repo's Playwright
browsers. Raw output in `results.json`.

## Result — 2026-09-09: THE CLAIM DOES NOT REPRODUCE

| configuration | Node v24.15.0 | Chromium 151.0.7922.34 | WebKit 26.5 |
|---|---|---|---|
| main thread | OK | OK | OK |
| dedicated worker + peer sharing memory | — | OK | OK |

In every configuration `kernel_handle_channel` returned **1**, the channel
carried `return = 1`, `errno = 0`, and the written-back event was
`events = EPOLLIN(1)`, `data = 0xdeadbeef` — the exact value registered.
2,000 further calls survived. No page crash, no `pageerror`, no trap.

## Scope honesty

This exercises the syscall the claim names, on the real kernel, in the
production threading topology. It does **not** replay the full WordPress
demo under which the crash was originally observed in April 2026 — a
different guest, a different kernel (pre-ABI-44), and a five-months-older
Chrome. So this is not proof that nothing was ever wrong; it is evidence
that **the stated boundary does not exist on today's engines and today's
kernel**, and therefore must not be inherited as a floor.

The honest next step is not to trust this comment further but to delete the
mirror and let the conformance and browser suites speak. If something does
break, it will be reproducible and can be documented properly — which is
what should have happened in the first place.
