# Focused scoped-address DNS controls

These standalone controls use the exact audited native Node26.13.0 reference,
production DNS JavaScript and the actual production c-ares resolver/parser
header. A small N-API fixture wraps real native Resolver instances; it links
an explicitly identified existing native c-ares 1.34.9 library. No package
resolver, global setup, provisioning or engine/product build runs.

```
WASM_POSIX_DEV_SHELL_ATTEMPTS=1 scripts/dev-shell.sh env \
  NODE26_REFERENCE=/absolute/pinned-reference/bin/node \
  DNS_ADDRESS_CARES_BUILD=/absolute/existing/native-cares-build \
  DNS_ADDRESS_CARES_SOURCE=/absolute/pinned-node/deps/cares \
  DNS_ADDRESS_CONTROL_DIR=/absolute/fresh/evidence \
  bash third_party/node-core/tests/dns-address-owner/run-controls.sh
```

The 44 checks compare callback/promise Resolver local-address validation and
server configuration with actual native Node, then exercise the production
parser and real native SetLocalIP status. IPv6 zone text follows pinned
uv_inet_pton, which ignores the zone for these byte-address APIs, including
an empty suffix and suffixes outside net.isIP's narrower public grammar.
Invalid addresses, duplicate families and NUL validation remain strict.

The component deliberately does not implement guest resource identity,
request/query dispatch or callback scheduling. Its actual configuration
owners are native N-API-wrapped c-ares objects, not guest JSAPI objects.
Errors at those excluded seams are explicit. The shared reverse parser path
is source-reviewed here; no live reverse-query conformance is implied.
CARES_NO_DEPRECATED suppresses c-ares' annotations on the unchanged selected
legacy APIs; other compiler warnings remain errors. It changes no API or
runtime behavior.
