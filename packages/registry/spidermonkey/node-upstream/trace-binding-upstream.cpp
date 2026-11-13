#include "shell/node-upstream/trace-binding-native-api.h"
#undef NODE_BINDING_CONTEXT_AWARE_INTERNAL
#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(name,callback) namespace kandelo_trace_adapter { Initializer initializer=::callback; }
#define v8 kandelo_node_codec_api
#include "shell/node-upstream/trace-binding-upstream/node_trace_events.cc"
#undef v8
