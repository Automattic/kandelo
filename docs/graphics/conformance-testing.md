# Graphics conformance consumers

The full pinned upstream `graphics-cts` package supplies `deqp-egl`,
`deqp-gles2` and their original data. Build them through the normal SDK and
package resolver. See the [package README](../../packages/registry/graphics-cts/README.md)
for its upstream pin, enabled modules and unfinished native adapter services.
Missing artifacts must be provisioned; they are not reasons to skip tests.

After normal package, kernel, image-writer and browser dependency provisioning,
run the complete 31-case GLES2 negative-state group:

```sh
scripts/dev-shell.sh bash scripts/test-graphics-cts.sh --project chromium
```

Omit the project argument to run Chromium, Firefox and WebKit. The script runs
QPA parser controls first, then uses a dedicated configuration inheriting the
application's normal Playwright browser projects and Vite runtime plugins.
It owns a strict local server and scans only the plain CTS fixture page,
avoiding unrelated gallery image provisioning. Set `KANDELO_PLAYWRIGHT_PORT`
to choose another port (default 5401). Browsers are headless; it does not open a
desktop window. It resolves actual package outputs, builds a normal VFS image,
boots `BrowserKernel` with dedicated workers and attaches the real WebGL2 KMS
renderer. It uses upstream's standard hidden-window option, not a replacement
surface or renderer. Normal SourceOnly resolution can select a coherent bounded
artifact projection without building unrelated desktop packages.

The spec preserves upstream QPA as a test attachment and records artifact
hashes, exact arguments, browser version, case outcomes, diagnostics and
cleanup in `cts-evidence.json`. Chromium also records its actual command line.
All 31 case identities must appear exactly once, with complete matching XML
records and `Pass` results. Missing, extra, duplicated, malformed, incomplete,
failed or unsupported cases fail the gate. Worker closure and memory-boundary
checks are required. Passing this group does not establish the complete
graphics baseline or the broader browser-memory regression gate.

The consumer subscribes to normal process-generation observations before init.
It requires the exact child's admission, semantic exit and cooperative retirement
in one realm/image identity, with all real main/thread acknowledgments and no
post-commit failure. The proof snapshot is captured before destroy, including
failed runs. Forced teardown cannot satisfy that proof. Native kernel-worker
closure and every worker closure actually exposed by Playwright remain separate
checks; nested process-worker enumeration alone is incomplete across engines.
These receipts establish guest-memory retirement, not native thread join or GC.
Console errors remain failures. Bounded records now retain their public worker,
source location and timestamps; unknown provenance is not treated as expected.

The same consumer can probe the complete pinned 246-case negative API group:

```sh
scripts/dev-shell.sh bash -c 'KANDELO_CTS_GLES2_GROUP=negative-api bash scripts/test-graphics-cts.sh --project chromium'
```

Its checked-in case manifest comes from the actual upstream inventory and
must match the package's upstream revision. The default remains the smaller
negative-state group. The broader probe currently fails; its recorded failures
are implementation work, not accepted expectations. Unsupported compressed-format
cases remain explicit. The applicability audit confirms that no specific
compressed format is required by GLES 2.0; it does not validate callable
compressed API metadata or transport. The
consumer never changes upstream assertions or converts non-Pass results to Pass.

Inventory enumeration is separate from test execution. Keep complete upstream
case lists, raw QPA and source/artifact identities for broader runs. Record
results and ordinary gaps in [the compatibility ledger](compatibility-v1.md).
Do not infer conformance from a successful build, an inventory or a demo.

The complete 19-case color-clear group exercises upstream rendered-pixel
comparisons, including color masks, scissors and repeated clears:

```sh
scripts/dev-shell.sh bash -c 'KANDELO_CTS_GLES2_GROUP=color-clear bash scripts/test-graphics-cts.sh --project chromium'
```

It uses the same normal executable, data and renderer, with an exact case
manifest from the pinned 19,825-case upstream inventory. No upstream assertion
or native surface behavior is changed for this group. Its inclusion is an
executable probe, not a claim that its cases already pass.

