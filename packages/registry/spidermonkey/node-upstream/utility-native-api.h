#ifndef KANDELO_NODE_UTILITY_NATIVE_API_H
#define KANDELO_NODE_UTILITY_NATIVE_API_H
// Complete original utilities consume these engine declarations. Operations
// without a real backend remain undefined, including isolate/snapshot creation.
#pragma push_macro("node")
#pragma push_macro("v8")
#undef node
#undef v8
namespace v8_inspector {
class StringView {
 public:bool is8Bit()const;size_t length()const;const uint8_t* characters8()const;const uint16_t* characters16()const;
};
}
namespace kandelo_node_codec_impl {
using namespace kandelo_node_codec_api;
class Environment;struct SnapshotData;
using AbortHandler=void(*)(const char*,const char*);
}
#ifndef NODE_EXTERN_PRIVATE
#define NODE_EXTERN_PRIVATE
#endif
#ifndef NODE_EXTERN
#define NODE_EXTERN
#endif
// Retire bridge assertion macros before the original header defines its own.
#undef CHECK
#undef CHECK_EQ
#undef CHECK_NE
#undef CHECK_GE
#undef CHECK_GT
#undef CHECK_LE
#undef CHECK_LT
#undef CHECK_NULL
#undef CHECK_NOT_NULL
#undef CHECK_IMPLIES
#undef DCHECK
#undef DCHECK_EQ
#undef DCHECK_NE
#undef DCHECK_GE
#undef DCHECK_GT
#undef DCHECK_LE
#undef DCHECK_LT
#undef DCHECK_NULL
#undef DCHECK_NOT_NULL
#undef DCHECK_IMPLIES
#undef ABORT
#undef ABORT_WITH_DETAILS
#undef ABORT_NO_BACKTRACE
#undef FIXED_ONE_BYTE_STRING
#undef SPREAD_BUFFER_ARG
#undef UNREACHABLE
#undef USE
#undef MAYBE_FIELD_PTR
#define node kandelo_node_codec_impl
#define v8 kandelo_node_codec_api
#include "shell/node-upstream/utilities-upstream/util.h"
#include "shell/node-upstream/utilities-upstream/util-inl.h"
#undef v8
#undef node
// Original assertion macros expand namespace tokens at their call sites. Own
// engine sources use the unaliased namespace; both names reach the same bodies.
namespace node {
using kandelo_node_codec_impl::AssertionInfo;
using kandelo_node_codec_impl::Assert;
using kandelo_node_codec_impl::GetAbortHandler;
}
namespace kandelo::node {
using kandelo_node_codec_impl::AssertionInfo;
using kandelo_node_codec_impl::Assert;
using kandelo_node_codec_impl::GetAbortHandler;
}
#pragma pop_macro("v8")
#pragma pop_macro("node")
#endif
