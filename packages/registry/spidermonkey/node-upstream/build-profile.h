#ifndef KANDELO_NODE_BUILD_PROFILE_H
#define KANDELO_NODE_BUILD_PROFILE_H

// The options compiler and build-metadata provider share the actual embedding
// selection. Library/source inclusion does not establish API conformance.
#define HAVE_OPENSSL 1
#define HAVE_INSPECTOR 0
#define NODE_USE_V8_PLATFORM 0
#define HAVE_FFI 0
#define HAVE_SQLITE 0
#define HAVE_AMARO 1
#define NODE_HAVE_I18N_SUPPORT 1
#define DISABLE_SINGLE_EXECUTABLE_APPLICATION 1

// No corresponding native units or heap builder are selected by this recipe.
// Enabling one requires integrating its backend, not changing metadata alone.
#define HAVE_DTLS 0
#define KANDELO_NODE_QUIC_BINDING 0
#define KANDELO_NODE_SNAPSHOT_BUILDER 0
#define KANDELO_NODE_CODE_CACHE 0

#endif
