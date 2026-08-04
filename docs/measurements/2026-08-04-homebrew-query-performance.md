# In-guest Homebrew query performance — 2026-08-04

## Status and scope

This record contains the final three-round focused benchmark and the required
repository-wide before/after benchmark. The implementation commit is
`58e0c41e63d46f403d211c0aabfe7bb51baa9987`, based on protected `main`
commit `880e5be7d2dbd3772602ff7eaed952c0b8c6608f`. The focused fixture records
producer commit `5a025d98a5f6f1856618f0309c4ad7144dc78e52`. The deployed rev22
compatibility-shell baseline records commit
`00e30e1aeb9a1b691b2fd8ffcf0cf7ef561aab3c`.

The rev22 and candidate shell images necessarily contain different runtime
artifacts and tap-core revisions, so their focused numbers are a deployed
product comparison, not an exact-artifact A/B. Each individual Node/browser
pair used the same immutable image, kernel, taps, lazy bytes, command inputs,
and environment. The repository-wide comparison used freshly built hosts at
protected `main` and the candidate with identical benchmark workload
artifacts, whose digests are recorded by the benchmark runner.

The retained implementation does not reuse JavaScript Realms. A process may
consume a pristine prestarted Worker, but that Worker is one-shot and is
terminated after the process retires. Unused reserve Workers contain no guest
memory. This preserves process isolation and lets Kandelo release every
reference it owns to the process `SharedArrayBuffer` (SAB) and
`WebAssembly.Memory`.

## Exact diagnostic inputs

The final focused Node and Chromium results were recorded on 2026-08-04 at
`2026-08-04T20:37:42.645Z` and `2026-08-04T20:43:45.208Z` with:

- Apple M5 Max, arm64, Darwin 25.6.0;
- Node.js `v24.15.0`;
- Chrome for Testing `149.0.7827.55` for the matched browser attempt;
- kernel SHA-256
  `bf11b2a61959cacfb05fb3f21cdbba8b8109ea56231379c07adf1f4f4365ecfd`;
- lazy rootfs SHA-256
  `b270afb52a0c36e6c23c95290c1c24fed295d9998e2e70fa60921bf821f9f571`;
- eager rootfs SHA-256
  `b5c819b196a1d8953f059f4b95135116581cb6bb271f6baa56e81e4bd6e865dc`;
- `kandelo-dev/tap-core` commit
  `28ddbc5352749f217ad89bf010e0f16b7e4b3d81`; and
- `brandonpayton/kandelo-canary` commit
  `b86d1810c68e3ab17bdab218856da3a7516ec95c`.

The fixture used the deployed compatibility prefix
`/home/linuxbrew/.linuxbrew`. The implementation derives that prefix from
authenticated descriptors; the benchmark and runtime do not assume it.

Every command received:

```text
HOMEBREW_NO_AUTO_UPDATE=1
HOMEBREW_NO_INSTALL_FROM_API=1
HOMEBREW_NO_ANALYTICS=1
```

The workload covered `brew --version`, `brew config`, both text and JSON v2
`brew info` for `kandelo-dev/tap-core/dash`, `brew list --versions`, and
`brew info brandonpayton/kandelo-canary/m4-canary`.

Node ran with its TCP backend disabled. The first round also traced guest
socket syscalls. Every measured command reported an empty network-syscall
map. Chromium served only the closed local fixture and rejected other
requests. No measured query depended on the public network.

## Final focused result

These are host-side monotonic medians from three independent rounds. Each
Chromium round launched a fresh browser so a prior renderer, Worker, Realm,
memory, or shared buffer could not survive into the next sample:

| Phase | Node | Chromium |
| --- | ---: | ---: |
| Machine boot | 867 ms | 1,109 ms |
| Cold first invocation | 9,586 ms | 9,106 ms |
| Cold boot plus first invocation | 10,455 ms | 10,232 ms |
| Immediate repeat on that machine | 4,920 ms | 5,335 ms |
| First invocation after a shell was booted | 5,616 ms | 5,385 ms |
| Repeated warm invocation | 4,616 ms | 5,005 ms |
| Eager-image first invocation | 7,110 ms | 6,415 ms |
| Eager-image warm invocation | 4,594 ms | 5,059 ms |

