#ifndef KANDELO_NODE_MESSAGE_CODECS_INL_H
#define KANDELO_NODE_MESSAGE_CODECS_INL_H
#include "shell/node-upstream/stack-codecs-inl.h"
namespace kandelo_node_codec_api {
namespace {
enum NativeMessageSlot { MessageText,MessageResource,MessageOriginResource,
  MessageSourceLine,MessageSourceMap,MessageLine,MessageColumn,MessageOriginLine,
  MessageOriginColumn,MessageOriginKnown,MessageStack,MessageLevel,MessageSlots };
const JSClass nativeMessageClass={"NativeMessage",JSCLASS_HAS_RESERVED_SLOTS(MessageSlots)};
JSObject* MessageRecord(Frame& frame,const Data& value){
  auto* object=UnwrapObject(frame.cx,value.cell().value);
  CHECK(object&&JS::GetClass(object)==&nativeMessageClass);return object;
}
JSString* NativeSourceLine(JSContext* cx,js::ScriptSource* source,uint32_t line){
  if(line<source->startLine())return nullptr;
  bool loaded;if(!js::ScriptSource::loadSource(cx,source,&loaded)||!loaded)return nullptr;
  JS::RootedString text(cx,source->substring(cx,0,source->length()));if(!text)return nullptr;
  JS::AutoStableStringChars chars(cx);if(!chars.initTwoByte(cx,text))return nullptr;
  const auto* data=chars.twoByteChars();size_t length=JS_GetStringLength(text),start=0;
  uint32_t remaining=line-source->startLine();
  for(size_t index=0;index<=length;++index){
    const bool end=index==length;
    if(!end&&data[index]!='\n'&&data[index]!='\r'&&data[index]!=0x2028&&data[index]!=0x2029)continue;
    if(!remaining)return JS_NewUCStringCopyN(cx,data+start,index-start);
    if(end)return nullptr;
    if(data[index]=='\r'&&index+1<length&&data[index+1]=='\n')++index;
    --remaining;start=index+1;
  }
  return nullptr;
}
Local<Message> NativeMessage(Isolate* isolate,Local<Value> exception,JS::HandleObject captured,bool atThrow){
  auto& frame=Current(isolate);auto* cx=frame.cx;JS::RootedValue value(cx,Input(exception));
  JS::RootedObject error(cx,value.isObject()?UnwrapObject(cx,value):nullptr);
  const bool nativeError=error&&error->is<js::ErrorObject>();
  JS::RootedObject creation(cx,nativeError?JS::ExceptionStackOrNull(error):nullptr);
  JS::RootedObject location(cx,atThrow?captured:creation);
  // Only CreateMessage's documented fallback captures the current stack.
  // A caught exception without a throw stack must never acquire this caller's location.
  if(!location&&!atThrow&&!JS::CaptureCurrentStack(cx,&location))return {};
  if(location){location=js::CheckedUnwrapDynamic(location,cx,false);CHECK(location&&location->is<js::SavedFrame>());}
  JS::ExceptionStack pending(cx,value,location);JS::ErrorReportBuilder builder(cx);
  if(!builder.init(cx,pending,JS::ErrorReportBuilder::NoSideEffects))return {};
  auto* report=builder.report();CHECK(report);
  JS::RootedString text(cx,report->newMessageString(cx));if(!text)return {};
  JS::RootedObject record(cx,JS_NewObjectWithGivenProto(cx,&nativeMessageClass,nullptr));if(!record)return {};
  JS::SetReservedSlot(record,MessageText,JS::StringValue(text));
  uint32_t line=0,column=0;js::ScriptSource* source=nullptr;
  if(location){
    auto& saved=location->as<js::SavedFrame>();line=saved.getLine();
    if(!saved.getColumn().isLimitedColumnNumber())Crash("Native Wasm message positions are not implemented");
    column=saved.getColumn().oneOriginValue()-1;source=saved.getKandeloScriptSource();
    JS::SetReservedSlot(record,MessageResource,JS::StringValue(saved.getSource()));
  }
  JS::RootedString sourceLine(cx);
  if(report->linebuf()){
    // Compiler diagnostics own their actual source line independently of the caller stack.
    sourceLine=JS_NewUCStringCopyN(cx,report->linebuf(),report->linebufLength());if(!sourceLine)return {};
    line=report->lineno;column=report->column.oneOriginValue();if(column)--column;
    if(!source||source->id()!=report->sourceId)source=nullptr;
    if(report->filename){JS::RootedString name(cx,JS_NewStringCopyUTF8Z(cx,report->filename));if(!name)return {};JS::SetReservedSlot(record,MessageResource,JS::StringValue(name));}
  }else if(source){
    sourceLine=NativeSourceLine(cx,source,line);if(!sourceLine&&JS_IsExceptionPending(cx))return {};
  }
  if(sourceLine)JS::SetReservedSlot(record,MessageSourceLine,JS::StringValue(sourceLine));
  JS::SetReservedSlot(record,MessageLine,JS::Int32Value(NativeStackNumber(line)));
  JS::SetReservedSlot(record,MessageColumn,JS::Int32Value(NativeStackNumber(column)));
  JS::SetReservedSlot(record,MessageOriginKnown,JS::BooleanValue(source!=nullptr));
  if(source){
    CHECK_GE(source->startLine(),1U);
    JS::SetReservedSlot(record,MessageOriginLine,JS::Int32Value(NativeStackNumber(source->startLine()-1)));
    JS::SetReservedSlot(record,MessageOriginColumn,JS::Int32Value(NativeStackNumber(source->startColumn().oneOriginValue()-1)));
    if(source->filename()){JS::RootedString name(cx,JS_NewStringCopyUTF8Z(cx,JS::ConstUTF8CharsZ(source->filename(),std::strlen(source->filename()))));if(!name)return {};JS::SetReservedSlot(record,MessageOriginResource,JS::StringValue(name));}
    if(source->hasSourceMapURL()){JS::RootedString map(cx,JS_NewUCStringCopyZ(cx,source->sourceMapURL()));if(!map)return {};JS::SetReservedSlot(record,MessageSourceMap,JS::StringValue(map));}
  }
  JS::RootedObject traceInput(cx,creation?creation:location);
  auto trace=NativeSavedStack(frame,traceInput,INT_MAX);if(trace.IsEmpty())return {};
  JS::SetReservedSlot(record,MessageStack,Input(trace));
  JS::SetReservedSlot(record,MessageLevel,JS::Int32Value(report->isWarning()?Isolate::kMessageWarning:Isolate::kMessageError));
  JS::RootedValue output(cx,JS::ObjectValue(*record));return frame.Own<Message>(output);
}
Local<Value> MessageValue(Local<Message> message,NativeMessageSlot slot){
  auto& frame=*Frame::current;JS::RootedValue value(frame.cx,JS::GetReservedSlot(MessageRecord(frame,*message.operator->()),slot));return frame.OwnValue(value);
}
JSObject* MessageOriginRecord(Local<Message> message){
  auto& frame=*Frame::current;auto* record=MessageRecord(frame,*message.operator->());
  if(!JS::GetReservedSlot(record,MessageOriginKnown).toBoolean())Crash("Native diagnostic compilation origin is unavailable");
  return record;
}
}
Local<Message> Exception::CreateMessage(Isolate* isolate,Local<Value> exception){
  auto& frame=Current(isolate);JS::RootedObject stack(frame.cx);return NativeMessage(isolate,exception,stack,false);
}
Local<kandelo_node_codec_api::Message> TryCatch::Message()const{
  if(!HasCaught()||scope_->terminated||scope_->status==JS::ExceptionStatus::OutOfMemory)return {};
  auto& frame=Current(&scope_->state.isolate);JS::RootedObject stack(frame.cx,scope_->stack);
  if(stack&&!JS_WrapObject(frame.cx,&stack))return {};
  return NativeMessage(&scope_->state.isolate,Exception(),stack,true);
}
Local<String> Message::Get(){auto& f=*Frame::current;JS::RootedValue v(f.cx,JS::GetReservedSlot(MessageRecord(f,*this),MessageText));return f.Own<String>(v);}
Local<Value> Message::GetScriptResourceName(){auto& f=*Frame::current;JS::RootedValue v(f.cx,JS::GetReservedSlot(MessageRecord(f,*this),MessageResource));return f.OwnValue(v);}
Maybe<int> Message::GetLineNumber(Local<Context>){auto& f=*Frame::current;return Just(JS::GetReservedSlot(MessageRecord(f,*this),MessageLine).toInt32());}
int Message::GetStartColumn(){auto& f=*Frame::current;return JS::GetReservedSlot(MessageRecord(f,*this),MessageColumn).toInt32();}
int Message::GetEndColumn(){
  // SavedFrame/JSErrorReport capture points, not end ranges. Expose the audited
  // interface's no-column sentinel; never invent a source-expression extent.
  return kNoColumnInfo;
}
ScriptOrigin Message::GetScriptOrigin(){auto& f=*Frame::current;JS::RootedValue value(f.cx,cell().value);return ScriptOrigin(f.Own<Message>(value));}
MaybeLocal<String> Message::GetSourceLine(Local<Context>){auto& f=*Frame::current;JS::RootedValue v(f.cx,JS::GetReservedSlot(MessageRecord(f,*this),MessageSourceLine));if(v.isUndefined())return {};return f.Own<String>(v);}
Local<StackTrace> Message::GetStackTrace(){auto& f=*Frame::current;JS::RootedValue v(f.cx,JS::GetReservedSlot(MessageRecord(f,*this),MessageStack));return f.Own<StackTrace>(v);}
int Message::ErrorLevel(){auto& f=*Frame::current;return JS::GetReservedSlot(MessageRecord(f,*this),MessageLevel).toInt32();}
Local<Value> ScriptOrigin::ResourceName(){USE(MessageOriginRecord(message_));return MessageValue(message_,MessageOriginResource);}
Local<Value> ScriptOrigin::SourceMapUrl(){USE(MessageOriginRecord(message_));return MessageValue(message_,MessageSourceMap);}
int ScriptOrigin::LineOffset(){return JS::GetReservedSlot(MessageOriginRecord(message_),MessageOriginLine).toInt32();}
int ScriptOrigin::ColumnOffset(){return JS::GetReservedSlot(MessageOriginRecord(message_),MessageOriginColumn).toInt32();}
}
#endif
