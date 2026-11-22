# wasm-memory-instrument

`wasm-memory-instrument` rewrites a wasm32 program so every linear-memory
access translates its address through a per-process software page table.
It is the rewrite behind copy-on-write `fork()`: the host option
`forkMemory: "share"` runs the processes of a fork group on one physical
`WebAssembly.Memory` and gives each process its own tables.

```text
wasm-memory-instrument <input.wasm> -o <output.wasm> [--crossing strict|aligned]
```

From the repo root, `scripts/run-wasm-memory-instrument.sh` runs
`tools/bin/wasm-memory-instrument`. It first runs
`scripts/build-memory-instrument-tool.sh` when the installed tool does not
match the current sources.

## Why

Wasm has no MMU, so `fork()` copies the whole parent memory into the child.
POSIX requires that the child gets its own copy of the parent's memory. It
does not require that the copy is made at fork time: a page that neither
process writes can stay shared.
With a software page table, a group of processes can share one physical
`WebAssembly.Memory`: fork copies the table instead of the bytes, and a store
to a shared page copies that page first.

## Tables

- Two tables, each with one 4-byte entry per 64 KiB wasm32 page: 65,536
  entries, 256 KiB per table.
- A read-table entry holds `physical - virtual`. Loads add it with no mask.
- A write-table entry holds the same delta. Bit 0 marks a shared page that
  must be copied before a write. Only writes test it. Bit 1 marks a page that
  a thread of the process is copying now.
- A zero entry is the identity mapping. Fresh memory is zero, so the tables
  need no initialization, and an unmodified runtime runs the program as
  before.
- The exported mutable global `__memory_table_base` holds the physical
  address of the read table. The write table follows it. Each instance has
  its own value, so instances that share one memory use different tables.
- The global starts at the linker's `__heap_base` rounded up to a page. The
  exported `__heap_base` moves to the end of the tables, 512 KiB after that
  page boundary, and the memory minimum grows when it does not reach the new
  `__heap_base`. So the host places its control pages and the heap after
  the tables.
- An imported memory gets the wasm32 maximum of 65,536 pages. An instance
  cannot import a memory with a larger maximum than it declares, and a group
  memory holds the pages of every process in the group. The host still
  chooses the real maximum. A memory the module defines keeps its maximum.

## Side modules

The side-module role of the library (`Role::SideModule`) rewrites a module
that `dlopen` loads. The module gets the same exported globals
(`__memory_table_base`, `__memory_group_base`, `__memory_stop_base`) and
the same helpers, but no tables of its own: `__heap_base` is not required,
the memory minimum does not change, and `__memory_table_base` starts at
zero. The loader must store the table base, the group base and the stop
base of the process in those globals before any code of the module runs,
which includes its start function.

The Kandelo host does this rewrite at load time. `build-wasm.sh` builds the
library as `local-binaries/kandelo_memory_instrument32.wasm`, a wasm32
module that imports nothing. An embedder passes its bytes in the
`memoryInstrumenter` host option. When a process with page tables calls
`dlopen`, the loader (`host/src/dylink.ts`) rewrites the module in `strict`
mode, removes its start section, stores the three globals, and then calls
`__wasm_init_memory`. The loader refuses a module with an active data
segment or with a start function other than `__wasm_init_memory`. Without
`memoryInstrumenter`, `dlopen` fails in such a process.

## Group

Processes that share one memory form a group. The exported mutable global
`__memory_group_base` holds the physical address of the group header:

- Offset 0: the index of the next free physical page. The allocator only
  increments it.
- Offset 64 KiB: one 4-byte count per physical page: the number of
  mappings of that page minus one. Zero means one owner.

Fork copies the parent's tables to the child's tables, sets bit 0 in both
write tables, and increments the count of every shared page. A store to a
page with bit 0 set calls the copy-on-write helper:

1. The helper loads the write entry atomically. If bit 0 is clear, another
   thread finished the copy: the helper returns the entry.
2. If bit 1 is set, the page is locked: another thread is copying it, or
   the runtime stops the stores of the process. The helper calls the stop
   helper (see "Stop words") and loads again.
3. The helper sets bit 1 with a compare-exchange. If the entry changed, it
   loads again.
4. If the count of the physical page is zero, the process is the only
   owner: the helper clears both bits and writes in place.
5. Otherwise, it allocates a physical page, grows the memory when needed,
   copies the page, stores the new delta in the read table and then in the
   write table, and decrements the count of the old page last.