The cold query fetched seven closed lazy assets totaling 28,040,511 bytes.
Those assets were the Homebrew source tree, portable Ruby, and the ordinary
tools actually executed by the runtime. The warm query fetched zero bytes.
Thus a second `brew info` is not waiting on the already materialized lazy
references; it repeats process startup, Ruby loading, discovery, and parsing.

Warm values for the complete command set were:

| Command | Node | Chromium |
| --- | ---: | ---: |
| `brew --version` | 484 ms | 914 ms |
| `brew config` | 5,570 ms | 15,532 ms |
| text `brew info` | 4,616 ms | 5,005 ms |
| JSON v2 `brew info` | 4,908 ms | 5,544 ms |
| `brew list --versions` | 3,729 ms | 3,789 ms |
| canary `brew info` | 5,399 ms | 6,181 ms |

Every command completed successfully with nonempty standard output and empty
standard error. Node and Chromium produced the same output digest for each
command. The Chromium `brew config` result remained unusually noisy and slow;
the table reports its median rather than treating the earlier low sample as
representative.

The deployed rev22 Node baseline and candidate compare as follows. This is a
product-level comparison with the exact revisions disclosed above, not an
exact-artifact micro A/B:

| Metric | Rev22 | Candidate | Reduction |
| --- | ---: | ---: | ---: |
| Cold boot plus first `brew info` | 27,052 ms | 10,455 ms | 61.4% (2.59x) |
| Immediate warm `brew info` | 26,081 ms | 4,920 ms | 81.1% (5.30x) |
| Booted warm `brew info` | 25,560 ms | 4,616 ms | 81.9% (5.54x) |
| Warm JSON v2 `brew info` | 28,633 ms | 4,908 ms | 82.9% (5.83x) |
| Warm `brew config` | 30,814 ms | 5,570 ms | 81.9% (5.53x) |
| Warm `brew list --versions` | 20,390 ms | 3,729 ms | 81.7% (5.47x) |
| Warm canary `brew info` | 31,745 ms | 5,399 ms | 83.0% (5.88x) |

Chrome 149 consistently lost the renderer on rev22 before the harness could
produce one valid complete round. Required-unused rootfs bytes and disabling
Wasm tier-up did not make rev22 complete, so there is no honest Chromium
"before" duration. The candidate completed all three isolated Chromium rounds;
its values are reported above without fabricating a speedup ratio.

## Attribution

### Warm Ruby and syscall timeline

A sampled 6,674.7 ms Ruby worker profile attributed self time as follows:

| Ruby worker frame | Sampled self time |
| --- | ---: |
| libc syscall path | 3,728.3 ms |
| Ruby parser | 591.6 ms |
| Ruby VM core | 179.3 ms |
| Ruby lexer | 92.7 ms |
| compiler helper | 63.5 ms |

The syscall figure includes time waiting for the kernel Worker. A separate
host-side timing of the synchronous kernel work for a 5,960.6 ms warm query
accounted for 1,367.3 ms:

| Operation | Calls | Kernel time |
| --- | ---: | ---: |
| `open` | 4,694 | 1,064.6 ms |
| `stat` | 2,068 | 169.7 ms |
| `realpath` | 1,236 | 71.8 ms |
| `read` | 4,055 | 8.9 ms |
| `readlink` | 170 | 6.6 ms |
| `close` | 3,120 | 5.8 ms |

The difference between Ruby's syscall-wait samples and synchronous kernel
work is channel transfer, scheduling, wakeup, and time spent behind other
processes. The file bytes are already memory-resident on a warm run, but each
POSIX call still crosses from Wasm libc through the shared channel to the
dedicated kernel Worker and back. Thousands of individually cheap lookups
therefore remain expensive.

### Why so many absent paths are opened

This is mostly normal CRuby and Homebrew behavior, amplified by Kandelo's
per-syscall cost:

- Homebrew's generated Bundler setup adds 85 vendor load paths that are absent
  in this production runtime. There are 107 Ruby load-path entries in total;
  22 exist.
