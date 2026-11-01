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
cases remain explicit results pending a separate applicability audit. The
consumer never changes upstream assertions or converts non-Pass results to Pass.

Inventory enumeration is separate from test execution. Keep complete upstream
case lists, raw QPA and source/artifact identities for broader runs. Record
results and ordinary gaps in [the compatibility ledger](compatibility-v1.md).
Do not infer conformance from a successful build, an inventory or a demo.
