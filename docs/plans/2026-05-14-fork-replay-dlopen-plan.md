# fork-replay-dlopen Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a process forks after dlopen'ing one or more side modules, the fork child must replay those dlopens before resuming so its `__indirect_function_table` layout matches the parent's. This unblocks opcache.so in the WordPress / LAMP browser demos.

**Architecture:** The replay state is kept entirely in the process's shared linear memory. Each successful `__wasm_dlopen` mmap's a "dlopen archive entry" holding `{next, name, bytes, memory_base}` and chains it onto a linked list whose head pointer lives at a fixed slot below `asyncifyBufAddr`. Fork's existing parent→child memcpy carries the entire archive for free. The child's `worker-main.ts`, in the fork-child branch (between `WebAssembly.instantiate` and the asyncify rewind), reads its own head pointer and replays each entry via `linker.dlopenSync(name, bytes, { memoryBase, skipCtors: true })`. Replay grows the child's table identically to the parent's and re-runs `__wasm_apply_data_relocs` (idempotent over the memcpy'd data); it skips `__wasm_call_ctors` so already-initialized state in the data section isn't clobbered. No new syscall, no new message type, no changes to `handleFork` in either kernel-worker-entry tree — dual-host parity is automatic.

**Tech Stack:** TypeScript (host runtime), C (test fixture + glue), wasm32-unknown-unknown, Vitest, wasm-ld with `--experimental-pic --shared`.

---

## Memory layout reference

For both wasm32 and wasm64 each process has these reserved offsets near `channelOffset`:

```
channelOffset                  → channel header (status, syscall, args, return, errno)
channelOffset + CH_HEADER_SIZE → channel data buffer (64KB)

asyncifyBufAddr = channelOffset - ASYNCIFY_BUF_SIZE  // 16384 bytes for unwind/rewind

Below asyncifyBufAddr:
  asyncifyBufAddr - 4   (wasm32) / -8   (wasm64) : saved __tls_base
  asyncifyBufAddr - 8   (wasm32) / -16  (wasm64) : saved __stack_pointer
  asyncifyBufAddr - 12  (wasm32) / -24  (wasm64) : ★ dlopen archive head pointer ★
```

The 4-byte (wasm32) / 8-byte (wasm64) slot at `asyncifyBufAddr - 12 / -24` holds a process-wide pointer to a singly-linked list of dlopen entries. Zero (the default for fresh memory) means "no dlopens yet."

Each archive entry is a contiguous block allocated by a single `sys_mmap` call from inside `__wasm_dlopen`. Layout (wasm32, all u32):

```
offset  0:  next         (pointer to next entry, 0 = end of list)
offset  4:  name_ptr     (absolute address of name UTF-8 bytes)
offset  8:  name_len     (length of name in bytes)
offset 12:  bytes_ptr    (absolute address of side-module wasm bytes)
offset 16:  bytes_len    (length of bytes)
offset 20:  memory_base  (memory base the parent's allocator returned)
                         // size of struct = 24
[name UTF-8 bytes immediately follow]
[side-module wasm bytes follow, aligned to 8]
```

For wasm64 every pointer/length is u64 (struct size = 48 bytes; bytes alignment 16).

The entry block is allocated by a single mmap so on fork the linked-list pointers (which are absolute addresses) remain valid in the child's identical memory image.

---

### Task 1: Capture a failing E2E vitest fixture

**Files:**
- Create: `host/test/fork-dlopen-replay-e2e.test.ts`

**Step 1: Write the failing test**

Model on `host/test/dlopen-e2e.test.ts`. Use `runOnMainThread` mode (pass `io: new NodePlatformIO()`) — that path goes through the same `worker-main.ts` fork-child branch as production, so it exercises the bug.

The main program does:
1. `dlopen` a side module whose `init` function pointer is captured in a static struct (forces `__wasm_apply_data_relocs` to bake a table index into the data section).
2. `dlsym` and call `trigger()` once in the parent to confirm the parent works.
3. `fork()`. In the child, call `trigger()` again — without the fix this traps with "table index is out of bounds"; with the fix it returns 42.
4. Parent `waitpid`s the child, prints `ok\n` if the child exited 0.

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const SYSROOT = join(REPO_ROOT, "sysroot");
const GLUE_DIR = join(REPO_ROOT, "glue");
const LLVM_BIN = process.env.LLVM_BIN || "/opt/homebrew/opt/llvm@21/bin";
const CLANG = `${LLVM_BIN}/clang`;
const WASM_LD = process.env.LLVM_BIN ? `${LLVM_BIN}/wasm-ld` : "/opt/homebrew/bin/wasm-ld";

const hasSysroot = existsSync(join(SYSROOT, "lib", "libc.a"));
const hasKernel = existsSync(join(REPO_ROOT, "binaries", "kernel.wasm")) ||
  existsSync(join(REPO_ROOT, "local-binaries", "kernel.wasm"));

const BUILD_DIR = join(tmpdir(), "wasm-fork-dlopen-replay");

function buildSharedLib(source: string, name: string): string {
  const srcPath = join(BUILD_DIR, `${name}.c`);
  const objPath = join(BUILD_DIR, `${name}.o`);
  const soPath = join(BUILD_DIR, `${name}.so`);
  writeFileSync(srcPath, source);
  execSync(
    `${CLANG} --target=wasm32-unknown-unknown -fPIC -O2 -matomics -mbulk-memory -c ${srcPath} -o ${objPath}`,
    { stdio: "pipe" },
  );
  execSync(
    `${WASM_LD} --experimental-pic --shared --shared-memory --export-all --allow-undefined -o ${soPath} ${objPath}`,
    { stdio: "pipe" },
  );
  return soPath;
}

function buildMainProgram(source: string, name: string): string {
  const srcPath = join(BUILD_DIR, `${name}.c`);
  const wasmPath = join(BUILD_DIR, `${name}.wasm`);
  writeFileSync(srcPath, source);
  const cflags = [
    "--target=wasm32-unknown-unknown",
    `--sysroot=${SYSROOT}`,
    "-nostdlib", "-O2", "-matomics", "-mbulk-memory", "-fno-trapping-math",
  ];
  // Fork support requires asyncify instrumentation. Easiest in a vitest
  // fixture: link in channel_syscall.c (which provides the asyncify
  // onlylist exports the kernel needs) and run wasm-opt --asyncify
  // against the linked output.
  const linkFlags = [
    join(GLUE_DIR, "channel_syscall.c"),
    join(GLUE_DIR, "compiler_rt.c"),
    join(GLUE_DIR, "dlopen.c"),
    join(SYSROOT, "lib", "crt1.o"),
    join(SYSROOT, "lib", "libc.a"),
    "-Wl,--entry=_start",
    "-Wl,--export=_start",
    "-Wl,--export=__heap_base",
    "-Wl,--import-memory",
    "-Wl,--shared-memory",
    "-Wl,--max-memory=1073741824",
    "-Wl,--allow-undefined",
    "-Wl,--global-base=1114112",
    "-Wl,--table-base=3",
    "-Wl,--export-table",
    "-Wl,--growable-table",
    "-Wl,--export=__wasm_init_tls",
    "-Wl,--export=__tls_base",
    "-Wl,--export=__tls_size",
    "-Wl,--export=__tls_align",
    "-Wl,--export=__stack_pointer",
    "-Wl,--export=__wasm_thread_init",
  ];
  execSync(`${CLANG} ${[...cflags, srcPath, ...linkFlags, "-o", wasmPath].join(" ")}`, { stdio: "pipe" });

  // Asyncify the binary so kernel_fork can save/restore the call
  // stack at runtime. Matches scripts/build-programs.sh — main branch
  // uses wasm-opt --asyncify (the wasm-fork-instrument replacement
  // lives on phase-7-pthread-fixes, not main).
  const WASM_OPT = process.env.WASM_OPT || "wasm-opt";
  try {
    execSync(
      `${WASM_OPT} --asyncify --pass-arg=asyncify-imports@kernel.kernel_fork ${wasmPath} -o ${wasmPath}`,
      { stdio: "pipe" },
    );
  } catch (e) {
    // wasm-opt missing in $PATH — skip asyncify and let the test surface
    // the issue (fork() will return ENOSYS via the non-asyncify branch
    // of worker-main.ts; the bug under test won't reproduce, but the
    // test will explicitly fail with a clear diagnostic).
    console.warn("wasm-opt unavailable; fork() will be ENOSYS:", e);
  }
  return wasmPath;
}

describe.skipIf(!hasSysroot || !hasKernel)("fork replays parent dlopens into child", () => {
  beforeAll(() => mkdirSync(BUILD_DIR, { recursive: true }));

  it("child calls a function pointer captured in side-module data after fork", { timeout: 60_000 }, async () => {
    const soPath = buildSharedLib(
      `
      // side.c
      int side_init(void) { return 42; }

      // Capture function pointer in a static struct.
      // Forces __wasm_apply_data_relocs to bake a table index into the
      // data section — exactly like opcache.so's accel_module_entry.
      typedef int (*init_fn)(void);
      static struct { init_fn entry; } module_entry = { .entry = side_init };

      int trigger(void) { return module_entry.entry(); }
      `,
      "fork-dlopen-side",
    );

    const wasmPath = buildMainProgram(
      `
      #include <dlfcn.h>
      #include <stdio.h>
      #include <stdlib.h>
      #include <unistd.h>
      #include <sys/wait.h>

      typedef int (*trigger_fn)(void);

      int main(int argc, char *argv[]) {
        const char *lib_path = argv[1];
        void *lib = dlopen(lib_path, RTLD_NOW);
        if (!lib) { fprintf(stderr, "dlopen: %s\\n", dlerror()); return 1; }

        trigger_fn trigger = (trigger_fn)dlsym(lib, "trigger");
        if (!trigger) { fprintf(stderr, "dlsym: %s\\n", dlerror()); return 1; }

        // Sanity check in the parent.
        if (trigger() != 42) { fprintf(stderr, "parent trigger != 42\\n"); return 1; }

        pid_t pid = fork();
        if (pid == 0) {
          // Child: this call_indirect traps without the fix.
          int v = trigger();
          _exit(v == 42 ? 0 : 1);
        } else if (pid > 0) {
          int status;
          waitpid(pid, &status, 0);
          if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
            printf("ok\\n");
            return 0;
          }
          fprintf(stderr, "child exited badly: status=%d\\n", status);
          return 1;
        }
        fprintf(stderr, "fork failed\\n");
        return 1;
      }
      `,
      "fork-dlopen-main",
    );

    const result = await runCentralizedProgram({
      programPath: wasmPath,
      argv: ["fork-dlopen-main", soPath],
      timeout: 30_000,
      io: new NodePlatformIO(),
    });

    expect(result.stderr).not.toContain("table index is out of bounds");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run fork-dlopen-replay-e2e --no-coverage`

Expected: FAIL. Either:
- `Centralized worker failed: table index is out of bounds` in stderr (the production bug), OR
- `child exited badly` in stderr.

If it passes already, the bug is masked. Most likely cause: `wasm-opt` is not on `$PATH`, so the binary lacks asyncify and `fork()` returns ENOSYS instead of taking the asyncify-fork path that exhibits the bug. Confirm with `which wasm-opt` and, if missing, install via the nix dev-shell (`scripts/dev-shell.sh bash`) or `brew install binaryen`. If `wasm-opt` IS present and the test still passes, the bug genuinely doesn't reproduce — investigate which fork branch is being taken before proceeding.

**Step 3: Commit the failing test**

```bash
git add host/test/fork-dlopen-replay-e2e.test.ts
git commit -m "test(fork+dlopen): failing fixture for parent-dlopen-then-fork

Captures the production trap in WordPress browser demo:
child's freshly-instantiated table has module-initial length,
but data-section function pointer references a table slot only
the parent's table had grown to cover.

Currently fails with 'table index is out of bounds'. Fixed in
the next commits by replaying parent dlopens in the fork child."
```

---

### Task 2: Add replay options to dylink.ts

**Files:**
- Modify: `host/src/dylink.ts`

The replay mode skips the allocator (uses the parent's resolved `memoryBase`) and skips `__wasm_call_ctors` (the data section already holds post-startup state).

**Step 1: Add `ReplayOptions` interface and parameter**

Edit `instantiateSharedLibrary` in `host/src/dylink.ts`:

```typescript
/** Options used when re-instantiating a side module in a fork child. */
export interface DylinkReplayOptions {
  /** Use this memory base instead of calling allocateMemory. Must match the
   *  base the parent's allocator returned, so data-reloc'd pointers in
   *  the memcpy'd data section remain valid. */
  memoryBase: number;
}

function instantiateSharedLibrary(
  name: string,
  wasmBytes: Uint8Array,
  metadata: DylinkMetadata,
  options: LoadSharedLibraryOptions,
  replay?: DylinkReplayOptions,
): LoadedSharedLibrary {
  // Allocate memory region (or use the replay-preset base)
  const memAlign = 1 << metadata.memoryAlign;
  let memoryBase = 0;
  if (metadata.memorySize > 0) {
    if (replay) {
      memoryBase = replay.memoryBase;
      // Do NOT zero-init: child's memory already holds the parent's
      // data (memcpy'd at fork) — zeroing would wipe post-startup state.
    } else if (options.allocateMemory) {
      memoryBase = options.allocateMemory(metadata.memorySize, memAlign);
      // ... existing code unchanged ...
    } else {
      // ... existing heapPointer path unchanged ...
    }

    if (!replay) {
      // Zero-initialize the allocated region (only for fresh loads)
      new Uint8Array(options.memory.buffer, memoryBase, metadata.memorySize).fill(0);
    }
  }

  // ... existing table-allocation, GOT, instantiate, exports, GOT-update code unchanged ...

  // Run data relocations — idempotent: writes (memoryBase + offset),
  // (tableBase + offset) which is the same as parent in replay.
  const applyRelocs = instance.exports.__wasm_apply_data_relocs as Function | undefined;
  if (applyRelocs) applyRelocs();

  // Run constructors — skip in replay mode: parent's ctors already
  // initialized the data section, and the child memcpy inherited it.
  // Re-running would clobber post-startup state (e.g. opcache's
  // accel_globals, registered ini entries).
  if (!replay) {
    const ctors = instance.exports.__wasm_call_ctors as Function | undefined;
    if (ctors) ctors();
  }

  // ... rest unchanged ...
}
```

And propagate the new parameter through `loadSharedLibrarySync`:

```typescript
export function loadSharedLibrarySync(
  name: string,
  wasmBytes: Uint8Array,
  options: LoadSharedLibraryOptions,
  replay?: DylinkReplayOptions,
): LoadedSharedLibrary {
  const existing = options.loadedLibraries.get(name);
  if (existing) return existing;

  const metadata = parseDylinkSection(wasmBytes);
  if (!metadata) throw new Error(`${name}: not a shared library (no dylink.0 section)`);

  // Load dependencies first (sync)
  for (const dep of metadata.neededDynlibs) {
    if (options.loadedLibraries.has(dep)) continue;
    if (!options.resolveLibrarySync) {
      throw new Error(`${name}: depends on ${dep} but no resolveLibrarySync callback provided`);
    }
    const depBytes = options.resolveLibrarySync(dep);
    if (!depBytes) throw new Error(`${name}: dependency ${dep} not found`);
    // Note: dependency replay is out-of-scope; fork-replay only handles
    // top-level user-driven dlopens for now.
    loadSharedLibrarySync(dep, depBytes, options);
  }

  return instantiateSharedLibrary(name, wasmBytes, metadata, options, replay);
}
```

Also extend `DynamicLinker.dlopenSync` to forward an optional replay argument:

```typescript
/** Open a shared library. Returns a handle (>0) or 0 on error.
 *  When `replay` is provided, behaves as fork-replay: uses the parent's
 *  saved memoryBase and skips __wasm_call_ctors. */
dlopenSync(name: string, wasmBytes: Uint8Array, replay?: DylinkReplayOptions): number {
  try {
    const lib = loadSharedLibrarySync(name, wasmBytes, this.options, replay);
    // ... rest unchanged ...
  } // ...
}
```

**Step 2: Add a unit test for replay options**

Add to `host/test/dylink.test.ts` (or create one if missing). Keep it small — focus on the memoryBase-preset and ctor-skip behavior:

```typescript
import { describe, it, expect } from "vitest";
import { DynamicLinker } from "../src/dylink";

// Use a tiny hand-crafted side module that has __wasm_call_ctors and
// __wasm_apply_data_relocs as exports — or reuse the buildSharedLib helper.
// (Defer the full implementation to TDD-time; the assertion shape is:)
//
//   1. First load: ctors run, allocator called, returns base X.
//   2. Reset table+memory simulation.
//   3. Second load via dlopenSync(name, bytes, { memoryBase: X }):
//        - allocator NOT called,
//        - ctors NOT called,
//        - relocs ARE called.
```

Note: if writing a clean unit test for dylink requires too much scaffolding, prove the replay logic via the e2e test from Task 1 instead — the e2e covers it end-to-end through `worker-main.ts`. The unit test is "nice to have" but not strictly required.

**Step 3: Run dylink tests**

Run: `cd host && npx vitest run dylink --no-coverage`

Expected: pre-existing tests still PASS. The new replay-options API isn't exercised end-to-end until Task 3 wires it up.

**Step 4: Commit**

```bash
git add host/src/dylink.ts host/test/dylink.test.ts  # if test added
git commit -m "feat(dylink): replay options for fork-child re-instantiation

DynamicLinker.dlopenSync(name, bytes, { memoryBase }) re-runs
the side-module instantiation without calling allocateMemory
(uses the preset memoryBase) and skips __wasm_call_ctors. Data
relocations still run — idempotent over the memcpy'd data.

No production caller wires this up yet; that lands next."
```

---

### Task 3: Wire archive persistence + child-side replay in worker-main.ts

**Files:**
- Modify: `host/src/worker-main.ts`

**Step 1: Define archive constants and write helpers**

Near the existing `ASYNCIFY_BUF_SIZE` constant (around line 524), add:

```typescript
const ASYNCIFY_BUF_SIZE = 16384;

// Offset (below asyncifyBufAddr) of the dlopen-archive head pointer.
// asyncifyBufAddr - 4/-8   : saved __tls_base
// asyncifyBufAddr - 8/-16  : saved __stack_pointer
// asyncifyBufAddr - 12/-24 : dlopen archive head pointer
const DLOPEN_HEAD_OFFSET_WASM32 = 12;
const DLOPEN_HEAD_OFFSET_WASM64 = 24;

// Archive entry struct sizes (in linear memory):
const DLOPEN_ENTRY_SIZE_WASM32 = 24;
const DLOPEN_ENTRY_SIZE_WASM64 = 48;
```

**Step 2: In `buildDlopenImports`, persist each successful dlopen and return a `replayDlopens` callback**

Refactor the return type of `buildDlopenImports` to expose a replay entry point. Currently it returns `Record<string, WebAssembly.ExportValue>`. Change to:

```typescript
interface DlopenSupport {
  imports: Record<string, WebAssembly.ExportValue>;
  /** Replay the parent's dlopen list (from the archive in linear memory)
   *  in the child. No-op if the head pointer is zero. */
  replayDlopens: () => void;
}

function buildDlopenImports(
  memory: WebAssembly.Memory,
  channelOffset: number,
  getTable: () => WebAssembly.Table | undefined,
  getStackPointer: () => WebAssembly.Global | undefined,
  getInstance: () => WebAssembly.Instance | undefined,
  ptrWidth: 4 | 8,
): DlopenSupport {
  // ... existing linker / allocateMemory / getLinker setup unchanged ...

  const headOffset = ptrWidth === 8 ? DLOPEN_HEAD_OFFSET_WASM64 : DLOPEN_HEAD_OFFSET_WASM32;
  const entrySize = ptrWidth === 8 ? DLOPEN_ENTRY_SIZE_WASM64 : DLOPEN_ENTRY_SIZE_WASM32;
  const asyncifyBufAddr = channelOffset - ASYNCIFY_BUF_SIZE;
  const headSlot = asyncifyBufAddr - headOffset;

  const readPtr = (view: DataView, addr: number): number =>
    ptrWidth === 8 ? Number(view.getBigUint64(addr, true)) : view.getUint32(addr, true);
  const writePtr = (view: DataView, addr: number, val: number): void => {
    if (ptrWidth === 8) view.setBigUint64(addr, BigInt(val), true);
    else view.setUint32(addr, val, true);
  };

  // Persist a successful dlopen into the linear-memory archive.
  // Allocates one mmap block holding [entry struct][name][bytes],
  // appends it to the linked list whose head lives at `headSlot`.
  const persistArchiveEntry = (name: string, bytes: Uint8Array, memoryBase: number): void => {
    const nameBytes = new TextEncoder().encode(name);
    // Align bytes section to 8 (most archs require it for fast memcpy).
    const nameAligned = (nameBytes.length + 7) & ~7;
    const totalSize = entrySize + nameAligned + bytes.length;
    const blockAddr = allocateMemory(totalSize, 8);

    const view = new DataView(memory.buffer);
    const namePtr = blockAddr + entrySize;
    const bytesPtr = blockAddr + entrySize + nameAligned;

    // Write entry fields.
    writePtr(view, blockAddr + 0 * (ptrWidth === 8 ? 8 : 4), 0);             // next = 0
    writePtr(view, blockAddr + 1 * (ptrWidth === 8 ? 8 : 4), namePtr);       // name_ptr
    writePtr(view, blockAddr + 2 * (ptrWidth === 8 ? 8 : 4), nameBytes.length); // name_len
    writePtr(view, blockAddr + 3 * (ptrWidth === 8 ? 8 : 4), bytesPtr);      // bytes_ptr
    writePtr(view, blockAddr + 4 * (ptrWidth === 8 ? 8 : 4), bytes.length);  // bytes_len
    writePtr(view, blockAddr + 5 * (ptrWidth === 8 ? 8 : 4), memoryBase);    // memory_base

    // Copy blobs.
    new Uint8Array(memory.buffer, namePtr, nameBytes.length).set(nameBytes);
    new Uint8Array(memory.buffer, bytesPtr, bytes.length).set(bytes);

    // Append to linked list.
    const v2 = new DataView(memory.buffer);
    let curHead = readPtr(v2, headSlot);
    if (curHead === 0) {
      writePtr(v2, headSlot, blockAddr);
    } else {
      // Walk to tail.
      while (true) {
        const nextAddr = readPtr(v2, curHead + 0);
        if (nextAddr === 0) break;
        curHead = nextAddr;
      }
      writePtr(v2, curHead + 0, blockAddr);
    }
  };

  const replayDlopens = (): void => {
    const view = new DataView(memory.buffer);
    let entryAddr = readPtr(view, headSlot);
    if (entryAddr === 0) return;
    // Force linker creation so we can call dlopenSync directly.
    const linker = getLinker();
    while (entryAddr !== 0) {
      const v = new DataView(memory.buffer);
      const next = readPtr(v, entryAddr + 0);
      const namePtr = readPtr(v, entryAddr + (ptrWidth === 8 ? 8 : 4));
      const nameLen = readPtr(v, entryAddr + (ptrWidth === 8 ? 16 : 8));
      const bytesPtr = readPtr(v, entryAddr + (ptrWidth === 8 ? 24 : 12));
      const bytesLen = readPtr(v, entryAddr + (ptrWidth === 8 ? 32 : 16));
      const memoryBase = readPtr(v, entryAddr + (ptrWidth === 8 ? 40 : 20));

      const name = decoder.decode(new Uint8Array(memory.buffer, namePtr, nameLen));
      // Copy bytes out of shared memory into a non-shared buffer:
      // WebAssembly.Module rejects SharedArrayBuffer-backed buffers in
      // some engines, and we already pay this cost on the parent's
      // initial dlopen path.
      const bytes = new Uint8Array(new Uint8Array(memory.buffer, bytesPtr, bytesLen));

      const handle = linker.dlopenSync(name, bytes, { memoryBase });
      if (handle === 0) {
        throw new Error(`fork-replay dlopen(${name}) failed: ${linker.dlerror() ?? "unknown"}`);
      }
      entryAddr = next;
    }
  };

  const imports: Record<string, WebAssembly.ExportValue> = {
    __wasm_dlopen: (bytesPtr: number, bytesLen: number,
                    namePtr: number, nameLen: number): number => {
      const bytes = new Uint8Array(memory.buffer, bytesPtr, bytesLen);
      const bytesCopy = new Uint8Array(bytes);
      const nameBytes = new Uint8Array(memory.buffer, namePtr, nameLen);
      const name = decoder.decode(nameBytes);
      const handle = getLinker().dlopenSync(name, bytesCopy);
      if (handle > 0) {
        // Look up the resolved memoryBase. The linker only exposes
        // loadedLibraries via the constructor's `options.loadedLibraries`
        // map. We pass that map in directly (it's owned by the linker
        // closure), so re-read it here from the same map ref.
        const loaded = (linker as any /* DynamicLinker */)?.options?.loadedLibraries?.get(name);
        // The above expects a small DynamicLinker refactor — see Note below.
        if (loaded) {
          persistArchiveEntry(name, bytesCopy, loaded.memoryBase);
        }
      }
      return handle;
    },

    // ... __wasm_dlsym, __wasm_dlclose, __wasm_dlerror unchanged ...
  };

  return { imports, replayDlopens };
}
```

**Note:** `DynamicLinker` doesn't currently expose `loadedLibraries` after construction. Cleaner: pass the map as a `const loadedLibraries = new Map<...>()` in `worker-main.ts` (above the `new DynamicLinker(...)` call), keep a reference in the closure, and read `loadedLibraries.get(name).memoryBase` after a successful `dlopenSync`. Update the linker options to use this shared reference.

**Step 3: Update both `buildDlopenImports` call sites and use `replayDlopens` in fork-child path**

Both branches (asyncify path and non-asyncify path) call `buildDlopenImports`. Change them to use the new return shape:

```typescript
// Replace:
//   const dlopenImports = buildDlopenImports(...);
//   const importObject = buildImportObject(module, memory, kernelImports, channelOffset, dlopenImports, ...);
// With:
const dlopenSupport = buildDlopenImports(memory, channelOffset, ...);
const importObject = buildImportObject(module, memory, kernelImports, channelOffset, dlopenSupport.imports, ...);
```

In the **asyncify fork-child path** (lines 715–748 area), after the TLS / __stack_pointer restoration and after `setupChannelBase`, before `port.postMessage({type:"ready"})`, add:

```typescript
// Replay parent dlopens before resuming user code. The fork-child
// inherits the parent's data section (with table-index baked function
// pointers) via memcpy; without replay, those indices reference table
// slots only the parent's table had grown to cover.
if (initData.isForkChild) {
  try {
    dlopenSupport.replayDlopens();
  } catch (e) {
    throw new Error(`fork-replay-dlopen failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

The non-asyncify fork path (line 821+) re-executes `_start`, which re-invokes any C-side dlopen calls naturally — no replay needed there.

**Step 4: Run the fork+dlopen vitest test from Task 1**

Run: `cd host && npx vitest run fork-dlopen-replay-e2e --no-coverage`

Expected: PASS. Child returns 42 from the captured function pointer; parent prints "ok".

If failure: inspect stderr. Common gotchas:
- `replayDlopens` called before `setupChannelBase`: linker's `allocateMemory` makes a sys_mmap syscall (only triggered for archive-entry allocations on *new* dlopens, not on replay; but still — make sure replay runs after `setupChannelBase`).
- `loadedLibraries.get(name)` returns undefined: the map mutation isn't propagating. Confirm the same map ref is shared between worker-main and DynamicLinker.
- Memory base mismatch: log `loaded.memoryBase` at persist time and at replay time; they must match exactly.

**Step 5: Commit**

```bash
git add host/src/worker-main.ts
git commit -m "feat(fork+dlopen): replay parent dlopens in fork child

__wasm_dlopen persists each successful load into a per-process
archive in linear memory; the head pointer lives at a fixed slot
below asyncifyBufAddr. Fork's memcpy carries the archive into
the child automatically.

In the asyncify fork-child path, between WebAssembly.instantiate
and the asyncify rewind, replay each archive entry via
linker.dlopenSync(name, bytes, { memoryBase }). Replay grows the
child's __indirect_function_table identically to the parent's and
re-applies data relocations (idempotent). Constructors are skipped
so the parent's post-startup data state remains intact.

Closes the trap docs/plans/2026-05-14-binary-resolution-followups.md
item #1: WordPress browser demo with opcache enabled."
```

---

### Task 4: Re-enable opcache in browser demos

**Files:**
- Modify: `examples/browser/scripts/build-wp-vfs-image.ts`
- Modify: `examples/browser/scripts/build-lamp-vfs-image.ts`

**Step 1: Revert the opcache-disabled hunks**

Use `git show e1a00a9e8 -- examples/browser/scripts/build-wp-vfs-image.ts examples/browser/scripts/build-lamp-vfs-image.ts` to see what was disabled. Restore the active `zend_extension=` line and `opcache.enable=1` setting in both files.

Inspect each file's "[opcache]" section and remove any temporary `# disabled pending fork-replay-dlopen fix` comments.

**Step 2: Manual browser demo verification**

Build and run the WP demo:

```bash
bash build.sh
./run.sh browser
# Open the URL in a real browser; load the WordPress demo. Verify:
#   - Demo loads (no 502 Bad Gateway).
#   - WP admin login works.
#   - No "table index is out of bounds" in DevTools console.
```

If anything breaks, debug; do NOT proceed.

**Step 3: Commit**

```bash
git add examples/browser/scripts/build-wp-vfs-image.ts examples/browser/scripts/build-lamp-vfs-image.ts
git commit -m "demo(wp+lamp): re-enable opcache after fork-replay-dlopen ships

Reverts e1a00a9e8. The fork-child now replays parent dlopens
before resuming, so opcache.so loaded in the FPM master is
correctly available in each forked worker."
```

---

### Task 5: Mark the followup as resolved

**Files:**
- Modify: `docs/plans/2026-05-14-binary-resolution-followups.md`

**Step 1: Edit item #1 to mark resolved**

Change the section header from `## 1. opcache.so traps in forked FPM workers …` to `## 1. ✅ opcache.so traps in forked FPM workers — RESOLVED`. Add a one-paragraph note linking the implementing PR.

**Step 2: Commit**

```bash
git add docs/plans/2026-05-14-binary-resolution-followups.md
git commit -m "docs(followups): mark item #1 (fork-replay-dlopen) resolved"
```

---

### Task 6: Run the full verification suite

From CLAUDE.md "Test Verification" — ALL of these must pass before opening the PR:

```bash
# 1. Cargo tests
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
# Expected: 539+ pass, 0 fail.

# 2. Vitest
cd host && npx vitest run
cd ..
# Expected: all files pass (PHP tests may skip if binary not built).

# 3. musl libc-test
scripts/run-libc-tests.sh
# Expected: 0 unexpected failures. XFAIL/TIME are acceptable.

# 4. POSIX
scripts/run-posix-tests.sh
# Expected: 0 FAIL. UNRES/SKIP are acceptable.

# 5. ABI snapshot — this fix should NOT touch the ABI; expect a no-op.
bash scripts/check-abi-version.sh
# Expected: exit 0, no snapshot drift.
```

Per the user's saved preference (feedback_defer-to-pr-ci): once these pass locally, push and rely on PR CI for the long-running suites (sortix, fuzz, etc.). Don't re-run locally just to be sure.

If suite 5 fails — drift detected — review `git diff abi/snapshot.json` and decide whether to bump ABI_VERSION. Per the task brief, this fix is purely host-side and shouldn't drift; if it does, something is wrong (e.g. accidentally edited a kernel-wasm export).

---

### Task 7: Open the PR

**Step 1: Push the branch**

```bash
git push -u origin fork-replay-dlopen-for-webassembly-instance-table
```

**Step 2: Open the PR**

Title: `feat(fork+dlopen): replay parent dlopens in fork child`

Body (use `gh pr create --body` with a HEREDOC):

```markdown
## Summary
- Fork children now replay each parent `dlopen` before resuming user code, so the child's `__indirect_function_table` layout matches the parent's. Without this, function pointers captured in side-module data sections (e.g. `accel_module_entry.request_startup_func` in `opcache.so`) trap with "table index is out of bounds" in the child.
- The replay state is kept entirely in shared linear memory: a linked list of `{name, bytes, memory_base}` entries whose head lives at a fixed slot below `asyncifyBufAddr`. Fork's existing memcpy carries it into the child for free — no `handleFork` changes, no new message types, dual-host parity is automatic.
- Re-enables opcache in the WordPress and LAMP browser demos (reverts the workaround from e1a00a9e8).

## Root cause
WebAssembly tables are per-Instance objects. Fork instantiates a fresh program module for the child, so its table is back at module-initial length. Pointers baked into the parent's data section by `__wasm_apply_data_relocs` reference table slots only the parent's table had grown to cover. Documented in `docs/plans/2026-05-14-binary-resolution-followups.md` item #1.

## Dual-host parity
The replay logic lives in `host/src/worker-main.ts`, which is shared by both the Node host (`host/src/node-kernel-worker-entry.ts`) and the browser host (`examples/browser/lib/kernel-worker-entry.ts`). No changes to either kernel-worker-entry tree were needed.

## Test plan
- [x] New vitest fixture `host/test/fork-dlopen-replay-e2e.test.ts` — fails before, passes after.
- [x] Existing `dlopen-e2e.test.ts` still passes.
- [x] cargo / vitest / libc-test / posix all green.
- [x] Manual browser demo: `./run.sh browser` with opcache enabled — WordPress and LAMP demos load cleanly, no 502.

## Follow-ups (out of scope)
- Republish a fresh `php-revN` archive via `scripts/index-update.sh` so the indexed flow also exercises the fixed dlopen path. The published php-rev2 predates `opcache.so` shipping, so it never triggers this code path.
- Replay handling for `dlsym`-induced table growths and `NEEDED` dependency chains — not exercised by current use cases (opcache, ncurses).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Report the PR URL.

---

## Reviewer prompt (CLAUDE.md "Two hosts")

For anyone reviewing: the diff touches only `host/src/worker-main.ts` and `host/src/dylink.ts`, both of which are shared by Node and Browser hosts. There are NO changes to `host/src/node-kernel-worker-entry.ts` or `examples/browser/lib/kernel-worker-entry.ts`. This is by design: the replay state lives in shared linear memory which fork already memcpys for both hosts. Verify by grepping for `dlopen` / `replay` in both kernel-worker-entry trees — both should be empty.
