# Node pthread shared-memory growth — 2026-08-02

## Conclusion

A Node.js pthread worker must synchronize the shared WebAssembly memory
it receives before it creates a JavaScript view or a WebAssembly
instance from that memory. Kandelo now does that by asking the memory to
grow by zero pages once at pthread startup.

Growing by zero pages does not allocate another WebAssembly page. It
asks the receiving JavaScript isolate to refresh its fixed-length view
of the shared memory's current backing store.

## Original failure

The SpiderMonkey package tests exposed an intermittent out-of-bounds
trap in a helper pthread. The address used by the guest was valid:

- the guest accessed byte `0x02d00ac4`, or 47,188,676;
- the pthread worker saw 717 pages, or 46,989,312 bytes; and
- the kernel worker saw the same memory at 752 pages, or 49,283,072
  bytes.

The pthread therefore rejected an address that was inside the live
shared memory. This was a host-runtime synchronization failure, not an
invalid guest pointer and not a SpiderMonkey-specific requirement.

The failure appeared after built-in process and pthread initialization
moved from Node's `workerData` startup path to a one-shot message. That
earlier change lets Node reclaim retired process memory substantially
sooner. Moving pthread memory back to `workerData` made this test pass,
but would restore a module-level shared-memory reference through the
ownership path that the reclamation change deliberately removed.

## Correction

The pthread startup path calls `memory.grow` with the address width's
zero value immediately after receiving its initialization data. The call
happens before the worker creates any view or WebAssembly instance from
that memory. This ordering matters because those objects can bind engine
state to the receiving isolate's current view of the memory length.

The JavaScript API represents page counts differently for the two Wasm
address widths. Memory32 accepts the number `0` and returns a number;
memory64 requires the BigInt `0n` and returns a BigInt. Kandelo selects
the zero value from the process's existing, authoritative pointer width.
It does not try to inspect `WebAssembly.Memory` because
`WebAssembly.Memory.type()` is not available in every supported engine.

The correction is host-runtime behavior shared by all pthread-using
guest programs. It does not patch SpiderMonkey, change the Kandelo ABI,
add memory, or weaken the one-shot initialization ownership contract.

V8 tracks the JavaScript objects attached to a shared WebAssembly
backing and broadcasts shared-memory growth to participating isolates.
Its grow path also broadcasts a zero-page grow. See Node.js 24.15.0's
embedded V8 sources for the [shared backing-store
contract][backing-store] and the [shared grow
implementation][shared-grow].

## Evidence

The Node measurements used:

- Kandelo PR #1188 head `39547c514e641110d30b2db136716b73e2b57789`;
- protected-main base `6024539d7849bb5f0d9c235b97218e60f03a2fef`;
- Node.js 24.15.0 from Kandelo's declared development shell;
- SpiderMonkey 140.11.0esr revision 11 with cache key
  `83ce9ad65c9abbd9bddeee7ff39f92da696c1c41848de40b47350d963f7764ed`;
  and
- `js.wasm` SHA-256
  `6e611697a9f73beaa26c5015467eb0dd4d8292da53576cf29b216a57a591ed71`.

The complete package test file was run from its prepared
single-provenance workspace with:

```bash
scripts/dev-shell.sh npx vitest run \
  packages/registry/spidermonkey/test/spidermonkey.test.ts \
  --maxWorkers=1
```

The focused committed tests run with:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/shared-wasm-memory-growth.test.ts \
  test/shared-wasm-memory-growth-isolate.test.ts \
  test/pthread-shared-memory-growth.test.ts --maxWorkers=1
```

The exact Kandelo SpiderMonkey test is the executable regression
authority:

| Variant                                       |            Result |
| --------------------------------------------- | ----------------: |
| Existing startup, complete test file          |   14 of 19 passed |
| Synchronize before local use                  |   19 of 19 passed |
| Existing startup, repeated helper launch      |   17 of 40 passed |
| Synchronize before local use, repeated launch | 100 of 100 passed |

A deterministic three-isolate Node test also protects the intended
contract. One isolate coordinates startup, one owns an instantiated
process memory and grows it, and one receives that memory as a pthread
would. The receiver waits until the process grows, calls the production
synchronization helper, creates its instance, accesses the new page, and
then observes a later grow through the already-compiled instance.

Minimal Node.js 24.15.0 experiments did not reproduce the stale view
without Kandelo's full process and pthread lifecycle. Variants covered
growth before message receipt, after receipt but before instantiation,
and during structured clone. The small test is therefore a positive
subsystem contract; it is not a replacement for the exact SpiderMonkey
regression.

A standalone browser-engine check exercised the same synchronization
rule in the locally installed Playwright engines. The original growth
scenario used memory32:

| Engine   | Startup synchronization | Later growth |
| -------- | ----------------------: | -----------: |
| Chromium |                  passed |       passed |
| Firefox  |                  passed |       passed |
| WebKit   |                  passed |       passed |

For each engine, the main isolate grew the memory from 17 to 752 pages
before handoff. The receiving worker observed 752 pages,
`memory.grow(0)` returned 752, and the byte length stayed at 49,283,072
before and after that call. The main isolate then grew the memory to 816
pages, and the running worker read the new tail without another
synchronization call.

A separate address-width check on the same date covered both actual
memory32 and memory64 shared memories in Node.js, Chromium, Firefox, and
WebKit. Every engine accepted `0` and returned a number for memory32;
every engine accepted `0n` and returned a BigInt for memory64. The byte
length stayed unchanged in both cases. Passing `0` to memory64 instead
threw a type error in Node.js, matching the prepared merge failure.

## Validation boundary

The executable SpiderMonkey regression proves the original Node.js
product path. The deterministic isolate test protects the general
startup ordering without depending on timing. The engine checks prove
that zero-page startup synchronization and later growth work in
Chromium, Firefox, and WebKit.

The full browser product path was not reproduced in this isolated
worktree. It requires the prepared campaign's exact single-tier package
provenance, which was not present in the diagnostic checkout. The
product-path check must still run after the fix is integrated with the
prepared package-install branch.

This work did not measure a performance change. The new call runs once
per pthread startup and requests zero additional pages.

[backing-store]:
  https://github.com/nodejs/node/blob/v24.15.0/deps/v8/src/objects/backing-store.h
[shared-grow]:
  https://github.com/nodejs/node/blob/v24.15.0/deps/v8/src/wasm/wasm-objects.cc