The first color-clear probe aborts before comparison because the prior C readback
transport refuses outputs larger than 64 KiB. Keep that ResourceError and all
missing later cases visible while the captured-readback repair is rebuilt and
validated; source controls do not establish a rendered pass.

## Chunked browser runner liveness

`scripts/run-graphics-cts.sh` keeps the guest's progress-based case deadline
separate from page/transport liveness. A responsive page can run a long chunk
as long as each case makes progress within its existing limit. The Node
runner probes page responsiveness once per second, with at most one probe
outstanding and a 30-second host timer. Setup, QPA reads and kernel teardown
also have host-side guards; page timers cannot enforce these bounds when
the page itself is wedged.

An unresponsive page is a runner failure, not an inferred guest Timeout or
Pass. Its chunk, planned cases, artifact hashes, browser version, failed
phase and cleanup failures are written under `<engine>/runner-errors/`.
The absent chunk record remains Missing in the normal summary and the
runner exits unsuccessfully. Closing an unresponsive context is bounded;
if it fails, the runner attempts bounded retirement of its own browser.
This changes no upstream assertion, case budget or accepted outcome.

Ordinary attempt records retain a bounded stdout/stderr prefix (up to
65,536 characters) and a copied progress snapshot, including the last case
entered. A fatal kernel error can prevent reading QPA while the page still
has this diagnostic evidence. These fields do not create case verdicts:
cases without authoritative results keep their normal Missing status.

The chunked runner keeps Playwright artifacts under
`$KANDELO_CTS_OUT/<engine>/playwright`, beside that engine's chunk records.
It does not clean the application's default `test-results` directory or
another suite's output. Concurrent source servers also need separate
worktrees and ports so their Vite dependency caches remain independent.
The output-isolation probe passes 19 strict GLES2 color-clear and five
strict EGL info cases on each engine while preserving both default-output
and previous-suite control files; see
`.context/cts-output-isolation-probe-r2/`.

## Native-divergence audit

Host validation decides guest GL acceptance. Production samples native
errors at submitted-batch boundaries; private host allocation and cleanup
checks remain exact. The test-only audit described in
[the architecture notes](../architecture.md) checks every native call
against the host's prediction, so a suite run exposes prediction gaps. Enable it for the
chunked dEQP runner with `KANDELO_GL_AUDIT`:

```sh
scripts/dev-shell.sh bash -c 'KANDELO_GL_AUDIT=record bash scripts/run-graphics-cts.sh gles2 chromium functional.negative_api'
```

`record` reports every divergence and continues. `fatal` stops the machine
at the first validation divergence with a fatal host fault naming the call,
import, process, session and op. Native OOM retains its documented context
reset policy under audit too (D-50). dEQP's QPA log lives in that machine's filesystem,
so a fatal divergence loses the whole attempt's results and the runner
records the chunk's cases as Missing; use `record` to inventory a suite and
`fatal` as the gate once a selection is clean. Records are written per chunk
attempt to
`<engine>/gl-audit/<chunk>.attemptN.jsonl`, one JSON line each with the dEQP
case that was running and the audit record: native call, observed and
predicted outcome, cause (`unpredicted`, `native-decided` for a gap the
table in `host/src/webgl/native-predictions.ts` already names, or a
boundary such as `out-of-memory`), kernel import, process, session, guest op
and the host call stack. Stack line numbers are those of the transpiled
module the browser ran; function names are the stable part. A case result
under `record` must match the same run without the audit; the audit adds a
renderer round trip per native call, so per-case time grows.

Browser specs that boot machines from the demo pages (compositors, desktop
sessions) use the development server's test hook instead, so the specs
themselves are unchanged. Set both variables for the server Playwright
starts:

```sh
KANDELO_BROWSER_TEST_GL_AUDIT=record KANDELO_BROWSER_TEST_GL_AUDIT_LOG=/abs/path/audit.jsonl \
  npx playwright test test/kandelo-cage.spec.ts --project=chromium
```

Each line of the log carries the page, the arrival time and the record. The
hook exists only on the development server (`apply: "serve"`); production
pages cannot enable the audit.
