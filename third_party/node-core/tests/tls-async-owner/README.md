# TLS async-owner focused controls

Use exact Node 26.13.0 native headers/reference and the declared dev shell. No
product setup or engine build is needed. Compile header-component.cpp as one
small host addon using -std=c++20 -shared -fPIC -undefined dynamic_lookup and
include the pinned native Node include/node plus actual third_party/node-core.
Write header-component.node only to a guarded task-private .context directory.
Run control.cjs with that exact pinned Node, --expose-gc and explicit
TLS_ASYNC_OWNER_DIR pointing to the addon directory. The reference source key
fixtures are expected under its sibling .context/nodejs-lts-cache-v2 directory.

The helper exercises actual portable-header SSL construction/admission, not
Kandelo JSAPI. The other three groups observe genuine native TLSWRAP trigger,
ALS and weak-wrapper destruction policy. No substituted candidate provider is
used. A pass does not establish Kandelo TLSWRAP callback, realm, Worker, GC or
teardown conformance; the engine source remains a separately uncompiled slice.

The producer capsule records compiler/input/artifact hashes, exact commands,
all attempt results and source-only checks. No overall tests are invoked.
