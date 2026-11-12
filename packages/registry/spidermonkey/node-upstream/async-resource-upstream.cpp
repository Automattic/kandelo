// Compile the complete original unit; no function bodies are extracted.
#include "shell/node-upstream/codec-agent-includes.h"
#include "shell/node-upstream/codec-native-api.h"
#include "shell/node-upstream/fatal-errors-native-api.h"
#include "shell/node-upstream/resource-native-api.h"
#include "shell/node-upstream/tracing-upstream/tracing/trace_event.h"
#include "shell/node-upstream/tracing-upstream/tracing/traced_value.h"
#undef NODE_BINDING_CONTEXT_AWARE_INTERNAL
#undef NODE_BINDING_PER_ISOLATE_INIT
#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(name,callback) namespace kandelo_async_resource_adapter {Initializer initializer=::callback;}
#define NODE_BINDING_PER_ISOLATE_INIT(name,callback) namespace kandelo_async_resource_adapter {IsolateInitializer isolate_initializer=::callback;}
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/resource-upstream/async_wrap.cc"