- For a feature backed by a native extension, CRuby searches `.rb` candidates
  across load paths before searching `.so` candidates. Bootsnap itself is a
  concrete example: the genuine extension exists, but ordinary lookup probes
  earlier Ruby-source candidates first.
- RubyGems, Git, curl, Bash login startup, and Homebrew command discovery also
  test optional configuration and platform paths whose absence is meaningful.

Classifying the 4,694 open paths against the resulting VFS found 3,115 calls
to paths absent after the run, including 2,135 under Homebrew's vendor bundle.
A separate full result trace observed about 2,500 actual `ENOENT` opens per
warm invocation. These failed opens are not VFS corruption: returning
`ENOENT` is the required observable result. Removing candidates in Kandelo or
lying about their existence would change Ruby/Homebrew behavior.

Bootsnap is now the real upstream gem in the real portable-Ruby layout. It
reduces repeated load-path scans where Homebrew enables it, but it cannot make
every optional-path probe disappear. Preloading a generated Bootsnap cache
added about 2 MiB to the image and did not improve the controlled workload.

### Process cost and Ruby's `posix_spawn` patch

The text `brew info` command created 159 processes and performed 55 execs in
the focused result. A detailed trace counted 158 forks. Of those, 90 occurred
inside Bash-based Git shims, 32 inside the Bash curl shim, and 29 in the outer
`brew.sh` path. Only four were issued by Ruby; three belonged to the outer
`bin/brew` path. Ruby also created seven threads.

Therefore the Ruby patch that selects `posix_spawn()` instead of `vfork()` is
not the primary cause of this query's fork count. Bash uses ordinary `fork()`
for these scripts and has no relevant build-time switch that converts them to
`posix_spawn()`. An ABI-43 `vfork()` experiment reduced the focused query by
only about 2.3–2.4% and regressed broader startup controls by 37–50%. That
candidate is not part of this ABI-42 work.

### Lazy metadata and image cost

`INSTALL_RECEIPT.json` and `.brew/<formula>.rb` are upstream bottle members.
Previously, reading either from a deferred Formula activated the complete
bottle transport. The candidate embeds those exact authenticated member bytes
while retaining the complete source inventory and bottle digest for later
whole-archive validation.

The measured compressed shell image grew from 5,754,898 to 5,782,818 bytes:
27,920 bytes. In a closed zlib control this avoided a 107,543-byte bottle
fetch. Local wall time was neutral because the closed asset had no network
latency and Ruby startup dominated, but the ownership and transfer behavior
are now correct for metadata-only access.

The immutable benchmark fixture's portable-Ruby artifact costs:

| Artifact | Size |
| --- | ---: |
| Lazy ZIP download | 12,184,183 bytes (11.62 MiB) |
| Expanded portable tree | 41,331,702 bytes (39.42 MiB) |
| Main `ruby.wasm` within the tree | 21,365,256 bytes (20.38 MiB) |
| Files in the expanded tree | 2,493 |

This is paid only on first Homebrew activation in the lazy shell. It supplies
Homebrew's standard versioned Ruby tree plus the real Bootsnap and msgpack
gems. A narrow Bootsnap patch adds Ruby's Wasm platform to its upstream
supported-platform predicate; it does not replace the load-path cache. There
is no separate system-Ruby compatibility path.

The final clean package rebuild produced a 12,184,488-byte (11.62 MiB)
portable-Ruby ZIP, a 41,331,878-byte (39.42 MiB) expanded tree with 2,493
members, and a 21,365,814-byte (20.38 MiB) main `ruby.wasm`. The fixture is
305 bytes smaller because it predates the final build-tool-only correction;
the runtime composition and measured behavior are the same.

### Upstream patch accounting

This work does not patch `brew info`, formula discovery, Ruby `require`,
Bundler's generated paths, or Bootsnap's cache algorithm. It uses upstream
Homebrew, CRuby, msgpack, and Bootsnap through their normal runtime paths.

Kandelo already carried three reviewed compatibility changes before this
investigation:

