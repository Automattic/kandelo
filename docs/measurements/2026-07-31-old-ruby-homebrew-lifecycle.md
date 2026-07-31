# Old-Ruby Homebrew lifecycle diagnostics — 2026-07-31

## Purpose and disposition

This record preserves the useful evidence from diagnostic pull requests
[PR #1165][pr-1165] and [PR #1168][pr-1168] so their branches do not
need to remain open or merge into the product. Both branches are
experiments, not product candidates, and neither blocks the Homebrew
cutover.

The experiments used the older, fork-heavy Ruby bottle. They do not
test the new `libyaml` and Ruby bottles being produced by the prefix
campaign. The next product decision must come from those new bottles in
the exact [PR #1147][pr-1147] Node.js and Chromium lifecycle, not from
another run of either old diagnostic branch.

This note distinguishes three kinds of statements:

- **Observed** facts came from a named job log or the matched local run.
- **Inferences** explain those observations but are not root-cause
  proof.
- **Follow-ups** name work that remains after the product cutover.

## Relation to earlier memory evidence

The [process-memory retirement measurements][retirement] established
that Kandelo drops its process-memory references at exact lifecycle
fences and that current engines can collect the retired backing. They
did not promise a portable collection deadline or cover a Brew-sized
process workload.

The [Node initialization measurements][node-init] then showed that
keeping process memory out of Node's `workerData` startup path reduced
maximum resident set size (RSS) by 12.2% in one matched local lifecycle.
RSS is the physical memory attributed to a process or process tree; it
is not a direct count of live Kandelo memories. That result justified
[PR #1157][pr-1157], but it did not establish a memory ceiling for stock
Brew.

The diagnostics below supply that missing application-level boundary.

## Node.js fresh-runner result

[PR #1165][pr-1165] moved runtime preparation to a separate job and ran
the stock Brew scopes on fresh Linux runners. Its product commit already
included PR #1157's one-shot process-worker initialization.

In [run 30613631109][node-run], the core and canary jobs started with
only about 0.43 GB and 0.50 GB of cgroup memory in use. Both then
entered the first-party `brew tap` operation and approached the hosted
runner's roughly 16 GB limit:

| Scope | Starting cgroup bytes | Last high sample | Recorded peak | Outcome |
| --- | ---: | ---: | ---: | --- |
| [Core][node-core] | 429,780,992 | 15,999,287,296 | at least 16,128,659,456 | Node was killed; the last pre-shutdown sample still had `oom_kill=0` |
| [Canary][node-canary] | 500,875,264 | 15,737,630,720 | 16,269,901,824 | Node was killed; final telemetry had `oom_kill=1` |

The canary job is direct evidence of a cgroup out-of-memory (OOM) kill.
The core job received a shutdown signal, so its log alone does not prove
that the cgroup OOM killer terminated it.

**Observed conclusion:** separating build preparation did not bound the
old-Ruby stock Brew workload, and keeping process memory out of
`workerData` was not a sufficient correction. The result rules out that
handoff as the complete explanation for this workload; it does not
erase the smaller local improvement measured for PR #1157.

**Not proved:** the run does not identify which V8 allocation retained
the memory, how many process memories were simultaneously live, or
whether one host-runtime change alone will bound pristine upstream
Ruby.

## Chromium and matched cross-engine result

[PR #1168][pr-1168] combined the old public Chromium fixture with the
bounded executable-module cache from [PR #1167][pr-1167]. The branch
was constructed to measure one hypothesis, not to provide a shippable
product.

### Hosted Chromium

Both scopes in [run 30635830180][chromium-run] reached the same final
cache telemetry: 160 executable requests, 149 hits, 11 misses,
3 evictions, and 8 retained entries representing 34,963,976 source
bytes.

Despite that reuse, the [core job][chromium-core] peaked at
13,915,262,976 cgroup bytes and the [canary job][chromium-canary]
peaked at 14,345,535,488 bytes. Both renderers crashed during the shared
first-party `brew tap` phase. Neither job recorded a cgroup OOM or
OOM-kill event. Neither reported a guest trap, Ruby exception, wrong
child status, or fork continuation diagnostic before the renderer
disappeared.

**Observed conclusion:** recompiling repeated executable bytes was not
the complete cause of the old-Ruby Chromium failure. The high cache hit
count shows that the renderer still failed after most executable
requests reused compiled modules.

### Matched local browsers

The same sealed core fixture and its 38 digest-verified inputs were run
on one Mac with all three Playwright engines:

| Engine | Result | Peak engine-tree RSS |
| --- | --- | ---: |
| Chromium 149 | Renderer crashed during `brew tap` | 7,021 MiB |
| Firefox 151 | Tap, install, and execution passed | 4,036 MiB |
| WebKit 26.5 | Instrumented Ruby hit an earlier Wasm stack overflow | 4,771 MiB |

Firefox completed in 5.7 minutes and its RSS fell between allocation
waves. Chromium reproduced the renderer loss in 61 seconds; its main
renderer alone reached about 6.43 GiB.

WebKit did not reach the Chromium failure. It stopped earlier with
`Maximum call stack size exceeded` while compiling and loading
instrumented Ruby code after the module had instantiated. That is
separate from Chromium's renderer-memory result. It is consistent with
the known WebKit stack sensitivity of an overly broad
`wasm-fork-instrument` closure, but this diagnostic did not prove that
root cause.

**Observed conclusion:** the old-Ruby result is engine-dependent.
Firefox completed the same sealed lifecycle, Chromium lost its renderer,
and WebKit encountered a different instrumentation-shaped failure. This
rules against treating the result as one simple, cross-engine semantic
failure in Kandelo.

### Inference, not root-cause proof

The Chromium trace recorded 712 process-worker script requests but only
160 executable-cache requests. The old Ruby imports at least 205 Wasm
pages, or 12.8125 MiB. Multiplying that minimum by the roughly 552 extra
worker generations yields about 7 GiB of cumulative memory-backing
churn, which is close to the observed Chromium peak.

That calculation is a workload explanation, not a count of
simultaneously live memory. The logs do not prove that all those
backings remained live at once, that `wasm-fork-instrument` caused the
Chromium failure, or that compiled-module reuse has no value.

## Decisive product test

Do not repeat these old-Ruby diagnostics as a cutover gate. After the
prefix campaign publishes the new `libyaml` and Ruby bottles, update
PR #1147's immutable inputs and run its exact public lifecycle:

1. boot the real mostly-lazy shell product;
2. materialize the new Ruby and `libyaml` bottle closure;
3. run stock first-party and independent third-party `brew tap`,
   install, and execute operations; and
4. require the exact Node.js and Chromium product evidence defined by
   PR #1147.

The new Ruby currently comes from [PR #1166][pr-1166]. Its temporary
Kandelo patch uses `posix_spawn()` for command shapes whose Ruby
semantics can be represented exactly, avoiding many fork-then-exec
memory copies. That makes the new-bottle run a real discriminator. A
passing run supersedes these old-Ruby failures for cutover; a failing
run provides current product evidence to diagnose.

## Follow-up ownership

- **Node.js soak after cutover:** rerun the bounded stock Brew Node
  workload against the final deployed bottle set. Treat a renewed
  high-memory result as host/process-memory work. Do not merge PR #1165
  merely to retain its recovery workflow or stale locks.
- **WebKit and fork instrumentation:** reproduce the WebKit stack
  failure with the new Ruby. If it remains, own the correction in the
  dedicated fork-instrumentation/next-ABI worktree, with the normal ABI
  decision and cross-host tests. Do not fold it into the Homebrew
  cutover branch.
- **Executable-module cache:** evaluate and land any product cache
  change through PR #1167 or a clean successor. PR #1168's telemetry is
  useful evidence, but its measurement-only build is not product
  validation.

## Why the diagnostic branches must not merge

PR #1165 contains a read-only recovery workflow whose own live
application proof still reaches the runner limit. It does not include
the bounded host correction its description requires, and its locks
name historical product inputs.

PR #1168 deliberately narrows the browser build, mixes a cache
candidate with measurement-only telemetry, and uses the superseded old
Ruby bottle. Its general staging run also did not complete the three
affected generated image builds. Product corrections and complete
product evidence belong in their separate reviewed PRs.

Preserving the observations here lets both diagnostic pull requests
close without losing their evidence. Closing them does not assert that
Node.js or WebKit follow-up is complete.

[pr-1147]: https://github.com/Automattic/kandelo/pull/1147
[pr-1157]: https://github.com/Automattic/kandelo/pull/1157
[pr-1165]: https://github.com/Automattic/kandelo/pull/1165
[pr-1166]: https://github.com/Automattic/kandelo/pull/1166
[pr-1167]: https://github.com/Automattic/kandelo/pull/1167
[pr-1168]: https://github.com/Automattic/kandelo/pull/1168
[node-run]: https://github.com/Automattic/kandelo/actions/runs/30613631109
[node-core]: https://github.com/Automattic/kandelo/actions/runs/30613631109/job/91102360985
[node-canary]: https://github.com/Automattic/kandelo/actions/runs/30613631109/job/91102360969
[chromium-run]: https://github.com/Automattic/kandelo/actions/runs/30635830180
[chromium-core]: https://github.com/Automattic/kandelo/actions/runs/30635830180/job/91174009755
[chromium-canary]: https://github.com/Automattic/kandelo/actions/runs/30635830180/job/91174009747
[retirement]: 2026-07-28-process-memory-retirement-rss.md
[node-init]: 2026-07-30-node-process-worker-init-ownership.md
