# Original native request transaction controls

Run freshly with pinned Node 26.13.0 through the declared shell, without
conformance global setup or a product build:

```sh
scripts/dev-shell.sh "$NODE26" --expose-internals --js-source-phase-imports \
  third_party/node-core/tests/module-import-request-identity/control.cjs \
  "$CANDIDATE_ROOT" "$GRAPH_SOURCE" after "$GENERATED_CORE_BUNDLE"
scripts/dev-shell.sh "$NODE26" --expose-internals \
  third_party/node-core/tests/module-import-request-identity/empty-control.cjs \
  "$CANDIDATE_BOOTSTRAP"
```

The graph control executes the actual candidate resolve/record/load methods,
not only native import forwarding. Actual native resolve/load hooks replace a
raw attribute record whose type getter throws; the actual supplied source must
be retained with zero original getter reads. Two genuine native ModuleWrap
request-report records are captured once and held as explicit keys for
same-URL handoffs. These reports are fresh on each native getModuleRequests
call; they are not claimed to expose native internal request identity. The
new C++ bridge passes SpiderMonkey's actual opaque request and remains
uncompiled/unexecuted. No fabricated module/provider or guest support is used.

The final native-only control verifies the original resolve-error object and
actual retry behavior when hooks change. An earlier sticky-error hypothesis
failed and remains preserved; no production error-cache workaround follows it.
The empty-specifier control executes the exact production bootstrap function
over the real native resolver and preserves its original error contract.
All failed source/setup/assertion identities remain in the review capsule;
unchanged upstream assertions are not modified.
