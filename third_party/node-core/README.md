# Pinned Node assertion implementation

`upstream/` contains the unmodified Node 26.13.0 `assert` public module,
internal comparison algorithm and assertion message utilities. The hashes
and source commit are recorded in `sources.json` and match the API target
in `packages/registry/node-compat/target.json`. The Node and original
Narwhal licenses are preserved in the generated bundle.

`adapter.js` supplies real intrinsic brands, enumerable non-index property
filtering, byte comparisons, captured primordial methods and the existing
compatibility inspection/formatting functions. Promise detection uses an
engine binding without calling `then`, observing properties or installing
rejection handlers. CryptoKey and KeyObject constructors are unsupported
in this runtime and no synthetic key objects are introduced.

The public assertion and comparison algorithms are not rewritten by the
test runner. Strict aliases, error matchers, async assertions, loose and
strict comparison, partial comparison and Assert instances come from the
pinned sources. `util.isDeepStrictEqual` uses the same comparison module.

Diagnostics are still partial: the adapter's AssertionError exposes the
error code, operator, actual/expected values and generatedMessage state,
but does not implement Node's colored/full diffs, custom inspection or
exact stack formatting. Argument error messages also use Kandelo's
formatter. The engine has no Node error-source-expression binding;
`build.py` makes one guarded diagnostic adaptation so a missing expression
uses the normal default assertion message. It does not change the
assertion outcome. The raw upstream utility remains checked in unchanged.

Regenerate or verify offline, without rebuilding packages:

```sh
scripts/dev-shell.sh python3 third_party/node-core/build.py
scripts/dev-shell.sh python3 third_party/node-core/build.py --check
```

Source differential tests require the pinned Node 26 reference rather
than the independent host Node 24 toolchain. Guest fixtures exercise both
hosts after the SpiderMonkey package is rebuilt. Source conformance is
not evidence that a stale guest artifact contains these changes.

Upstream source:
<https://github.com/nodejs/node/tree/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib>.
