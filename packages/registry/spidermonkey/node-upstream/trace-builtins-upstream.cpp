#include "shell/node-upstream/trace-builtin-native-api.h"
#define v8 kandelo_trace_builtin_api
#include "shell/node-upstream/trace-builtins-upstream/src/builtins/builtins-trace.cc"
#undef v8
namespace kandelo_trace_adapter {
void IsTraceCategoryEnabled(const FunctionCallbackInfo<Value>& args) {
  auto* isolate=args.GetIsolate();
  ReturnRaw(isolate,kandelo_trace_builtin_api::internal::Builtin_IsTraceCategoryEnabled(isolate,{}));
}
void Trace(const FunctionCallbackInfo<Value>& args) {
  auto* isolate=args.GetIsolate();
  ReturnRaw(isolate,kandelo_trace_builtin_api::internal::Builtin_Trace(isolate,{}));
}
}
