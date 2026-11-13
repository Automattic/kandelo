#ifndef KANDELO_NODE_REQUEST_NATIVE_API_H
#define KANDELO_NODE_REQUEST_NATIVE_API_H
#include "shell/node-upstream/resource-native-api.h"
// Original request constructors and ListNode destruction own membership. The
// environment owns the real intrusive head; no snapshot or substitute list.
#pragma push_macro("node")
#pragma push_macro("v8")
#undef node
#undef v8
#define node kandelo_node_codec_impl
#define v8 kandelo_node_codec_api
#include "shell/node-upstream/resource-upstream/req_wrap.h"
namespace node {
struct Environment::RequestQueue
    : ListHead<ReqWrapBase, &ReqWrapBase::req_wrap_queue_> {};
}
#undef v8
#undef node
#pragma pop_macro("v8")
#pragma pop_macro("node")
#endif
