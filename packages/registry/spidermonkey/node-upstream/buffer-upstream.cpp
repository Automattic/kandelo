// Compile every original Buffer algorithm against the native engine bridge.
#include "shell/node-upstream/codec-agent-includes.h"
#include "shell/node-upstream/codec-native-api.h"
namespace kandelo_node_codec_impl { using ::node::Mutex; }
#undef NODE_BINDING_CONTEXT_AWARE_INTERNAL
#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(name,callback) namespace kandelo_buffer_adapter { Initializer initializer=::callback; }
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/node_buffer.cc"
