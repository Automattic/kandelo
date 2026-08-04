# In-guest Homebrew query benchmark

This benchmark measures real Homebrew metadata queries inside Kandelo on Node
and Chromium. It separates a cold machine plus its first Brew invocation, the
first invocation after a shell process has already run, repeated warm
invocations, and an optional fully materialized VFS control.

The preparation step is the only networked phase. It embeds exact tap
checkouts into a copy of a published shell image, downloads every deferred
artifact, and verifies each artifact's declared byte count and SHA-256 digest.
The runners then bind those bytes as closed lazy assets. Node disables its TCP
backend, and Chromium blocks and reports every request outside the local
fixture origin. The first round also records guest socket syscalls for every
command.

Prepare one fixture and reuse that exact manifest for both sides of a
comparison:

```bash
npx tsx benchmarks/homebrew-query/prepare.ts \
  --image /path/to/shell.vfs.zst \
  --kernel /path/to/kandelo-kernel.wasm \
  --bootstrap /path/to/homebrew-bootstrap.zip \
  --output /tmp/kandelo-homebrew-query \
  --source-commit FULL_PRODUCER_COMMIT \
  --tap kandelo-dev/tap-core=/path/to/tap-core \
  --tap owner/canary-tap=/path/to/canary-tap \
  --canary-formula owner/canary-tap/formula \
  --trust-formula kandelo-dev/tap-core/dash \
  --eager
```

The shell metadata supplies the Homebrew prefix and shell path; the harness
does not assume either the rev22 compatibility prefix or the canonical prefix.
Tap checkouts should be clean and pinned to the commits under test.
`--trust-formula` records ordinary formula-granular Homebrew trust in the
fixture. The generated environment points Homebrew at that immutable store
under `/etc` through `XDG_CONFIG_HOME`, because Kandelo intentionally replaces
`/home/user` with fresh scratch storage at boot. Use it when a third-party
Formula has a fully qualified dependency; do not disable Homebrew's tap-trust
enforcement for the benchmark.

Run the focused workload on both hosts:

```bash
npx tsx benchmarks/homebrew-query/run-node.ts \
  --fixture /tmp/kandelo-homebrew-query/manifest.json \
  --rounds 3 --output /tmp/homebrew-node.json
npx tsx benchmarks/homebrew-query/run-browser.ts \
  --fixture /tmp/kandelo-homebrew-query/manifest.json \
  --rounds 3 --output /tmp/homebrew-chromium.json
```

Results include artifact and tap identities, host versions, machine details,
host-side monotonic timings, process counts, lazy transfer counts and bytes,
output hashes, and the syscall network audit. Compare like-for-like results
with a deliberately broad 25 percent threshold that detects a large regression
without turning ordinary host timing noise into a failure:

```bash
npx tsx benchmarks/homebrew-query/compare.ts \
  /tmp/homebrew-before.json /tmp/homebrew-after.json
```

This focused threshold does not replace the repository's full Node and browser
performance contract in `docs/agent-guidance/performance.md`.
