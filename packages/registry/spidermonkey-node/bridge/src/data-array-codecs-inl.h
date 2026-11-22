#ifndef KANDELO_DATA_ARRAY_CODECS_INL_H
#define KANDELO_DATA_ARRAY_CODECS_INL_H

// Opaque engine data, not a JavaScript Array exposed to guest code. Each edge
// lives in the engine's dense storage; native metadata retains wrapper factories
// only, never borrowed handles or a second set of persistent GC roots.
namespace v8 {
namespace {
struct NativeDataArrayInfo {
  std::vector<Data::RootFactory> factories;
};
enum NativeDataArraySlot {DataArrayInfo,DataArrayElements,DataArraySlots};
void FinalizeNativeDataArray(JS::GCContext*,JSObject* object){
  const auto info=JS::GetReservedSlot(object,DataArrayInfo);
  if(!info.isUndefined())delete static_cast<NativeDataArrayInfo*>(info.toPrivate());
}
const JSClassOps nativeDataArrayOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeNativeDataArray};
const JSClass nativeDataArrayClass={"NodeEngineDataArray",
  JSCLASS_HAS_RESERVED_SLOTS(DataArraySlots)|JSCLASS_FOREGROUND_FINALIZE,&nativeDataArrayOps};
JSObject* NativeDataArrayRecord(const Data& data){
  CHECK(data.cell().context==js::TlsContext.get()&&data.cell().value.isObject());
  auto* record=js::UncheckedUnwrapWithoutExpose(&data.cell().value.toObject());
  CHECK(JS::GetClass(record)==&nativeDataArrayClass);return record;
}
NativeDataArrayInfo& DataArrayMetadata(JSObject* record){
  return *static_cast<NativeDataArrayInfo*>(JS::GetReservedSlot(record,DataArrayInfo).toPrivate());
}
js::ArrayObject& DataArrayElementsObject(JSObject* record){
  return JS::GetReservedSlot(record,DataArrayElements).toObject().as<js::ArrayObject>();
}
JSObject* NewNativeDataArray(Frame& frame,int length){
  CheckNativePrimitiveAccess(frame);CHECK_GE(length,0);
  JS::RootedObject global(frame.cx,NativeTemplateRealm(frame));if(!global)return nullptr;
  JSAutoRealm home(frame.cx,global);
  try {
    auto metadata=std::make_unique<NativeDataArrayInfo>();
    metadata->factories.resize(size_t(length),&CloneWrapper<Primitive>);
    JS::RootedValueVector values(frame.cx);
    if(!values.resize(size_t(length)))return nullptr;
    for(auto& value:values)value.setUndefined();
    JS::RootedObject elements(frame.cx,JS::NewArrayObject(frame.cx,values));
    if(!elements)return nullptr;
    JS::RootedObject record(frame.cx,JS_NewObjectWithGivenProto(frame.cx,&nativeDataArrayClass,nullptr));
    if(!record)return nullptr;
    JS::SetReservedSlot(record,DataArrayElements,JS::ObjectValue(*elements));
    JS::SetReservedSlot(record,DataArrayInfo,JS::PrivateValue(metadata.release()));
    return record;
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(frame.cx);return nullptr;}
}
bool WriteNativeDataArray(Frame& frame,JS::HandleObject record,int index,Local<Data> input){
  CHECK(!input.IsEmpty()&&input->cell().context==frame.cx);
  CHECK_GE(index,0);auto& metadata=DataArrayMetadata(record);
  CHECK_LT(size_t(index),metadata.factories.size());
  JS::RootedValue value(frame.cx,Input(input));JSAutoRealm home(frame.cx,record);
  if(!JS_WrapValue(frame.cx,&value))return false;
  DataArrayElementsObject(record).setDenseElement(uint32_t(index),value);
  metadata.factories[size_t(index)]=input->RootFactoryForStorage();return true;
}
Local<Data> ReadNativeDataArray(const Data& data,int index){
  CHECK(Frame::current);auto& frame=*Frame::current;CheckNativePrimitiveAccess(frame);
  JS::RootedObject record(frame.cx,NativeDataArrayRecord(data));
  CHECK_GE(index,0);const auto& metadata=DataArrayMetadata(record);
  CHECK_LT(size_t(index),metadata.factories.size());
  JS::RootedValue value(frame.cx,DataArrayElementsObject(record).getDenseElement(uint32_t(index)));
  auto root=metadata.factories[size_t(index)](&frame.state->isolate,std::make_unique<Cell>(frame.cx,value));
  auto* output=root.get();frame.roots.push_back(std::move(root));return Local<Data>(output);
}
}
bool Data::IsFixedArray()const{
  if(!cell().value.isObject())return false;
  CHECK(cell().context==js::TlsContext.get());
  auto* record=js::UncheckedUnwrapWithoutExpose(&cell().value.toObject());
  return JS::GetClass(record)==&nativeDataArrayClass;
}
int FixedArray::Length()const{
  JS::AutoCheckCannotGC noGc;
  return int(DataArrayMetadata(NativeDataArrayRecord(*this)).factories.size());
}
Local<Data> FixedArray::Get(int index)const{return ReadNativeDataArray(*this,index);}
Local<PrimitiveArray> PrimitiveArray::New(Isolate* isolate,int length){
  auto& frame=Current(isolate);JS::RootedObject record(frame.cx,NewNativeDataArray(frame,length));
  if(!record)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*record));return frame.Own<PrimitiveArray>(value);
}
int PrimitiveArray::Length()const{
  JS::AutoCheckCannotGC noGc;
  return int(DataArrayMetadata(NativeDataArrayRecord(*this)).factories.size());
}
void PrimitiveArray::Set(Isolate* isolate,int index,Local<Primitive> item){
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);
  CHECK(!item.IsEmpty()&&item->cell().context==frame.cx&&!Input(item).isObject());
  JS::RootedObject record(frame.cx,NativeDataArrayRecord(*this));
  CHECK_GE(index,0);auto& metadata=DataArrayMetadata(record);
  CHECK_LT(size_t(index),metadata.factories.size());
  // Cross-realm strings/symbols are engine primitives. Dense storage and its
  // post-write barrier retain the real value without executing JS setters.
  JS::RootedValue value(frame.cx,Input(item));
  JSAutoRealm home(frame.cx,record);
  CHECK(JS_WrapValue(frame.cx,&value));
  DataArrayElementsObject(record).setDenseElement(uint32_t(index),value);
  metadata.factories[size_t(index)]=item->RootFactoryForStorage();
}
Local<Primitive> PrimitiveArray::Get(Isolate* isolate,int index){
  CHECK(&Current(isolate)==Frame::current);
  return ReadNativeDataArray(*this,index).As<Primitive>();
}
}
#endif
