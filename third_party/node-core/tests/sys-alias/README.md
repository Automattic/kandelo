# sys alias and initialization controls

Target: Node 26.13.0 / 18b32a3b1552e199a01f1a8d9fd64aa756d3b75b.
No product setup, guest engine build or overall suite is performed.

Run with the exact pinned native reference through the declared dev shell:

```
scripts/dev-shell.sh /absolute/path/to/node-v26.13.0/bin/node --expose-internals third_party/node-core/tests/sys-alias/control.cjs /absolute/evidence/path
scripts/dev-shell.sh env NODE26_SOURCE=/absolute/pinned/source /absolute/path/to/node-v26.13.0/bin/node --expose-internals third_party/node-core/tests/sys-alias/upstream.cjs /absolute/evidence/path
```

`control.cjs` executes the generated sys and warning owners, the actual
bootstrap sys initializer/getter and actual CJS loader/policy/cache sections.
Its native VM, filesystem, util object, EventEmitter and tick dependencies are
explicit boundaries. Public sys/node:sys lookup cannot silently fall through
to the native sys module. `skipESMResolver: true` omits the separately owned
ESM resolver installation only; it supplies no ESM graph or ESM proof. The
fixture default remains unchanged. The initial default-setup harness failure
is retained in the private source capsule.

Controls cover metadata without loading, alias ordering, shared descriptor
and mutation identity, reentry from emitWarning, failure/retry, warning call
receiver/arguments, cache poisoning versus node: bypass, synchronous versus
asynchronous delivery, no-warnings/no-deprecation, throw/trace-deprecation,
disable-warning code and NODE_NO_WARNINGS. Real stack frames are retained;
native VM compilation records node:sys origin. Native V8 stack capture is not
proof of SpiderMonkey stack behavior.

`upstream.cjs` executes unchanged pinned test-sys.js and its real upstream
common harness. Its candidate public builtin requests use the same actual
CJS/sys owner; the test harness itself remains a declared native boundary.
All assertions remain unchanged. This small upstream assertion does not
establish all sys/util, warning, ESM or four-host conformance.
