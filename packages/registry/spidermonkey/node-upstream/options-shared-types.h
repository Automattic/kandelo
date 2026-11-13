#ifndef KANDELO_NODE_OPTIONS_SHARED_TYPES_H
#define KANDELO_NODE_OPTIONS_SHARED_TYPES_H
// Share the actual original parsed C++ records across native binding adapters.
// Preserve the caller's marshalling/assertion macros; no option state is copied.
#pragma push_macro("node")
#pragma push_macro("v8")
#pragma push_macro("CHECK")
#pragma push_macro("CHECK_EQ")
#pragma push_macro("CHECK_NE")
#pragma push_macro("UNREACHABLE")
#pragma push_macro("FIXED_ONE_BYTE_STRING")
#pragma push_macro("NODE_DEFINE_CONSTANT")
#pragma push_macro("THROW_ERR_OPTIONS_BEFORE_BOOTSTRAPPING")
#pragma push_macro("NODE_BINDING_CONTEXT_AWARE_INTERNAL")
#pragma push_macro("NODE_BINDING_EXTERNAL_REFERENCE")
#pragma push_macro("NODE_EXTERN_PRIVATE")
#pragma push_macro("NODE_EXTERN")
#pragma push_macro("BOOL_FIELD")
#undef node
#undef v8
#ifndef KANDELO_OPTIONS_API_H
#undef CHECK
#undef CHECK_EQ
#undef CHECK_NE
#undef UNREACHABLE
#undef FIXED_ONE_BYTE_STRING
#undef NODE_DEFINE_CONSTANT
#undef THROW_ERR_OPTIONS_BEFORE_BOOTSTRAPPING
#undef NODE_BINDING_CONTEXT_AWARE_INTERNAL
#undef NODE_BINDING_EXTERNAL_REFERENCE
#undef NODE_EXTERN_PRIVATE
#undef NODE_EXTERN
#endif
#include "shell/node-upstream/options-native-api.h"
#define node kandelo_node_options_impl
#define v8 kandelo_node_options_api
#include "shell/node-upstream/options-upstream/node_options.h"
#undef v8
#undef node
#pragma pop_macro("BOOL_FIELD")
#pragma pop_macro("NODE_EXTERN")
#pragma pop_macro("NODE_EXTERN_PRIVATE")
#pragma pop_macro("NODE_BINDING_EXTERNAL_REFERENCE")
#pragma pop_macro("NODE_BINDING_CONTEXT_AWARE_INTERNAL")
#pragma pop_macro("THROW_ERR_OPTIONS_BEFORE_BOOTSTRAPPING")
#pragma pop_macro("NODE_DEFINE_CONSTANT")
#pragma pop_macro("FIXED_ONE_BYTE_STRING")
#pragma pop_macro("UNREACHABLE")
#pragma pop_macro("CHECK_NE")
#pragma pop_macro("CHECK_EQ")
#pragma pop_macro("CHECK")
#pragma pop_macro("v8")
#pragma pop_macro("node")
#endif
