#ifndef KANDELO_NODE_TRACE_BUILTIN_NATIVE_API_H
#define KANDELO_NODE_TRACE_BUILTIN_NATIVE_API_H
#include "js/Conversions.h"
#include "js/Value.h"
#include "shell/node-upstream/codec-agent-includes.h"
#include "shell/node-upstream/codec-native-api.h"
#include "shell/node-upstream/trace-builtins-upstream/messages.generated.h"
namespace kandelo_trace_builtin_api::internal {
using namespace kandelo_node_codec_api;
using Object=Value;
using JSAny=Value;
using ConvertableToTraceFormat=::v8::ConvertableToTraceFormat;
namespace tracing=::node::tracing;
template<class T> using DirectHandle=Local<T>;
template<class T> using Handle=Local<T>;
struct BuiltinArguments {
  Local<Value> atOrUndefined(Isolate* isolate,int index) { return Argument(isolate,index-1); }
};
template<class T,class U> Local<T> Cast(Local<U> value) {
  if constexpr(std::is_same_v<T,String>) CHECK(value->IsString());
  if constexpr(std::is_same_v<T,Number>) CHECK(value->IsNumber());
  return value.template As<T>();
}
template<class T,class U> T* Cast(U* value) {
  if constexpr(std::is_same_v<T,Number>) CHECK(value->IsNumber());
  return static_cast<T*>(value);
}
inline bool IsString(Value* value) { return value->IsString(); }
inline bool IsNumber(Value* value) { return value->IsNumber(); }
inline bool IsUndefined(Value* value,Isolate*) { return value->IsUndefined(); }
inline bool IsNullOrUndefined(Value* value,Isolate*) { return value->IsNullOrUndefined(); }
inline int32_t DoubleToInt32(double value) { return JS::ToInt32(value); }
struct ReadOnlyRoots {
  explicit ReadOnlyRoots(Isolate*) {}
  JS::Value true_value() { return JS::BooleanValue(true); }
  JS::Value false_value() { return JS::BooleanValue(false); }
  JS::Value boolean_value(bool value) { return JS::BooleanValue(value); }
};
// This embedding executes ordinary runtime calls, with no V8 fuzzing frontend.
inline constexpr struct { bool fuzzing=false; } v8_flags;
Local<Value> NewTraceTypeError(Isolate*,MessageTemplate);
MaybeLocal<Value> JsonStringify(Isolate*,Local<Value>,Local<Value>,Local<Value>);
inline JS::Value ThrowFailure(Isolate* isolate,Local<Value> error) {
  if (!error.IsEmpty()) isolate->ThrowException(error);
  return JS::UndefinedValue();
}
}
#define BUILTIN(name) JS::Value Builtin_##name(Isolate* isolate,BuiltinArguments args)
#define NewTypeError(message) NewTraceTypeError(isolate,message)
#define THROW_NEW_ERROR_RETURN_FAILURE(isolate,error) return ThrowFailure(isolate,error)
#define ASSIGN_RETURN_FAILURE_ON_EXCEPTION(isolate,target,expression) \
  do { if(!(expression).ToLocal(&(target))) return JS::UndefinedValue(); } while(false)
#endif
