#ifndef KANDELO_METADATA_VALUES_CODECS_INL_H
#define KANDELO_METADATA_VALUES_CODECS_INL_H

namespace v8 {
namespace {
JSObject* NativeTemplateRealm(Frame&);
JSObject* NativeExternalObject(const Data& value){
  CHECK(value.cell().context==js::TlsContext.get()&&value.cell().value.isObject());
  JSObject* object=js::UncheckedUnwrapWithoutExpose(&value.cell().value.toObject());
  CHECK(object&&JS::GetClass(object)==&nativeExternalClass);return object;
}
Local<DataView> NewNativeDataView(Local<Value> input,size_t offset,size_t length){
  CHECK(Frame::current);auto& frame=*Frame::current;CheckNativePrimitiveAccess(frame);
  CHECK(!input.IsEmpty()&&input->cell().context==frame.cx&&JS::CurrentGlobalOrNull(frame.cx));
  JS::RootedObject buffer(frame.cx,UnwrapObject(frame.cx,Input(input)));CHECK(buffer);
  const bool shared=JS::IsSharedArrayBufferObject(buffer);
  CHECK(shared||JS::IsArrayBufferObject(buffer));
  CHECK(shared||!JS::IsDetachedArrayBufferObject(buffer));
  const size_t bytes=shared?JS::GetSharedArrayBufferByteLength(buffer):JS::GetArrayBufferByteLength(buffer);
  CHECK(offset<=bytes&&length<=bytes-offset);
  if(!JS_WrapObject(frame.cx,&buffer))return {};
  JS::RootedObject view(frame.cx,JS_NewDataView(frame.cx,buffer,offset,length));if(!view)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*view));return frame.Own<DataView>(value);
}
}
bool Value::IsExternal()const{
  if(!cell().value.isObject())return false;
  CHECK(cell().context==js::TlsContext.get());
  // Type inspection is not access to the payload. It neither exposes a gray
  // target nor invokes a security/proxy hook or changes a pending failure.
  auto* object=js::UncheckedUnwrapWithoutExpose(&cell().value.toObject());
  return JS::GetClass(object)==&nativeExternalClass;
}
bool Value::IsDataView()const{
  if(!cell().value.isObject())return false;
  CHECK(cell().context==js::TlsContext.get());
  auto* object=js::UncheckedUnwrapWithoutExpose(&cell().value.toObject());
  return bool(JS::DataView::fromObject(object));
}
Local<External> External::New(Isolate* isolate,void* pointer,ExternalPointerTypeTag tag){
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);
  CHECK(tag<V8_EXTERNAL_POINTER_TAG_COUNT);
  // Externals are native API carriers, not ordinary JS receivers. Match the
  // upstream empty, non-extensible, context-independent object representation.
  JS::RootedObject global(frame.cx,JS::CurrentGlobalOrNull(frame.cx));
  if(!global)global=NativeTemplateRealm(frame);if(!global)return {};
  JSAutoRealm home(frame.cx,global);
  JS::RootedObject object(frame.cx,JS_NewObjectWithGivenProto(frame.cx,&nativeExternalClass,nullptr));
  if(!object)return {};
  JS::SetReservedSlot(object,0,JS::PrivateValue(pointer));
  JS::SetReservedSlot(object,1,JS::Int32Value(tag));
  JS::ObjectOpResult result;if(!JS_PreventExtensions(frame.cx,object,result))return {};
  CHECK(result.ok());JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<External>(value);
}
void* External::Value(ExternalPointerTypeTag tag)const{
  CHECK(tag<V8_EXTERNAL_POINTER_TAG_COUNT);
  JS::AutoCheckCannotGC noGc;
  JSObject* object=NativeExternalObject(*this);
  CHECK(JS::GetReservedSlot(object,1).toInt32()==tag);
  return JS::GetReservedSlot(object,0).toPrivate();
}
Local<DataView> DataView::New(Local<ArrayBuffer> buffer,size_t offset,size_t length){
  return NewNativeDataView(buffer,offset,length);
}
Local<DataView> DataView::New(Local<SharedArrayBuffer> buffer,size_t offset,size_t length){
  return NewNativeDataView(buffer,offset,length);
}
}
#endif
