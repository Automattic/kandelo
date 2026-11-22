#ifndef KANDELO_NODE_REQUEST_NATIVE_API_H
#define KANDELO_NODE_REQUEST_NATIVE_API_H
#include "shell/node-upstream/resource-native-api.h"
// Original request constructors and ListNode destruction own membership. The
// environment owns the real intrusive head; no snapshot or substitute list.
#pragma push_macro("node")
#undef node
#define node kandelo_node_codec_impl
#include "shell/node-upstream/resource-upstream/req_wrap.h"
namespace node {
struct Environment::RequestQueue
    : ListHead<ReqWrapBase, &ReqWrapBase::req_wrap_queue_> {};
}
#undef node
#pragma pop_macro("node")
#endif
