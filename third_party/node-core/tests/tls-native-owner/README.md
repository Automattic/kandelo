# Native TLS ownership control

Run the script through the declared dev shell with the pinned native Node
binary, matching complete source tree and a private output directory.
This Darwin control compiles the exact portable socket/tls owner headers
against that Node/OpenSSL backend and drives actual loopback TCP and TLS.
It checks transactional descriptor transfer, real handshake/plaintext,
actual SSL/SSL_CTX free callbacks, refused active-read transfer, immutable
generation and same-number descriptor reuse after close.

This does not execute the SpiderMonkey JSAPI bridge, Promise hooks,
worker/GC shutdown, public Node TLS frontend, browser hosts or HTTPS pool
activation. No fake stream handle, provider, session or cipher is supplied.
A passing native control is not four-host or public-core conformance.
