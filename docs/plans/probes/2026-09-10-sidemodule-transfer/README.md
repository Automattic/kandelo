# Probe: does the side module survive transfer and compile in the worker?

**Question.** K5 I6a wired four browser registration points. Three were closed
against a real dev server. The fourth — `postMessage` **transfer** of
`dylinkModuleBytes` followed by `WebAssembly.compile` inside the kernel worker
— was reported unproven, because the app never booted here:
`prepare-browser` exits 1 on `php` (ICU `pkg-config`) and `wget` (TLS), which
blocks twelve nodes and makes the resolver refuse the closure.

**But this question does not need Kandelo.** It asks what a browser does with a
transferred `ArrayBuffer` and a real 233 KB module. So it was run directly.

## Result — both engines (`results.json`)

| | Chromium 151.0.7922.34 | WebKit 26.5 |
|---|---|---|
| fetched | 233,500 bytes, `application/wasm` | 233,500 bytes, `application/wasm` |
| main-thread buffer detached after transfer | **true** | **true** |
| worker received an `ArrayBuffer` | yes, 233,500 bytes | yes, 233,500 bytes |
| `WebAssembly.compile` | **succeeded** | **succeeded** |
| imports | **0** | **0** |
| `dl_*` exports | **21** | **21** |

Run under real cross-origin isolation. The worker mirrors
`browser-kernel-worker-entry.ts`'s `dylinkModuleBytes` branch exactly:
`await WebAssembly.compile(msg.dylinkModuleBytes)`.

**`mainThreadBufferDetachedAfterTransfer: true` is the load-bearing row.** It
proves the bytes were *transferred* rather than *cloned* — the half no static
check can see, because a detached buffer only exists at run time. The real code
pushes onto `transfer`, so cloning would be a silent extra 233 KB allocation
per boot, and a detached-buffer bug would surface only in production.

**K5's browser registrations are now 4 of 4 closed.**

## The general point

"Browser unproven" has been used this session for two different things:

1. **Questions needing the app booted** — the MITM CA-write ordering, process
   lifecycle paths, D17's interrupt timer. These genuinely need a working
   `prepare-browser`.
2. **Questions needing only a browser** — what an engine does with a buffer
   type, a transfer, or a module. These need nothing from Kandelo, and the
   provisioning failures blocking category 1 are irrelevant to them.

Both this probe and `2026-09-10-sab-webcrypto` are category 2, and both ran to
completion on Chromium and WebKit while `prepare-browser` was broken. **The
remaining browser debt should be re-triaged on that split before the tier-end
pass**, rather than treated as one blocked pile.
