#ifndef KANDELO_NODE_ALIASED_CODECS_INL_H
#define KANDELO_NODE_ALIASED_CODECS_INL_H
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/aliased_buffer-inl.h"
#undef node
#undef v8

// Engine primitives and privileged controls for the complete original
// AliasedBuffer header pair. Allocation, alias, copy and reserve bodies remain
// in those authenticated original headers.
namespace kandelo_node_codec_api {
size_t TypedArray::Length() const {
  auto& frame=*Frame::current;auto* view=UnwrapView(frame.cx,cell().value);CHECK(view&&JS_IsTypedArrayObject(view));return JS_GetTypedArrayLength(view);
}
#define KANDELO_DEFINE_TYPED_ARRAY(Name,Kind) \
Local<Name> Name::New(Local<ArrayBuffer> buffer,size_t offset,size_t length) { \
  auto& frame=*Frame::current;if(JS_IsExceptionPending(frame.cx))return {}; \
  JS::RootedObject backing(frame.cx,&buffer->cell().value.toObject()); \
  JS::RootedObject object(frame.cx,JS_New##Name##WithBuffer(frame.cx,backing,offset,length));if(!object)return {}; \
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<Name>(value); \
}
KANDELO_NATIVE_TYPED_ARRAYS(KANDELO_DEFINE_TYPED_ARRAY)
#undef KANDELO_DEFINE_TYPED_ARRAY
}
namespace kandelo_node_codec_impl {
using namespace api;
template<class T,class V> class OriginalAliasedControl final:public AliasedControl {
  AliasedBufferBase<T,V> buffer_;
 public:
  OriginalAliasedControl(Isolate* isolate,size_t count):buffer_(isolate,count){}
  OriginalAliasedControl(Isolate* isolate,size_t offset,size_t count,const AliasedUint8Array& backing):buffer_(isolate,offset,count,backing){}
  explicit OriginalAliasedControl(const AliasedBufferBase<T,V>& input):buffer_(input){}
  Local<Value> Array(Isolate*)const override{return buffer_.GetJSArray();}
  double Read(size_t index)const override {CHECK_LT(index,buffer_.Length());return double(buffer_.GetValue(index));}
  void Write(size_t index,double value)override {CHECK_LT(index,buffer_.Length());buffer_.SetValue(index,T(value));}
  void Reserve(size_t count)override {buffer_.reserve(count);}
  void Release()override {buffer_.Release();}
  void Weaken()override {buffer_.MakeWeak();}
  std::unique_ptr<AliasedControl> Copy()const override{return std::make_unique<OriginalAliasedControl>(buffer_);}
  const void* Uint8Backing()const override {
    if constexpr(std::is_same_v<T,uint8_t>)return &buffer_;else return nullptr;
  }
};
}
namespace kandelo::node {
namespace {
std::unique_ptr<native::AliasedControl> MakeAliasedControl(const char* name,api::Isolate* isolate,size_t count,const native::AliasedUint8Array* backing=nullptr,size_t offset=0) {
#define MAKE_ORIGINAL_ALIASED(NativeT,V8T) \
  if(!std::strcmp(name,#V8T)){ \
    if(backing)return std::make_unique<native::OriginalAliasedControl<NativeT,api::V8T>>(isolate,offset,count,*backing); \
    return std::make_unique<native::OriginalAliasedControl<NativeT,api::V8T>>(isolate,count); \
  }
  ALIASED_BUFFER_LIST(MAKE_ORIGINAL_ALIASED)
#undef MAKE_ORIGINAL_ALIASED
  return {};
}
bool AliasedControlCall(JSContext* cx,unsigned argc,JS::Value* vp) {
  auto args=JS::CallArgsFromVp(argc,vp);if(!args.get(0).isString()){JS_ReportErrorASCII(cx,"Aliased control requires an operation");return false;}
  JS::RootedString operationString(cx,args[0].toString());auto operation=JS_EncodeStringToUTF8(cx,operationString);if(!operation)return false;
  JS::RootedObject runtime(cx,js::shell::GetShellContext(cx)->upstreamNodeRuntime);auto state=api::Data(cx,runtime);if(!state)return false;
  JS::RootedObject realm(cx,GetRuntimePrincipalRealm(cx,runtime));if(!realm)return false;realm=js::CheckedUnwrapDynamic(realm,cx,false);if(!realm||!CheckRealmLibraryActive(cx,realm))return false;
  api::Frame frame(cx,realm,state,&args,api::Domain::Environment);auto* isolate=&state->isolate;auto& controls=state->aliasedControls;args.rval().setUndefined();
  auto count=[&](unsigned index,uint32_t* output){
    if(!args.get(index).isInt32()||args[index].toInt32()<1||args[index].toInt32()>1048576){JS_ReportErrorASCII(cx,"Aliased count must be in 1..1048576");return false;}
    *output=uint32_t(args[index].toInt32());return true;
  };
  if(!std::strcmp(operation.get(),"create")){
    if(!args.get(1).isString()){JS_ReportErrorASCII(cx,"Aliased creation requires an actual typed-array class name");return false;}
    JS::RootedString nameString(cx,args[1].toString());auto name=JS_EncodeStringToUTF8(cx,nameString);uint32_t size;if(!name||!count(2,&size))return false;
    auto owner=MakeAliasedControl(name.get(),isolate,size);if(!owner){JS_ReportErrorASCII(cx,"Unknown native aliased typed-array class");return false;}
    controls.push_back(std::move(owner));args.rval().setNumber(double(controls.size()-1));return true;
  }
  if(!args.get(1).isInt32()||args[1].toInt32()<0||size_t(args[1].toInt32())>=controls.size()||!controls[size_t(args[1].toInt32())]){JS_ReportErrorASCII(cx,"Invalid native aliased owner");return false;}
  size_t id=size_t(args[1].toInt32());auto* owner=controls[id].get();
  if(!std::strcmp(operation.get(),"destroy")){controls[id].reset();return true;}
  auto value=owner->Array(isolate);
  if(!std::strcmp(operation.get(),"array")){if(!value.IsEmpty())args.rval().set(api::Input(value));return !JS_IsExceptionPending(cx);}
  // The original class requires the caller to retain a JS view before reading
  // its borrowed native pointer. These controls enforce that private contract.
  if(value.IsEmpty()){JS_ReportErrorASCII(cx,"Native aliased view is no longer reachable");return false;}
  if(value.As<api::TypedArray>()->Buffer()->WasDetached()){
    JS_ReportErrorASCII(cx,"Native aliased backing has been detached");return false;
  }
  if(!std::strcmp(operation.get(),"inspect")){
    JS::RootedObject object(cx,JS_NewPlainObject(cx));if(!object)return false;
    JS::RootedObject view(cx,api::UnwrapView(cx,api::Input(value)));
    JS::RootedValue nursery(cx,JS::BooleanValue(js::gc::IsInsideNursery(view)));
    if(!JS_DefineProperty(cx,object,"nursery",nursery,JSPROP_ENUMERATE))return false;
    args.rval().setObject(*object);return true;
  }
  if(!std::strcmp(operation.get(),"weaken")){owner->Weaken();return true;}
  if(!std::strcmp(operation.get(),"release")){owner->Release();return true;}
  if(!std::strcmp(operation.get(),"copy")){
    controls.push_back(owner->Copy());args.rval().setNumber(double(controls.size()-1));return true;
  }
  if(!std::strcmp(operation.get(),"subview")){
    auto* backing=static_cast<const native::AliasedUint8Array*>(owner->Uint8Backing());
    if(!backing||!args.get(2).isString()||!args.get(3).isInt32()||args[3].toInt32()<0){JS_ReportErrorASCII(cx,"Aliased subview requires native Uint8 backing, type, offset and count");return false;}
    JS::RootedString nameString(cx,args[2].toString());auto name=JS_EncodeStringToUTF8(cx,nameString);uint32_t size;if(!name||!count(4,&size))return false;
    auto sub=MakeAliasedControl(name.get(),isolate,size,backing,size_t(args[3].toInt32()));if(!sub){JS_ReportErrorASCII(cx,"Unknown aliased subview class");return false;}
    controls.push_back(std::move(sub));args.rval().setNumber(double(controls.size()-1));return true;
  }
  if(!std::strcmp(operation.get(),"reserve")){
    uint32_t size;if(!count(2,&size))return false;
    CHECK_GE(size,value.As<api::TypedArray>()->Length());owner->Reserve(size);auto array=owner->Array(isolate);args.rval().set(api::Input(array));return true;
  }
  if(!args.get(2).isInt32()||args[2].toInt32()<0||size_t(args[2].toInt32())>=value.As<api::TypedArray>()->Length()){JS_ReportErrorASCII(cx,"Aliased element index out of bounds");return false;}
  size_t index=size_t(args[2].toInt32());
  if(!std::strcmp(operation.get(),"read")){args.rval().setNumber(owner->Read(index));return true;}
  if(!std::strcmp(operation.get(),"write")){
    if(!args.get(3).isNumber()||!std::isfinite(args[3].toNumber())||args[3].toNumber()<0||args[3].toNumber()>100){JS_ReportErrorASCII(cx,"Aliased test write must be a finite number in 0..100");return false;}
    owner->Write(index,args[3].toNumber());return true;
  }
  JS_ReportErrorASCII(cx,"Unknown native aliased operation");return false;
}
}
bool DefineAliasedTestAPI(JSContext* cx,JS::HandleObject api) {
  return JS_DefineFunction(cx,api,"aliased",AliasedControlCall,2,0);
}
}
#endif
