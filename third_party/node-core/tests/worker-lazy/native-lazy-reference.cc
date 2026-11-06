// Test fixture only: use the actual pinned V8 native lazy DATA API to judge the
// candidate JavaScript consumer over a real native property owner. This is not
// production code, a SpiderMonkey implementation, or guest JSAPI/GC proof.
#include <node.h>
#include <v8.h>
namespace {
using namespace v8;
void Load(Local<Name> key, const PropertyCallbackInfo<Value>& info) {
  Isolate* isolate=info.GetIsolate();
  HandleScope handles(isolate);
  Local<Object> holder=info.HolderV2();
  Local<Context> context;
  if (!holder->GetCreationContext().ToLocal(&context)) return;
  Context::Scope realm(context);
  Local<Array> record=info.Data().As<Array>();
  Local<Value> loader, data;
  if (!record->Get(context,0).ToLocal(&loader) ||
      !record->Get(context,1).ToLocal(&data)) return;
  Local<Value> args[]={data,key}, result;
  if (!loader.As<Function>()->Call(context,holder,2,args).ToLocal(&result)) return;
  info.GetReturnValue().Set(result);
}
void Define(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate=args.GetIsolate();
  Local<Context> context=isolate->GetCurrentContext();
  if(args.Length()!=5 || !args[0]->IsObject() || !args[1]->IsName() ||
     !args[2]->IsFunction() || !args[4]->IsInt32()) {
    isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate,"native reference arguments")));
    return;
  }
  const int mask=args[4].As<Int32>()->Value();
  int attributes=None;
  if(!(mask&1)) attributes|=DontDelete;
  if(!(mask&2)) attributes|=DontEnum;
  if(!(mask&4)) attributes|=ReadOnly;
  Local<Array> record=Array::New(isolate,2);
  if(record->CreateDataProperty(context,0,args[2]).IsNothing() ||
     record->CreateDataProperty(context,1,args[3]).IsNothing()) return;
  auto result=args[0].As<Object>()->SetLazyDataProperty(context,args[1].As<Name>(),
      Load,record,static_cast<PropertyAttribute>(attributes));
  if(result.IsNothing()) return;
}
void Initialize(Local<Object> exports, Local<Value>, void*) {
  NODE_SET_METHOD(exports,"defineNativeLazyDataProperty",Define);
}
NODE_MODULE(NODE_GYP_MODULE_NAME,Initialize)
}  // namespace