- Homebrew's source is patched to recognize Kandelo's Wasm bottle tags and
  prefix relocation contract;
- CRuby selects Kandelo's non-forking `posix_spawn()` path for commands whose
  requested process attributes can be represented faithfully; and
- CRuby keeps command-line `-r` library roots visible across Kandelo's
  fork-instrumented startup path.

The only new patch to upstream source is
`packages/registry/ruby/patches/bootsnap-wasm-platform.patch`. It adds `wasm`
to three existing supported-platform regular expressions. Bootsnap 1.24.5
otherwise rejects the target before running its genuine loader and compile
caches. The patch changes no cache, path, or fallback semantics.

The remaining Ruby work is build configuration and Kandelo platform support:
the package follows Homebrew's portable-Ruby directory layout, stages the
exact upstream msgpack and Bootsnap gems by digest, builds their ordinary
native extensions as Wasm side modules, and loads those modules through
Kandelo's general `dlopen()` implementation. That support is not conditional
on Homebrew or on a Brew subcommand.

## Retained improvements

The old system-Ruby diagnostic took 23,601 ms and emitted 92,678 traced
syscalls, including 54,206 opens and 9,070 readlinks. A comparable instrumented
portable-Ruby diagnostic took 7,050 ms with 29,221 traced syscalls, 4,694
opens, and 170 readlinks. The final uninstrumented three-round warm medians are
4,616 ms on Node and 5,005 ms on Chromium. The traced pair identifies the
dominant improvement: use Homebrew's real portable Ruby and upstream load-path
cache path.

Two platform-owned changes have separate controlled evidence:

- resolving an existing HostFS prefix without redundant component-by-component
  host calls reduced a cold query from about 12.13 s to 8.97 s, roughly 3.2 s;
  the fast path falls back whenever a symlink or missing component requires
  full POSIX resolution; and
- pristine one-shot prestarted process Workers saved about 1.5–1.8 s without
  reusing a Realm or retaining a used Worker's process memory.

Directory indexes, cached channel views, syscall classification, polling,
main-thread kernel execution, and Realm reuse are not part of the retained
implementation. Experiments with broader SharedFS indexing and cache
preloading were wall-time neutral or worse and were reverted.

## Chromium boundary

Chrome for Testing 149 originally lost the renderer after repeatedly compiling
the same 20.38 MiB Ruby module in fresh process Workers. Stock Ruby reproduced
the failure on launch 13; a diagnostic Ruby with a smaller linear memory
reproduced it on launch 4. Disabling V8's Wasm tier-up made 20 launches
complete, which isolated the failure from guest linear-memory retention.

The retained candidate caches the immutable compiled `WebAssembly.Module` in
the machine's centralized kernel Worker. It does not reuse process Workers,
Realms, memories, or syscall channels. A rapid stock-Ruby test with ordinary
V8 tiering completed 20 of 20 launches. It created 65 Workers, peaked at seven
live Workers, and ended with only the centralized kernel Worker alive.

Cache hits compare the current VFS executable byte-for-byte against a private
copy before reusing compiled code. Exact content reached through several paths
shares one entry; path and `argv[0]` behavior do not change. This matters for
multicall programs: seven coreutils paths in the trace were the same 4.75 MiB
executable, and both Bash paths were the same 3.35 MiB executable. A path-only
cache exceeded its 64 MiB budget, evicted Ruby, and reproduced the crash on the
second query. Content deduplication held the complete query working set as
eight unique modules and 16 aliases in 44,845,570 comparison bytes with zero
evictions.

The stock Ruby comparison took about 3.4 ms per lookup in a Node
micro-measurement. Ruby accounts for 21,365,256 of the retained comparison
bytes, plus V8-owned compiled code whose size is not exposed. The cache is
bounded to 16 content entries, 256 path aliases, and 64 MiB of comparison bytes
per machine. A clean Node A/B/A used five invocations per machine. The four
warm values were 4,738–4,916 ms with the cache, 6,701–8,354 ms with capacity
set to zero, and 4,729–4,930 ms after restoring it. Warm medians were 4,804,
7,460, and 4,831 ms respectively: about a 35% reduction in this focused
control. Cold values were 10,088, 10,398, and 9,834 ms. This is evidence for
the mechanism, not the required three-round performance result.

