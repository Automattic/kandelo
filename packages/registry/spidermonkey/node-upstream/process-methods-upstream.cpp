// Complete original unit; native API definitions belong to their owning layers.
#include "shell/node-upstream/codec-agent-includes.h"
#include "shell/node-upstream/codec-native-api.h"
#include "shell/node-upstream/process-native-api.h"
#undef NODE_BINDING_CONTEXT_AWARE_INTERNAL
#undef NODE_BINDING_PER_ISOLATE_INIT
#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(name, callback) namespace kandelo_process_methods_adapter { Initializer initializer=::callback; }
#define NODE_BINDING_PER_ISOLATE_INIT(name, callback) namespace kandelo_process_methods_adapter { IsolateInitializer isolate_initializer=::callback; }
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/aliased_buffer-inl.h"
#include "shell/node-upstream/codecs-upstream/node_process_methods.cc"