The count stays above zero while a copy reads the old page, so no other
process writes that page in place during the copy.

## Stop words

A running Wasm thread cannot be stopped from outside. A thread that loaded
a write entry before fork set bit 0 would write a shared page in place. So
the runtime parks the threads of a process at their next store:

- The exported mutable global `__memory_stop_base` holds the physical
  address of two 4-byte words that belong to one thread. Each instance gets
  its own value. The first word is the request, the second is the echo.
  The global starts at the table base, a word that is zero while no runtime
  uses the tables.
- The runtime stores a non-zero request for each running thread, then sets
  bit 0 and bit 1 in every write entry of the process.
- The next store of a thread finds bit 0, enters the copy-on-write helper,
  finds bit 1 and calls the stop helper. The stop helper stores the request
  to the echo word, notifies it, and waits on the request word until the
  request changes. It returns when the request is zero.
- When every thread has echoed its request or waits in a syscall, the
  runtime shares the pages, clears bit 1, stores zero to each request word
  and notifies it.

A thread that makes no store and no syscall never echoes. The runtime must
then give up after a deadline, clear the bits it set, and copy the memory.
The stop helper adds no instruction to a load or to a store of an unshared
page.

## Rewrite

- Load: `addr + read[(addr + offset) >> 16]`, then the original instruction
  with its original `offset`.
- Store, atomic read-modify-write and compare-exchange: the same with the
  write table. A set bit 0 calls the copy-on-write helper first.
- `memory.atomic.wait*` and `memory.atomic.notify`: translated as reads.
- `memory.copy`, `memory.fill` and `memory.init`: replaced by helpers that
  split the operation at page boundaries. `memory.copy` keeps memmove order.
- A multi-byte access that can cross a page boundary goes to a byte-wise
  helper. `strict` checks every non-atomic multi-byte access. `aligned`
  checks only accesses whose alignment hint is below natural alignment.
  Atomic accesses must be aligned, so they never cross.

## Optimization

Run `wasm-opt -O2` on the output. It removes about half of the added cost.
`aligned` is the recommended mode: clang emits a natural alignment hint only
for typed accesses that C requires to be aligned, and emits a weaker hint for
packed and `memcpy`-style accesses, which `aligned` still checks.

## Known gaps

- In `"share"` mode the host maps the pages that `brk`, `mmap`, `mremap`
  and a pthread slot add to fresh physical pages from the group allocator.
  A pthread slot always sits on one physical run that no other process
  shares, because the host uses its channel at the physical offset.
- A moving `mremap` copies the bytes. The kernel maps in 4 KiB pages and a
  table entry covers 64 KiB, so the host cannot move the entries instead.
- The group allocator never frees a page. A later compaction pass is to
  move live pages into a smaller memory. Two processes that copy the same
  page at the same time both copy it, and the count of the old page goes
  below zero; no process maps that page after both copies.
- Fork parks the running threads of the process through their stop words
  and then shares the pages. It waits 10 ms. When a thread makes no store
  and no syscall in that time, or while a vfork child borrows the memory,
  fork sets no bit: the child gets a copy of every page at fork time,
  inside the same memory.
- The syscall wait loop of libc stores once to a static after its first
  100 ms timeout. Fork treats a thread in that loop as parked. A fork that
  sets bit 0 between the entry load and that store lets the store land on a
  page that the child shares.
- A zero entry maps a virtual page to the same physical page, so a process
  can reach the pages of other processes in its group through addresses
  outside its own mappings.
- `memory.size` and `memory.grow` are not rewritten. They see the physical
  memory of the group.
- SIMD, memory64 and multi-memory inputs are rejected.
- A zero-length bulk operation returns without the original bounds trap.
  A bulk operation that traps part-way may have written earlier chunks.
- `aligned` mode is incorrect for a misaligned access with a natural
  alignment hint that crosses into a page with a different mapping.
- The host translates its accesses to guest addresses through the table,
  with two exceptions. The `clone` handler checks its tid pointers
  against the physical size of the memory. `host/src/wasi-shim.ts` uses
  physical addresses; a WASI program cannot fork, so its entries are all
  identity.
- The host rewrites a side module on every `dlopen` and keeps no cache. On
  Node the rewrite of a 650 KiB module takes about 60 ms, and the output is
  about four times the size of the input.
