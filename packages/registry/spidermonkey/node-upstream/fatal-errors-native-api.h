#ifndef KANDELO_NODE_FATAL_ERRORS_NATIVE_API_H
#define KANDELO_NODE_FATAL_ERRORS_NATIVE_API_H
// Consumed interfaces for complete node_errors.cc. Missing operations remain
// declarations, so activating fatal/message/report paths requires real owners.
#include <atomic>
#include "shell/node-upstream/error-policy-native-api.h"
#include "shell/node-upstream/process-errors-native-api.h"
namespace kandelo_node_codec_api {
class ScriptOrigin {
 public:
 Local<Value> SourceMapUrl();Local<Value> ResourceName();int LineOffset();int ColumnOffset();
};
class Message:public Value {
 public:
 using Value::Value;static const int kNoScriptIdInfo;
 Local<Value> GetScriptResourceName();Maybe<int> GetLineNumber(Local<Context>);
 int GetStartColumn();int GetEndColumn();ScriptOrigin GetScriptOrigin();
 MaybeLocal<String> GetSourceLine(Local<Context>);Local<StackTrace> GetStackTrace();
 int ErrorLevel();Local<String> Get();
};
class StackFrame:public Value {
 public:
 using Value::Value;Local<String> GetFunctionName();Local<String> GetScriptName();
 int GetLineNumber();int GetColumn();bool IsEval();int GetScriptId();
};
class StackTrace:public Value {
 public:
 using Value::Value;
 // Private bridge flags; no V8 data/layout or stack metadata is synthesized.
 enum StackTraceOptions{kDetailed=1,kExposeFramesAcrossSecurityOrigins=2};
 static Local<StackTrace> CurrentStackTrace(Isolate*,int,StackTraceOptions);
 int GetFrameCount();Local<StackFrame> GetFrame(Isolate*,int);
};
struct OOMDetails {bool is_heap_oom;const char* detail;};
struct ModifyCodeGenerationFromStringsResult {bool codegen_allowed;MaybeLocal<String> modified_source;};
}
namespace kandelo_node_codec_impl {
struct FatalProcessOptions {bool report_on_fatalerror;};
struct FatalProcessOptionsAccess {const FatalProcessOptions* operator->()const;};
namespace per_process {
 extern Mutex cli_options_mutex;
 extern FatalProcessOptionsAccess fatal_cli_options;
}
enum class StackTracePrefix{kAt,kNumber};
namespace ContextEmbedderIndex {extern const int kAllowCodeGenerationFromStrings;}
struct FatalIsolateOptions {bool report_uncaught_exception;};
[[noreturn]] void AbortWithDetails(const char*,const char*);
void ResetStdio();std::string GetHumanReadableProcessName();
void DefineErrorConstant(Isolate*,Local<Object>,const char*,int);
void TriggerNodeReport(Environment*,const std::string&,const char*,const char*,Local<Value>);
void TriggerNodeReport(Isolate*,const char*,const char*,const char*,Local<Object>);
MaybeLocal<StackTrace> GetCurrentStackTrace(Isolate*,int=10);
std::string FormatErrorMessage(Isolate*,Local<Context>,const std::string&,Local<Message>,bool);
void PrintStackTrace(Isolate*,Local<StackTrace>,StackTracePrefix=StackTracePrefix::kAt);
}
#define NODE_DEFINE_CONSTANT(target,name) kandelo_node_codec_impl::DefineErrorConstant(isolate,target,#name,name)
#endif
