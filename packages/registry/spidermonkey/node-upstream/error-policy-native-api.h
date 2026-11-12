#ifndef KANDELO_NODE_ERROR_POLICY_NATIVE_API_H
#define KANDELO_NODE_ERROR_POLICY_NATIVE_API_H
// Load the complete original policy/error templates with the existing complete
// formatter and actual native owners. Preserve a whole-source caller's aliases.
#pragma push_macro("node")
#pragma push_macro("v8")
#undef node
#undef v8
#ifndef KANDELO_NODE_PROCESS_NATIVE_API_H
// The original formatter and its resource types are policy prerequisites.
#include "shell/node-upstream/process-native-api.h"
#endif
namespace kandelo_node_codec_api {
struct OOMDetails;
struct ModifyCodeGenerationFromStringsResult;
}
#define node kandelo_node_codec_impl
#define v8 kandelo_node_codec_api
#include "shell/node-upstream/error-policy-upstream/node_errors.h"
#pragma pop_macro("v8")
#pragma pop_macro("node")
#endif
