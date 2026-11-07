# TLS X509 focused ownership controls

These controls use exact native Node26.13.0, unchanged pinned X509 wrapper code,
actual X509Material and real native OpenSSL/nonblocking TCP sessions. The fixture
session is an explicit native boundary; it does not execute new guest JSAPI.

Prepare an ordinary task-private .context directory with the exact current
production bootstrap copied under repo/packages/registry/node-compat. Compile
component.cpp into that private directory as component.node using the declared
dev shell, native Node SDK/ncrypto headers and the production X509 owner header.
Provide a private include alias kandelo-node-digest-operations.h for the unchanged
production digest-operations.h, plus its unchanged crypto-errors/native-retained
memory dependencies and actual socket-owner.h. Never write compiler outputs
into the production source tree. Set TLS_X509_DIR to this private directory and
run control.cjs with the exact native Node --expose-internals --expose-gc. Cached
source fixtures are read from sibling nodejs-lts-cache-v2/node-v26.13.0.

Eight groups compare method shape and real certificate/issuer/cache values with
native TLS and exercise pointer-independent snapshots after SSL/context release.
The owner/constructor injection only establishes the stated component boundary;
it does not prove native preparation/AsyncWrap/realm/Worker/guest behavior. Full
_handle/Socket shape, legacy getPeerCertificate and encrypted-output/shutdown
ownership remain separate gaps. Exact producer compiler/input/artifact receipts
and all earlier versions are retained in the private capsule.
