#ifndef KANDELO_NODE_FATAL_ERRORS_NATIVE_API_H
#define KANDELO_NODE_FATAL_ERRORS_NATIVE_API_H
// Consumed interfaces for complete node_errors.cc. Missing operations remain
// declarations, so activating fatal/message/report paths requires real owners.
#include <atomic>
#include <string_view>
#include "shell/node-upstream/error-policy-native-api.h"
#include "shell/node-upstream/process-errors-native-api.h"

namespace kandelo_node_codec_impl {
namespace per_process {
 extern Mutex& cli_options_mutex;
 extern std::shared_ptr<kandelo_node_options_impl::PerProcessOptions>& fatal_cli_options;
}
namespace ContextEmbedderIndex {extern const int kAllowCodeGenerationFromStrings;}
[[noreturn]] void AbortWithDetails(const char*,const char*);
void ResetStdio();std::string GetHumanReadableProcessName();
void DefineErrorConstant(Isolate*,Local<Object>,const char*,int);
std::string TriggerNodeReport(Environment*,std::string_view,std::string_view,std::string_view,Local<Value>);
std::string TriggerNodeReport(Isolate*,std::string_view,std::string_view,std::string_view,Local<Value>);
}
#define NODE_DEFINE_CONSTANT(target,name) kandelo_node_codec_impl::DefineErrorConstant(isolate,target,#name,name)
#endif