With exact-content deduplication, the three independent complete Chromium
rounds covered cold and warm machines, every command, the eager control, and
the network audit without a renderer loss. Their medians were 9,106 ms cold,
5,335 ms immediate warm, 5,385 ms first on the booted command-sequence
machine, 5,005 ms repeated warm, 6,415 ms eager first, and 5,059 ms eager
warm. All six audited commands reported zero network syscalls.

Stock Ruby still grows one process memory to 303,300,608 bytes (289.25 MiB).
Exactly 256 MiB comes from CRuby 4.0.5's optional red-black object-shape cache:
native Ruby reserves it through sparse `mmap`, while Wasm linear memory grows
contiguously. A no-cache diagnostic reduced the final memory to 33.25 MiB, but
no Ruby source special case is retained. That upstream/configuration boundary
is separate from the compiled-module lifecycle fix.

The remaining 256 MiB Ruby object-shape reservation is not retained by a
terminated process Worker, but it makes every live Ruby process expensive.
Changing that upstream/configuration choice remains follow-up work rather than
part of this performance claim.

## Repository-wide performance contract

Freshly built protected `main` and candidate hosts ran these required commands
with three rounds and matching workload artifacts:

```text
npx tsx benchmarks/run.ts --rounds=3
npx tsx benchmarks/run.ts --host=browser --rounds=3
npx tsx benchmarks/compare.ts BEFORE.json AFTER.json
```

The final Node comparison improved process `clone`, `fork`, and `spawn` by
91.0%, 85.8%, and 88.8%; `exec` improved 10.5%. WordPress improved 0.4% for
its CLI path and 0.5% for first HTTP response. File reads improved 6.0%, while
writes fell 9.4%. Median syscall latency increased by 1.08 us, or 7.8%.

The full candidate-first/main-second Node pair showed several 5.0–16.1%
MariaDB query differences, especially in `mariadb-innodb-64`. An immediately
following three-round control of that exact suite and those exact artifact
digests put candidate queries between 1.6% faster and 3.0% slower, with
bootstrap 3.0% faster. An earlier reverse-order control was similarly within
1.9%. The full-suite values are therefore sensitive to surrounding run state;
they remain disclosed rather than supporting a universal regression-free
claim.

The final Chromium comparison improved process `clone`, `fork`, and `spawn`
by 63.6%, 57.1%, and 38.5%. WordPress boot changed by +0.9%, while first HTTP
response improved 49.6%. MariaDB bootstrap improved 7.0–8.4% across variants.
Median syscall latency increased from 14 to 18 us, file writes fell 11.1%,
and pipe throughput improved 111.1%. Some sub-14 ms SQL operations produced
large percentages because of timer quantization: the largest candidate
increase was 4.9 ms, while most select and join medians improved. These
results support the measured Homebrew and process-start claims, not a claim
that every microbenchmark improved.

## Remaining work, ranked by measured impact

1. Reduce the remaining 159 process launches, 55 execs, and roughly 29,000
   syscalls in a warm text query through general process and channel work.
   Preserve the dedicated kernel Worker, wakeup draining, POSIX semantics, and
   host parity. ABI batching work is the likely owner if this requires an ABI
   change.
2. Investigate Chromium's remaining 0.39 s warm text-query gap and 9.96 s
   `brew config` gap relative to Node. The same output and process counts point
   to host scheduling or compilation behavior, not a different Homebrew path.
3. Bound V8-owned compiled-code memory, whose size V8 does not expose. The
   complete Chromium query suite and focused 20-launch control are stable
   without Realm reuse, but only comparison bytes have an explicit 64 MiB cap.
4. Continue general VFS lookup optimization only where exact symlink,
   mutation, and `ENOENT` behavior can be proved. The accepted HostFS fast
   path is one such case; speculative negative caches are not.
5. Revisit Ruby parsing after the syscall/process costs. The measured parser
   opportunity is about 0.6 s; the Prism control currently traps on a Psych
   path and is not a valid product candidate.
