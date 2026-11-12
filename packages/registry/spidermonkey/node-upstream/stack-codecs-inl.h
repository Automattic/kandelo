#ifndef KANDELO_NODE_STACK_CODECS_INL_H
#define KANDELO_NODE_STACK_CODECS_INL_H

// Native stack data comes from the VM's actual captured SavedFrame objects.
namespace kandelo_node_codec_api {
namespace {
JSObject* SavedFrameObject(Frame& frame,const Data& data){
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,data.cell().value));CHECK(object&&object->is<js::SavedFrame>());return object;
}
int NativeStackNumber(uint32_t value){CHECK_LE(value,uint32_t(INT_MAX));return int(value);}
}
const int Message::kNoScriptIdInfo=0;
const int Message::kNoColumnInfo=0;
const int Message::kNoLineNumberInfo=0;
bool Isolate::InContext(){return JS::CurrentGlobalOrNull(Current(this).cx)!=nullptr;}
namespace {
Local<StackTrace> NativeSavedStack(Frame& frame,JS::HandleObject input,int count){
  JS::RootedObject cursor(frame.cx,input);JS::RootedValueVector values(frame.cx);
  while(cursor&&values.length()<size_t(count)){
    cursor=js::CheckedUnwrapDynamic(cursor,frame.cx,false);CHECK(cursor&&cursor->is<js::SavedFrame>());
    auto& saved=cursor->as<js::SavedFrame>();
    // Async ancestry is preserved by the VM, but is not a live synchronous
    // frame. The native current-stack interface stops at that real boundary.
    if(saved.getAsyncCause())break;
    if(!saved.isSelfHosted(frame.cx)){
      JS::RootedValue value(frame.cx,JS::ObjectValue(*cursor));
      if(!JS_WrapValue(frame.cx,&value)||!values.append(value))return {};
    }
    JS::RootedObject parent(frame.cx);
    CHECK(JS::GetSavedFrameParent(frame.cx,nullptr,cursor,&parent)==JS::SavedFrameResult::Ok);cursor=parent;
  }
  JS::RootedObject array(frame.cx,JS::NewArrayObject(frame.cx,JS::HandleValueArray(values)));if(!array)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*array));return frame.Own<StackTrace>(value);
}
}
Local<StackTrace> StackTrace::CurrentStackTrace(Isolate* isolate,int count,StackTraceOptions options){
  auto& frame=Current(isolate);CHECK_GE(count,0);CHECK_EQ(int(options)&~int(kDetailed|kExposeFramesAcrossSecurityOrigins),0);
  JS::RootedObject stack(frame.cx);
  if(count&&!JS::CaptureCurrentStack(frame.cx,&stack,JS::StackCapture(JS::MaxFrames(uint32_t(count)))))return {};
  return NativeSavedStack(frame,stack,count);
}
int StackTrace::GetFrameCount(){
  auto& frame=*Frame::current;JS::RootedObject array(frame.cx,UnwrapObject(frame.cx,cell().value));uint32_t count;
  CHECK(array&&JS::GetArrayLength(frame.cx,array,&count));return NativeStackNumber(count);
}
Local<StackFrame> StackTrace::GetFrame(Isolate* isolate,int index){
  auto& frame=Current(isolate);CHECK_GE(index,0);CHECK_LT(index,GetFrameCount());
  JS::RootedObject array(frame.cx,UnwrapObject(frame.cx,cell().value));JS::RootedValue value(frame.cx);
  CHECK(JS_GetElement(frame.cx,array,uint32_t(index),&value));return frame.Own<StackFrame>(value);
}
Local<String> StackFrame::GetFunctionName(){
  auto& frame=*Frame::current;JS::RootedObject saved(frame.cx,SavedFrameObject(frame,*this));JS::RootedString name(frame.cx);
  CHECK(JS::GetSavedFrameFunctionDisplayName(frame.cx,nullptr,saved,&name)==JS::SavedFrameResult::Ok);
  if(!name)return String::Empty(&frame.state->isolate);JS::RootedValue value(frame.cx,JS::StringValue(name));return frame.Own<String>(value);
}
Local<String> StackFrame::GetScriptName(){
  auto& frame=*Frame::current;JS::RootedObject saved(frame.cx,SavedFrameObject(frame,*this));JS::RootedString name(frame.cx);
  CHECK(JS::GetSavedFrameSource(frame.cx,nullptr,saved,&name)==JS::SavedFrameResult::Ok);CHECK(name);
  JS::RootedValue value(frame.cx,JS::StringValue(name));return frame.Own<String>(value);
}
int StackFrame::GetLineNumber(){
  auto& frame=*Frame::current;JS::RootedObject saved(frame.cx,SavedFrameObject(frame,*this));
  if(saved->as<js::SavedFrame>().isWasm())Crash("Native wasm stack position conversion is not implemented");
  uint32_t line;CHECK(JS::GetSavedFrameLine(frame.cx,nullptr,saved,&line)==JS::SavedFrameResult::Ok);return NativeStackNumber(line);
}
int StackFrame::GetColumn(){
  auto& frame=*Frame::current;JS::RootedObject saved(frame.cx,SavedFrameObject(frame,*this));
  if(saved->as<js::SavedFrame>().isWasm())Crash("Native wasm stack position conversion is not implemented");
  JS::TaggedColumnNumberOneOrigin column;
  CHECK(JS::GetSavedFrameColumn(frame.cx,nullptr,saved,&column)==JS::SavedFrameResult::Ok);return NativeStackNumber(column.oneOriginValue());
}
bool StackFrame::IsEval(){
  auto& frame=*Frame::current;JS::RootedObject saved(frame.cx,SavedFrameObject(frame,*this));
  using Kind=js::SavedFrame::KandeloSourceKind;auto kind=saved->as<js::SavedFrame>().getKandeloSourceKind();
  if(kind==Kind::Unknown)Crash("Native stack source provenance is unavailable for this reconstructed frame");
  return kind==Kind::Eval||kind==Kind::Function;
}
int StackFrame::GetScriptId(){
  auto& frame=*Frame::current;JS::RootedObject saved(frame.cx,SavedFrameObject(frame,*this));uint32_t id;
  CHECK(JS::GetSavedFrameSourceId(frame.cx,nullptr,saved,&id)==JS::SavedFrameResult::Ok);return id?NativeStackNumber(id):Message::kNoScriptIdInfo;
}
}
#endif
