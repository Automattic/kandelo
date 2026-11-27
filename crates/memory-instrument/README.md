# wasm-memory-instrument

`wasm-memory-instrument` rewrites a wasm32 program so every linear-memory
access translates its address through a per-process software page table.
It is the rewrite behind copy-on-write `fork()`: the host option
`forkMemory: "share"` runs the processes of a fork group on one physical
`WebAssembly.Memory` and gives each process its own tables.

```text
wasm-memory-instrument <input.wasm> -o <output.wasm> [--crossing strict|aligned]
wasm-memory-instrument <input.wasm> -o <output.wasm> --at-exec
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

## Rewrite at exec

`--at-exec` does not rewrite the program. It checks that the rewrite
accepts the program, keeps its code, and adds the empty custom section
`kandelo.memory.rewrite_at_exec`. The output is the plain form of the
program with a mark. A marked input stays as it is. A package asks for the
mark with `memory_instrumentation = "auto"` on an output of its
`package.toml` (see `docs/package-management.md`).

In `"share"` mode the Kandelo host rewrites a marked program in `aligned`
mode when a process starts it: at a host spawn, at `exec` and at
`posix_spawn`. The process runs the rewritten form. The kernel keeps the
plain form as the executable of the process, because those are the bytes
that it admitted. In `"copy"` mode the host runs the plain form and the
mark has no effect.

The rewrite runs in a Worker of its own (`host/src/program-rewriter.ts`),
so the kernel worker keeps serving syscalls. The host keeps the rewritten
form of each program, by the SHA-256 of its plain form, until the kernel
stops. On Node 24 the first start of a 37 MB `php-fpm` waits about 1.3 s
for the rewrite and the tool uses 172 MiB for that time; a 2 MB `bash`
waits about 0.15 s. The time in a browser is not measured.

A process that runs both forms can choose at each fork. The option
`forkShareMinimumBytes` of `NodeKernelHost` and `BrowserKernel` (default
0) is the smallest guest address space
whose fork child shares the pages of its parent. A smaller parent gets a
child with a private Memory: the host copies each guest-virtual page of
the parent through its tables, and the child runs the plain form with no
tables. The forks of that child are plain copies.

A rewritten program holds the custom section `kandelo.memory.plain_form`:
the SHA-256 of the input of the rewrite. The host uses it as the fork
template id of the rewritten form, so both forms have the same id and a
fork child refuses a plain form that is not the input of its parent's
rewrite. A side module gets no such section.

## Group

Processes that share one memory form a group. The exported mutable global
`__memory_group_base` holds the physical address of the group header:

- Offset 0: the index of the next physical page that no process has used.
  The allocator only increments it.
- Offset 8: the 8-byte head of the free list. The low half holds the last
  freed page with bit 16 set, or zero for an empty list. The high half
  counts the changes of the head, so a compare-exchange fails when another
  thread took and returned the same page in between.
- Offset 64 KiB: one 4-byte count per physical page: the number of
  mappings of that page minus one. Zero means one owner. The count of a
  free page holds the next entry of the free list.

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
5. Otherwise, it takes a page from the free list, or a new page when the
   list is empty, and grows the memory when needed. It copies the page,
   stores the new delta in the read table and then in the write table, and
   decrements the count of the old page last.
6. If the count was already zero, the other owner left during the copy. No
   process maps the old page, so the helper puts it on the free list.

The count stays above zero while a copy reads the old page, so no other
process writes that page in place during the copy.

A vfork child borrows the memory of its parent and gets no tables of its
own: the host gives it the table base of the parent.

When a fork child exits and its Workers have stopped, the host removes its
mappings. A page that no process maps goes to the free list. The run that
holds the tables and the control pages of the child stays whole, and a
later fork that needs a run of the same size takes it. The host keeps the
pages of a child whose Worker it terminated by force, because that Worker
can still write them.

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
- The fork child gets a copy of the control pages of its parent. The
  runtime stores zero to the stop words in the child's copy of the main
  channel, so the child does not start with a request of its parent.

A thread that makes no store and no syscall never echoes. The runtime must
then give up after a deadline, clear the bits it set, and copy the memory.
The stop helper adds no instruction to a load or to a store of an unshared
page.

## Rewrite

- Load and store: a call to a helper that holds the instruction. The
  helper adds the table entry of the page to the address: the read table
  for a load, the write table for a store. A set bit 0 in a write entry
  calls the copy-on-write helper first. The module gets one helper per
  instruction and alignment hint, so an access adds only a few bytes to its
  function. The caller adds the `offset` of a load to the address. A store
  with an `offset` passes it as the last operand.
- Load and store in a loop: the same translation, inline, when the
  innermost loop of the access holds at most 16 loads and stores. An engine
  runs a loop of a long activation in the code of its baseline compiler,
  where a call per access is slow. A function with an inline translation
  reads `__memory_table_base` once, at its entry, into a local.
- Rare branches: the custom section `metadata.code.branch_hint` marks the
  copy-on-write test and the page-crossing test as unlikely, so an engine
  that reads the section keeps the slow path out of the hot code. The
  rewrite drops a branch hint section of the input, because its offsets
  no longer match.
- Atomic access: the same translation, inline. An atomic load uses the read
  table. An atomic store, read-modify-write and compare-exchange use the
  write table.
- `memory.atomic.wait*` and `memory.atomic.notify`: translated as reads.
- `memory.copy`, `memory.fill` and `memory.init`: replaced by helpers that
  split the operation at page boundaries. `memory.copy` keeps memmove order.
- A multi-byte access that can cross a page boundary goes to a byte-wise
  helper. `strict` checks every non-atomic multi-byte access. `aligned`
  checks only accesses whose alignment hint is below natural alignment.
  Atomic accesses must be aligned, so they never cross.

## Cost

The helpers keep the binary small: the rewrite adds 6% to 31% to the six
package binaries of the trial (`bash`, `nginx`, `php`, `php-fpm`,
`redis-server`, `redis-cli`). An engine that inlines small functions in its
optimizing compiler removes the calls from hot code. V8 does: on Node 24, a
loop in a function that V8 has optimized runs 2.1 times slower than the
plain loop. It runs 1.6 times slower on Node 26, and on Node 24 with
`--experimental-wasm-branch-hinting`. A small loop that V8 has not
optimized runs 2.9 times slower. A loop with more than 16 loads and stores
keeps the calls and runs about 9 times slower until V8 optimizes its
function.

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
- The host frees the pages of a fork child only. The pages of the first
  process of a group, and of a child that the host terminated by force,
  stay in use until the last process of the group exits. The memory of a
  group never shrinks.
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
  with one exception. `host/src/wasi-shim.ts` uses physical addresses; a
  WASI program cannot fork, so its entries are all identity.
- The parent of a marked program runs the rewritten form from its start,
  at the cost in "Cost", also when all its fork children are plain.
- The host never drops a rewritten form that it made at `exec`, so a
  kernel that starts many large marked programs keeps all their rewritten
  bytes and modules.
- The host rewrites a side module on every `dlopen` and keeps no cache. On
  Node the rewrite of a 650 KiB module takes about 60 ms, and the output is
  about four times the size of the input.
