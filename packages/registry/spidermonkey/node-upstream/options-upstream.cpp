// Compile the complete pinned native parser/serializers in a private namespace.
// The API bridge implements marshalling with actual rooted SpiderMonkey values.
#include <uv.h>

#include "shell/node-upstream/options-native-api.h"
#define v8 kandelo_node_options_api
#define node kandelo_node_options_impl
#define uv_get_total_memory kandelo_options_adapter::UnavailableMemoryQuery
#define uv_get_constrained_memory kandelo_options_adapter::UnavailableMemoryQuery
#include "shell/node-upstream/options-upstream/node_options.cc"
