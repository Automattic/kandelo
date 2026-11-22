#ifndef KANDELO_NODE_ERROR_POLICY_NATIVE_API_H
#define KANDELO_NODE_ERROR_POLICY_NATIVE_API_H
// Load the complete original policy/error templates with the existing complete
// formatter and actual native owners. Preserve a whole-source caller's aliases.
#pragma push_macro("node")
#undef node
#ifndef KANDELO_NODE_PROCESS_NATIVE_API_H
// The original formatter and its resource types are policy prerequisites.
#include "shell/node-upstream/process-native-api.h"
#endif
namespace v8 {
struct OOMDetails;
struct ModifyCodeGenerationFromStringsResult;
}
#define node kandelo_node_codec_impl
#include "shell/node-upstream/error-policy-upstream/node_errors.h"
#pragma pop_macro("node")
#endif
