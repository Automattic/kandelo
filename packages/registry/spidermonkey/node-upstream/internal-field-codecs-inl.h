#ifndef KANDELO_NODE_INTERNAL_FIELD_CODECS_INL_H
#define KANDELO_NODE_INTERNAL_FIELD_CODECS_INL_H

namespace kandelo_node_codec_api {
namespace {
extern const JSClass templateInstanceClass;
struct InternalFieldInfo {
  Data::RootFactory factory=nullptr;
  bool isValue=false;
  void* pointer=nullptr;
  EmbedderDataTag tag=EmbedderDataTag::kDefault;
};
void FinalizeInternalField(JS::GCContext*,JSObject* object){
  auto value=JS::GetReservedSlot(object,0);
  if(!value.isUndefined())delete static_cast<InternalFieldInfo*>(value.toPrivate());
}
const JSClassOps internalFieldOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeInternalField};
const JSClass internalFieldClass={"NodeInternalField",JSCLASS_HAS_RESERVED_SLOTS(2)|JSCLASS_FOREGROUND_FINALIZE,&internalFieldOps};
bool HasNativeFieldStorage(JSObject* object){
  auto* clasp=JS::GetClass(object);
  return clasp==&templateInstanceClass||clasp==&native::nativeBindingClass||clasp==&native::nativeChannelClass||clasp==&native::categoryClass||clasp==&native::converterClass;
}
JSObject* NativeFieldStorage(Frame& frame,JS::HandleObject object){
  if(!HasNativeFieldStorage(object))return nullptr;
  auto value=JS::GetReservedSlot(object,NativeInternalFields);
  if(value.isUndefined())return nullptr;
  CHECK(value.isObject()&&value.toObject().is<js::ArrayObject>());return &value.toObject();
}
JSObject* ReadInternalFieldRecord(Frame& frame,JS::HandleObject object,int index){
  JSAutoRealm home(frame.cx,object);
  JS::RootedObject storage(frame.cx,NativeFieldStorage(frame,object));CHECK(storage);
  uint32_t count;CHECK(JS::GetArrayLength(frame.cx,storage,&count));CHECK_GE(index,0);CHECK_LT(uint32_t(index),count);
  JS::RootedValue value(frame.cx);CHECK(JS_GetElement(frame.cx,storage,uint32_t(index),&value));
  // The public API requires a field to be set before its matching getter.
  CHECK(value.isObject()&&JS::GetClass(&value.toObject())==&internalFieldClass);return &value.toObject();
}
void WriteInternalFieldRecord(Frame& frame,JS::HandleObject object,int index,std::unique_ptr<InternalFieldInfo> info,JS::HandleValue input){
  JSAutoRealm home(frame.cx,object);JS::RootedObject storage(frame.cx,NativeFieldStorage(frame,object));CHECK(storage);
  uint32_t count;CHECK(JS::GetArrayLength(frame.cx,storage,&count));CHECK_GE(index,0);CHECK_LT(uint32_t(index),count);
  JS::RootedObject record(frame.cx,JS_NewObjectWithGivenProto(frame.cx,&internalFieldClass,nullptr));CHECK(record);
  JS::RootedValue value(frame.cx,input);CHECK(JS_WrapValue(frame.cx,&value));
  // Only engine slots trace payloads. Native metadata owns no JS root.
  JS::SetReservedSlot(record,1,value);JS::SetReservedSlot(record,0,JS::PrivateValue(info.release()));
  JS::RootedValue stored(frame.cx,JS::ObjectValue(*record));CHECK(JS_SetElement(frame.cx,storage,uint32_t(index),stored));
}
}
bool InitializeNativeInternalFields(Frame& frame,JS::HandleObject object,int count){
  CHECK_GE(count,0);CHECK(HasNativeFieldStorage(object));
  CHECK(JS::GetReservedSlot(object,NativeInternalFields).isUndefined());
  if(!count)return true;
  JSAutoRealm home(frame.cx,object);JS::RootedObject storage(frame.cx,JS::NewArrayObject(frame.cx,uint32_t(count)));
  if(!storage||!JS_SetPrototype(frame.cx,storage,nullptr))return false;
  JS::SetReservedSlot(object,NativeInternalFields,JS::ObjectValue(*storage));return true;
}
int Object::InternalFieldCount()const{
  auto& frame=*Frame::current;JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));if(!object)return 0;
  JS::RootedObject storage(frame.cx,NativeFieldStorage(frame,object));if(!storage)return 0;
  JSAutoRealm home(frame.cx,object);
  uint32_t count;CHECK(JS::GetArrayLength(frame.cx,storage,&count));CHECK_LE(count,uint32_t(INT_MAX));return int(count);
}
Local<Data> Object::GetInternalField(int index){
  auto& frame=*Frame::current;JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(object);
  JS::RootedObject record(frame.cx,ReadInternalFieldRecord(frame,object,index));
  auto* info=static_cast<InternalFieldInfo*>(JS::GetReservedSlot(record,0).toPrivate());CHECK(info->factory);
  JS::RootedValue value(frame.cx,JS::GetReservedSlot(record,1));
  if(info->isValue){if(!JS_WrapValue(frame.cx,&value))return {};}
  else if(value.isObject()){JS::RootedObject data(frame.cx,UnwrapObject(frame.cx,value));if(!data)return {};value.setObject(*data);}
  auto owned=info->factory(std::make_unique<Cell>(frame.cx,value));auto* pointer=owned.get();frame.roots.push_back(std::move(owned));return Local<Data>(pointer);
}
void Object::SetInternalField(int index,Local<Data> data){
  CHECK(!data.IsEmpty());auto& frame=*Frame::current;JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(object);
  auto info=std::make_unique<InternalFieldInfo>();info->factory=data->RootFactoryForStorage();info->isValue=data->IsValue();
  JS::RootedValue value(frame.cx,Input(data));WriteInternalFieldRecord(frame,object,index,std::move(info),value);
}
void* Object::GetAlignedPointerFromInternalField(int index,EmbedderDataTag tag){
  auto& frame=*Frame::current;JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(object);
  JS::RootedObject record(frame.cx,ReadInternalFieldRecord(frame,object,index));
  auto* info=static_cast<InternalFieldInfo*>(JS::GetReservedSlot(record,0).toPrivate());CHECK(!info->factory&&info->tag==tag);return info->pointer;
}
void Object::SetAlignedPointerInInternalField(int index,void* pointer,EmbedderDataTag tag){
  CHECK(!(reinterpret_cast<uintptr_t>(pointer)&1));auto& frame=*Frame::current;
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(object);
  auto info=std::make_unique<InternalFieldInfo>();info->pointer=pointer;info->tag=tag;
  JS::RootedValue value(frame.cx,JS::UndefinedValue());WriteInternalFieldRecord(frame,object,index,std::move(info),value);
}
}
#endif
