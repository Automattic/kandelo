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
QPA parser controls first, then uses the application's normal Playwright
configuration and browser projects. Browsers are headless; it does not open a
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

Inventory enumeration is separate from test execution. Keep complete upstream
case lists, raw QPA and source/artifact identities for broader runs. Record
results and ordinary gaps in [the compatibility ledger](compatibility-v1.md).
Do not infer conformance from a successful build, an inventory or a demo.
