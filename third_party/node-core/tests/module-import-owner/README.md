# Focused original-request import controls

```sh
scripts/dev-shell.sh env NODE26_REFERENCE=/absolute/pinned/node \
  MODULE_IMPORT_CONTROL_DIR=/fresh/evidence/directory \
  bash third_party/node-core/tests/module-import-owner/run-controls.sh
```

The nine groups exercise the actual candidate JS forwarding method over native
Node's real internal loader. They cover specifier conversion, original referrer/
attribute identity, relative/bare/builtin/CJS/JSON imports, hooks/cache/query
identity, custom attributes, thrown identities, asynchronous/TLA completion and
namespace then exports. The native loader is an explicit component dependency.
They do not compile or execute the new production SpiderMonkey request/completion
owner, its ordinary syntax-import consumer or actual candidate native graph
resolve/load callbacks. They establish neither guest nor four-host conformance.

The normal native loader canonicalizes symlinked /tmp paths on macOS. The cache
load-count assertion matches the actual realpath URL, retaining the count=1
assertion. Initial mismatched-fixture raw failure is preserved in task evidence.
No runtime defect or production workaround is inferred.

See module-import-owner.md for the remaining engine/loader/async/realm/lifecycle
and complete public test-runner process/IPC/CLI/watch/coverage dependencies. No
package/engine/product build, compilation, global setup or overall suite runs.
