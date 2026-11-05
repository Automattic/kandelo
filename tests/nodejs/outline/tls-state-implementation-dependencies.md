# Live TLS metadata and verification source owners

This partial secure-network slice addresses S-002 without closing that
finding, any individual API observation, or the family. Exact audited Node
26.13.0 source/native pins and the frozen audit remain unchanged.

## Actual owners

The existing native TLS handle owns the live SSL/SSL_CTX and descriptor.
Patch79 adds a synchronous metadata operation over that same SSL object;
there is no host certificate import, static protocol value, cached fake
session, or synthetic authorization result. Shared bootstrap TLSSocket now
queries actual protocol/cipher/reuse state and returns independent Buffer
copies of actual local/peer Finished bytes. Absent Finished data remains
undefined; the existing closed-handle public route returns null.

Authorization comes from the actual peer certificate and OpenSSL verification
result, with the pinned ncrypto missing-certificate/PSK/resumption policy.
The verification error-name switch is generated from the unchanged exact
ncrypto source. In the explicitly allowed-error mode, a callback continues
verification as pinned Node does and preserves its final error. This matters:
the default callback stopped at UNABLE_TO_GET_ISSUER_CERT_LOCALLY while the
pinned Node continuation reached UNABLE_TO_VERIFY_LEAF_SIGNATURE. No error
translation hides that difference. Default rejecting contexts retain
SSL_VERIFY_PEER with OpenSSL's rejecting callback.

OpenSSL's official documentation confirms client SSL_VERIFY_NONE still
checks the certificate and retains its result; it permits the handshake:
https://docs.openssl.org/3.3/man3/SSL_CTX_set_verify/
SSL_get_verify_result alone is insufficient when no certificate was sent;
the source explicitly checks the actual peer and pinned PSK exceptions.

## Bounded evidence and retained nonpasses

.context/node26-tls-state-controls-r3/report.json records four portable
OpenSSL memory-BIO handshake comparisons against pinned native Node loopback
TLS, plus four actual-bootstrap TLSSocket frontend scenarios. TLS1.2/TLS1.3
and trusted/untrusted CA cases compare protocol, exact cipher fields, session
reuse, authorization/error code and Finished lengths. Within each actual
OpenSSL pair, both Finished byte strings equal the opposite peer's bytes;
mutating a returned copy leaves connection state intact. Native controls
also check missing peer and no Finished before handshake. Frontend controls
use the actual class with explicit controlled transport and native-derived
metadata dependencies; they do not execute the guest JSAPI binding.

The first native Node fixture closed the client before observing server
handshake completion and encountered ECONNRESET. That harness error and
original script/log are retained. The fixture now awaits both actual secure
completion events and orderly shutdown. The second run retained two passes
and two real verification-code mismatches. The source callback correction
passes the same strict comparisons; neither assertion nor expected error
code was weakened. Earlier scripts, inputs and native binary remain retained.
An initial staging script stopped on a recipe whitespace assertion after
partial staging; its corrective follow-up is separate and recorded.

Four full unchanged target references and three unchanged certificate/key
fixtures are archive-verified. Generated source/bootstrap syntax, zero-fuzz
patch forward/reverse, direct build-input declarations, unchanged Mozilla
include checker, unchanged target/audit and Bun asset dispatch are checked.
These are not guest runtime results. Recipe69 adds no syscall, host import,
wire layout or ABI change. No overall suite or full product rebuild ran.

## Open dependencies

* Complete net.Socket inheritance, existing-transport wrapping, fd/handle
  generation identity, before-handshake allocation/state and reentrancy.
  Current public methods' function/descriptor/receiver metadata remains
  distinct from the target's proxy functions. These are implementation gaps.
* Actual certificates/X509 public objects and custom checkServerIdentity;
  OpenSSL hostname checking is not a substitute for all Node identity errors.
  HOSTNAME_MISMATCH versus ERR_TLS_CERT_ALTNAME_INVALID remains open.
* Trust-store/default/system/extra CA APIs, SecureContext/options/CA arrays,
  protocol/cipher/session/ALPN configuration, session tickets and resumption
  lifecycle, exporter/ephemeral keys and shared signature algorithms.
* Independent handshake cancellation/ref/deadline and asynchronous shutdown;
  full stream/socket controls, hard-reject error schema, allocation/GC/realm/
  worker/error/cleanup policy, servers and protocol owners.
* Browser TLS bridges report this guest TLS connection's actual metadata;
  it is not the separate upstream Fetch connection's certificate or protocol.
* Compile the guest bridge and validate identified artifacts on all four
  hosts. These portable/source/native controls do not establish that result.

Continue independent shared/public owners breadth first. Do not turn this
slice into a TLS-only validation campaign or count copied references as API
implementation.

The normal targeted wasm32 engine69 build subsequently succeeded in
225.1 seconds with all 588 frozen source identities unchanged.
Unchanged Mozilla checks, optimization and fork instrumentation passed.
.context/node26-engine-r69-accepted retains both executables, exact identities
and logs. This compiles the guest bridge, without establishing guest API
behavior or four-host conformance. No overall suite/full product rebuild ran.
