#pragma once
#include "shell/node-upstream/trace-utf8-native.h"
// Engine operations for the whole pinned builtins-trace.cc. Validation order,
// trace flags, JSON policy and returns stay in that original unit.
namespace v8::bridge::extras {
using Isolate=v8::Isolate;using Object=v8::Value;using JSAny=v8::Value;
using String=v8::String;using Number=v8::Number;
template<class T>using DirectHandle=v8::Local<T>;
template<class T>using Handle=v8::Local<T>;
template<class T>Local<T> Cast(Local<Value> value){return value.As<T>();}
template<class T>T* Cast(Value* value){
  CHECK(value);
  if constexpr(std::is_same_v<T,Number>)CHECK(value->IsNumber());
  if constexpr(std::is_same_v<T,String>)CHECK(value->IsString());
  return static_cast<T*>(value);
}
inline bool IsString(Value* value){return value->IsString();}
inline bool IsNumber(Value* value){return value->IsNumber();}
inline bool IsNullOrUndefined(Value* value,Isolate*){return value->IsNullOrUndefined();}
inline bool IsUndefined(Value* value,Isolate*){return value->IsUndefined();}
inline int32_t DoubleToInt32(double value){return JS::ToInt32(value);}
class NativeBuiltinArguments {
  const FunctionCallbackInfo<Value>& args_;
 public:
  explicit NativeBuiltinArguments(const FunctionCallbackInfo<Value>& args):args_(args){}
  Local<Value> atOrUndefined(Isolate* isolate,int index)const{
    return index>0&&index<=args_.Length()?args_[index-1]:Undefined(isolate);
  }
};
class ReadOnlyRoots {
  Isolate* isolate_;
 public:
  explicit ReadOnlyRoots(Isolate* isolate):isolate_(isolate){}
  Local<Value> false_value(){return False(isolate_);}
  Local<Value> true_value(){return True(isolate_);}
  Local<Value> boolean_value(bool value){return Boolean::New(isolate_,value);}
};
class NativeUtf8 {
  std::vector<char> bytes_;
 public:
  NativeUtf8(Isolate* isolate,Local<String> value){
    auto& frame=Current(isolate);JS::RootedString string(frame.cx,Input(value).toString());
    try{
      if(!kandelo::node::EncodeTraceString(frame.cx,string,&bytes_))
        bridge::FatalOutOfMemory(isolate,"Trace UTF8 encoding",false);
    }catch(const std::bad_alloc&){bridge::FatalOutOfMemory(isolate,"Trace UTF8 storage",false);}
  }
  const char* operator*(){return bytes_.data();}
};
enum class MessageTemplate {kTraceEventCategoryError,kTraceEventNameError,
  kTraceEventNameLengthError,kTraceEventPhaseError,kTraceEventIDError};
inline Local<Value> NativeTypeError(Isolate* isolate,MessageTemplate message){
  const char* text=nullptr;
  switch(message){
    case MessageTemplate::kTraceEventCategoryError:text="Trace event category must be a string.";break;
    case MessageTemplate::kTraceEventNameError:text="Trace event name must be a string.";break;
    case MessageTemplate::kTraceEventNameLengthError:text="Trace event name must not be an empty string.";break;
    case MessageTemplate::kTraceEventPhaseError:text="Trace event phase must be a number.";break;
    case MessageTemplate::kTraceEventIDError:text="Trace event id must be a number.";break;
  }
  return Exception::TypeError(String::NewFromUtf8(isolate,text).ToLocalChecked());
}
inline TracingController* Controller(){
  auto* platform=V8::GetCurrentPlatform();CHECK(platform);auto* controller=platform->GetTracingController();CHECK(controller);return controller;
}
namespace tracing {
inline constexpr const char* kGlobalScope="g";
inline constexpr uint64_t kNoId=0;
inline void SetTraceValue(std::unique_ptr<ConvertableToTraceFormat> value,uint8_t* type,uint64_t* bits){
  *type=8;*bits=uint64_t(reinterpret_cast<uintptr_t>(value.release()));
}
}
inline void AddEvent(char phase,const uint8_t* enabled,const char* name,const char* scope,
    uint64_t id,uint64_t bind,int32_t count,const char** names,const uint8_t* types,
    const uint64_t* values,unsigned flags){
  CHECK(count==0||count==1);std::unique_ptr<ConvertableToTraceFormat> converted;
  if(count){CHECK(*types==8);converted.reset(reinterpret_cast<ConvertableToTraceFormat*>(uintptr_t(*values)));}
  Controller()->AddTraceEvent(phase,enabled,name,scope,id,bind,count,names,types,values,&converted,flags);
}
}
#pragma push_macro("BUILTIN")
#pragma push_macro("THROW_NEW_ERROR_RETURN_FAILURE")
#pragma push_macro("ASSIGN_RETURN_FAILURE_ON_EXCEPTION")
#pragma push_macro("TRACE_EVENT_API_GET_CATEGORY_GROUP_ENABLED")
#pragma push_macro("TRACE_EVENT_API_ADD_TRACE_EVENT")
#pragma push_macro("TRACE_EVENT_FLAG_COPY")
#pragma push_macro("TRACE_EVENT_FLAG_HAS_ID")
#undef BUILTIN
#undef THROW_NEW_ERROR_RETURN_FAILURE
#undef ASSIGN_RETURN_FAILURE_ON_EXCEPTION
#undef TRACE_EVENT_API_GET_CATEGORY_GROUP_ENABLED
#undef TRACE_EVENT_API_ADD_TRACE_EVENT
#undef TRACE_EVENT_FLAG_COPY
#undef TRACE_EVENT_FLAG_HAS_ID
#define BUILTIN(name) Local<Value> NativeBuiltin##name(Isolate* isolate,NativeBuiltinArguments args)
#define THROW_NEW_ERROR_RETURN_FAILURE(isolate,expression) do{(isolate)->ThrowException(expression);return {};}while(false)
#define ASSIGN_RETURN_FAILURE_ON_EXCEPTION(isolate,target,expression) do{if(!(expression).ToLocal(&(target)))return {};}while(false)
#define NATIVE_TRACE_TYPE_ERROR(isolate,message) NativeTypeError(isolate,message)
#define NATIVE_TRACE_NUMBER_VALUE(value) Cast<Number>(value)->Value()
#define NATIVE_TRACE_STRING_LENGTH(value) (value)->Length()
#define TRACE_EVENT_API_GET_CATEGORY_GROUP_ENABLED(name) Controller()->GetCategoryGroupEnabled(name)
#define TRACE_EVENT_API_ADD_TRACE_EVENT(...) AddEvent(__VA_ARGS__)
#define TRACE_EVENT_FLAG_COPY (static_cast<unsigned int>(1<<0))
#define TRACE_EVENT_FLAG_HAS_ID (static_cast<unsigned int>(1<<1))
