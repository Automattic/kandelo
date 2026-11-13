#ifndef KANDELO_NODE_DEBUGGING_NATIVE_API_H
#define KANDELO_NODE_DEBUGGING_NATIVE_API_H
#include "shell/node-upstream/fatal-errors-native-api.h"
namespace kandelo_node_codec_impl::credentials {
// Environment-aware credentials remain a separate unavailable backend. The
// complete original diagnostics unit consumes this interface without a stub.
bool SafeGetenv(const char*,std::string*,Environment*);
}
#endif
