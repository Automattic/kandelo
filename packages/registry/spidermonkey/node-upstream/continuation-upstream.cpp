#include "shell/node-upstream/continuation-native-api.h"
#undef NODE_BINDING_CONTEXT_AWARE_INTERNAL
#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(name,callback) namespace kandelo_continuation_adapter { Initializer initializer=::callback; }
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/continuation-upstream/async_context_frame.cc"
#undef node
#undef v8
namespace kandelo_continuation_adapter {
bool WithFrame(Isolate* isolate,Local<Value> value,const std::function<bool()>& callback) {
  kandelo_node_codec_impl::async_context_frame::Scope scope(isolate,value);
  return callback();
}
}
