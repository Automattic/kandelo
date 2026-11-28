# Node.js security limitations on Kandelo

## Requesting a secure heap leaves keys on the ordinary heap

The Kandelo build of Node.js 26.13.0 configures its bundled OpenSSL with
`no-secure-memory`. The guest cannot enforce the guard pages OpenSSL needs.
Key material that OpenSSL would place in a guarded arena therefore uses the
ordinary guest heap. This applies to the installed `node` and
`spidermonkey-node` commands on the Node.js host, Chromium, Firefox and WebKit.
See the [bundled provider configuration](prepare-native-providers.py) and the
[OpenSSL package's description of the lost protections](../openssl/SECURITY.md).

By default Node emits no secure-heap warning. To observe the fallback, run
this inside the guest:

```sh
node --secure-heap=65536 --secure-heap-min=4 -e '
  const crypto = require("node:crypto");
  const dh = crypto.getDiffieHellman("modp14");
  dh.generateKeys();
  console.log(crypto.secureHeapUsed());
'
```

Node writes `Unable to initialize openssl secure heap.` to stderr and
continues. After key generation, `total` reports the requested 65536 bytes
and `used` stays zero. Applications that require guarded key storage must use
a build and platform where secure-heap initialization succeeds. A successful
key operation or a positive `total` alone cannot establish that guarantee.
