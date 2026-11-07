# Public constant owner component controls

Pin: Node 26.13.0 / 18b32a3b1552e199a01f1a8d9fd64aa756d3b75b.
No product setup, guest execution or overall suite is performed.

The native-reference.cpp helper in the sealed source capsule collects values
from the generated complete conditional definitions with the pinned native
Node/OpenSSL headers and actual host OS headers. The small CLI helper executes
unchanged extracted production state/tokenizer/parser code. Those host helpers
have exact source/header/binary identities and are not guest evidence.

Run the component driver with the exact reference through the declared shell:

```
scripts/dev-shell.sh env CONSTANT_NATIVE_ADDON=/absolute/native-reference.node /absolute/pinned/node --expose-internals third_party/node-core/tests/public-constants/control.cjs /absolute/evidence
scripts/dev-shell.sh env CONSTANT_NATIVE_ADDON=/absolute/native-reference.node NODE26_SOURCE=/absolute/pinned/source /absolute/pinned/node --expose-internals third_party/node-core/tests/public-constants/upstream.cjs /absolute/evidence
```

Optional final argument to control.cjs selects one named group. Full and
focused results remain separate. The private capsule retains the initial
illegal attempt to add a property to a frozen signals bag, the setup diagnosis
and the corrected matched-OS-initialization control over mutable input bags.
It never unfreezes the actual signals bag or relaxes aggregate assertions.

The fixture requires the sealed sys-alias control's configureBuiltins and
skipESMResolver seams. It executes actual production public constants registry
getters/initializer and CJS loader/policy/cache, omitting only separate native
ESM resolver setup. Native FS/signals/VM and an opaque existing crypto API
object are explicit component dependencies. No full crypto method surface is
fabricated, and no guest JSAPI/null-prototype/CLI/ESM conformance is claimed.
The opaque API object's only tested contract is preservation of its identity
while installing its actual constants property.

Unchanged test-constants.js and its real upstream common harness run with all
assertions intact and --expose-internals retained. A declared private-binding
boundary supplies the actual generated header-backed constant objects. This
is not proof that the guest supports --expose-internals or a complete private
constants binding (zlib/trace/internal groups remain separately owned).

Crypto's real CLI string/defaultCipherList behavior is tested independently
from TLS. Existing tls.DEFAULT_CIPHERS and SSL_CTX cipher-suite/list consumers
remain missing and are not inferred from those constant/property results.
