#ifndef KANDELO_NODE_PERMISSION_NATIVE_API_H
#define KANDELO_NODE_PERMISSION_NATIVE_API_H

#include "shell/node-upstream/process-native-api.h"
// Whole policy classes share the original native strong/weak owners. Normal
// Environment policy initialization is a separate, still unavailable owner;
// declaring permission() never supplies an unconditional grant.
#pragma push_macro("node")
#undef node
#undef THROW_IF_INSUFFICIENT_PERMISSIONS
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/node_diagnostics_channel.h"
#include "shell/node-upstream/resource-upstream/permission/permission.h"
#undef node
#pragma pop_macro("node")

namespace kandelo_permission_adapter {
using namespace v8;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
extern Initializer initializer;
}
#endif
