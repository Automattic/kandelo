# Probe: does the side module survive transfer and compile in the worker?

**Question.** K5 I6a wired four browser registration points. Three were closed
against a real dev server. The fourth — `postMessage` **transfer** of
`dylinkModuleBytes` followed by `WebAssembly.compile` inside the kernel worker
— was reported unproven, because the app never booted here:
`prepare-browser` exits 1 on `php` (ICU `pkg-config`) and `wget` (TLS), which
blocks twelve nodes and makes the resolver refuse the closure.

**But this question does not need Kandelo.** It asks what a browser does with a
transferred `ArrayBuffer` and a real 233 KB module. So it was run directly.

## Extended to all three side modules

The probe now carries `dylink_module32.wasm`, `wasi_module32.wasm` and
`fork_module32.wasm`, mirroring the three sibling branches in
`browser-kernel-worker-entry.ts`. **All three transfer and compile on both
engines**, and all three source buffers are detached afterwards.

| module | bytes | Chromium 151 | WebKit 26.5 |
|---|---|---|---|
| `dylink_module32` | 233,500 | compiled · 0 imports · 24 exports | compiled · 0 imports · 24 exports |
| `wasi_module32` | 24,653 | compiled · 5 imports · 51 exports | compiled · 5 imports · 51 exports |
| `fork_module32` | 138,304 | compiled · 9 imports · 81 exports | **compiled**, but reflection throws — see below |

That closes the browser registration for the **WASI** side module as well as
the dynamic-linking one.

### The fork module reproduces a documented WebKit limitation, verbatim

WebKit compiles `fork_module32.wasm` successfully, then
`WebAssembly.Module.imports()` throws:

```
TypeError: WebAssembly.Module.imports unable to produce import descriptors for the given module
```

`host/src/wasm-module-reflection.ts` already documents exactly this — *"WebKit
can compile fork artifacts containing exception-reference imports while
`WebAssembly.Module.imports()` throws instead of returning their name/kind
descriptors"* — and handles it by retaining the ordered reflection Kandelo
parsed itself rather than depending on the engine's.

**The compile succeeded, which is what the registration needs.** The reflection
divergence is a separate, already-mitigated engine limitation, and this probe is
the first independent reproduction of it in the repository — the note had been
argued, not measured.

## Result — dylink module, both engines (`results.json`)

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
