#ifndef KANDELO_NODE_MESSAGE_CODECS_INL_H
#define KANDELO_NODE_MESSAGE_CODECS_INL_H
#include "kandelo-node/stack-codecs-inl.h"
#include "frontend/TokenKind.h"
#include "js/friend/ErrorMessages.h"
namespace v8 {
namespace {
enum NativeMessageSlot { MessageText,MessageResource,MessageOriginResource,
  MessageSourceLine,MessageSourceMap,MessageLine,MessageColumn,MessageOriginLine,
  MessageOriginColumn,MessageOriginKnown,MessageStack,MessageLevel,MessageEndColumn,MessageOriginFlags,
  MessageDiagnosticCode,MessageDiagnosticName,MessageDiagnosticOrigin,
  MessageDiagnosticActual,MessageDiagnosticExpected,MessageDiagnosticFlags,
  MessageDiagnosticWord,MessageDiagnosticIdentifier,MessageSlots };
const JSClass nativeMessageClass={"NativeMessage",JSCLASS_HAS_RESERVED_SLOTS(MessageSlots)};
JSObject* MessageRecord(Frame& frame,const Data& value){
  auto* object=UnwrapObject(frame.cx,value.cell().value);
  CHECK(object&&JS::GetClass(object)==&nativeMessageClass);return object;
}
JSString* NativeSourceLine(JSContext* cx,js::ScriptSource* source,uint32_t line){
  if(line<source->startLine())return nullptr;
  mozilla::Maybe<js::ScriptSource::DataReader> reader;bool loaded;
  if(!source->tryLoadSource(cx,reader,&loaded)||!loaded)return nullptr;
  // The reader keeps length and text consistent while compression can run.
  JS::RootedString text(cx,(*reader)->substring(cx,0,(*reader)->length()));if(!text)return nullptr;
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
// A failed parse has no compiled script. Keep its supplied origin on an
// ephemeron keyed by the actual SyntaxError, without retaining the error or
// an application realm after the caller releases it.
enum CompilationOriginSlot {CompilationText,CompilationResource,CompilationMap,
  CompilationLine,CompilationColumn,CompilationFlags,CompilationFunctionBody,CompilationSlots};
const JSClass compilationOriginClass={"NodeCompilationOrigin",JSCLASS_HAS_RESERVED_SLOTS(CompilationSlots)};
void RecordNativeCompilationFailure(Frame& frame,const ScriptCompiler::Source& source,bool functionBody=false){
  auto* cx=frame.cx;
  if(!JS_IsExceptionPending(cx)||cx->isNativeExecutionTerminating()||
      cx->exceptionStatus()==JS::ExceptionStatus::OutOfMemory)return;
  JS::ExceptionStack pending(cx);if(!JS::GetPendingExceptionStack(cx,&pending))return;
  JS::RootedObject error(cx,pending.exception().isObject()?UnwrapObject(cx,pending.exception()):nullptr);
  if(!error||!error->is<js::ErrorObject>()||error->as<js::ErrorObject>().type()!=JSEXN_SYNTAXERR)return;
  JS::AutoSaveExceptionState saved(cx);
  JS::RootedObject global(cx,NativeTemplateRealm(frame));if(!global)return;
  JSAutoRealm home(cx,global);
  try {
    if(!frame.state->compilationOrigins){
      JS::RootedObject map(cx,JS::NewWeakMapObject(cx));if(!map)return;
      frame.state->compilationOrigins=std::make_unique<JS::PersistentRootedObject>(cx,map);
    }
    JS::RootedObject record(cx,JS_NewObjectWithGivenProto(cx,&compilationOriginClass,nullptr));if(!record)return;
    JS::RootedValue text(cx,Input(source.NativeSourceString()));if(!JS_WrapValue(cx,&text))return;
    JS::SetReservedSlot(record,CompilationText,text);
    const auto& origin=source.NativeOrigin();
    for(auto item:{std::pair{CompilationResource,origin.ResourceName()},std::pair{CompilationMap,origin.SourceMapUrl()}}){
      JS::RootedValue value(cx,item.second.IsEmpty()?JS::UndefinedValue():Input(item.second));
      if(!JS_WrapValue(cx,&value))return;JS::SetReservedSlot(record,item.first,value);
    }
    JS::SetReservedSlot(record,CompilationLine,JS::Int32Value(origin.LineOffset()));
    JS::SetReservedSlot(record,CompilationColumn,JS::Int32Value(origin.ColumnOffset()));
    JS::SetReservedSlot(record,CompilationFlags,JS::Int32Value(origin.Options().Flags()));
    JS::SetReservedSlot(record,CompilationFunctionBody,JS::BooleanValue(functionBody));
    JS::RootedObject map(cx,frame.state->compilationOrigins->get());
    JS::RootedValue key(cx,JS::ObjectValue(*error)),value(cx,JS::ObjectValue(*record));
    if(!JS_WrapValue(cx,&key)||!JS::SetWeakMapEntry(cx,map,key,value))return;
    // AutoSaveExceptionState restores the exact original value/stack/status.
    // A new allocation/wrapping failure remains the real pending failure.
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(cx);}
}
bool ReadNativeCompilationOrigin(Frame& frame,JS::HandleObject error,JS::MutableHandleObject output){
  output.set(nullptr);if(!error||!frame.state->compilationOrigins)return true;
  JS::RootedObject map(frame.cx,frame.state->compilationOrigins->get());
  JSAutoRealm home(frame.cx,map);
  JS::RootedValue key(frame.cx,JS::ObjectValue(*error)),value(frame.cx);
  if(!JS_WrapValue(frame.cx,&key)||!JS::GetWeakMapEntry(frame.cx,map,key,&value))return false;
  if(value.isUndefined())return true;
  CHECK(value.isObject()&&JS::GetClass(&value.toObject())==&compilationOriginClass);
  output.set(&value.toObject());return true;
}
Local<Message> NativeMessage(Isolate* isolate,Local<Value> exception,JS::HandleObject captured,bool atThrow){
  auto& frame=Current(isolate);auto* cx=frame.cx;JS::RootedValue value(cx,Input(exception));
  JS::RootedObject error(cx,value.isObject()?UnwrapObject(cx,value):nullptr);
  const bool nativeError=error&&error->is<js::ErrorObject>();
  JS::RootedObject compilationOrigin(cx);
  if(!ReadNativeCompilationOrigin(frame,error,&compilationOrigin))return {};
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
  // Copy native report facts while the real report builder owns them. The
  // existing private message record roots their strings through reentry/GC.
  JS::SetReservedSlot(record,MessageDiagnosticCode,JS::DoubleValue(report->errorNumber));
  const auto& diagnostic=report->parserDiagnostic;
  JS::SetReservedSlot(record,MessageDiagnosticOrigin,JS::Int32Value(int(diagnostic.origin)));
  JS::SetReservedSlot(record,MessageDiagnosticActual,JS::Int32Value(diagnostic.actualToken));
  JS::SetReservedSlot(record,MessageDiagnosticExpected,JS::Int32Value(diagnostic.expectedToken));
  JS::SetReservedSlot(record,MessageDiagnosticFlags,JS::Int32Value(
      (diagnostic.escaped?1:0)|(diagnostic.inModule?2:0)|(diagnostic.callSyntaxAllowed?4:0)));
  for(auto item:{std::pair{MessageDiagnosticName,report->errorMessageName},
      std::pair{MessageDiagnosticWord,diagnostic.word},
      std::pair{MessageDiagnosticIdentifier,diagnostic.identifier}}){
    if(!item.second)continue;
    JS::RootedString string(cx,JS_NewStringCopyUTF8Z(cx,JS::ConstUTF8CharsZ(item.second,std::strlen(item.second))));
    if(!string)return {};JS::SetReservedSlot(record,item.first,JS::StringValue(string));
  }
  uint32_t line=report->lineno,column=report->column.oneOriginValue();
  if(column)--column;
  js::ScriptSource* source=nullptr;
  if(!location&&report->filename){
    JS::RootedString name(cx,JS_NewStringCopyUTF8Z(cx,report->filename));if(!name)return {};
    JS::SetReservedSlot(record,MessageResource,JS::StringValue(name));
  }
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
  // Preserve actual report/source facts. A native error can have no source
  // line; V8 GetSourceLine returns its empty string for that precise case.
  if(sourceLine)JS::SetReservedSlot(record,MessageSourceLine,JS::StringValue(sourceLine));
  uint32_t mappedColumn=column+1;
  kandelo::node::NativeFunctionBodyLocation(source,&line,&mappedColumn);
  if(!source&&compilationOrigin&&JS::GetReservedSlot(compilationOrigin,CompilationFunctionBody).toBoolean()){
    const uint32_t first=uint32_t(JS::GetReservedSlot(compilationOrigin,CompilationLine).toInt32())+1;
    if(line>first){if(line==first+1)mappedColumn+=uint32_t(JS::GetReservedSlot(compilationOrigin,CompilationColumn).toInt32());--line;}
  }
  column=mappedColumn-1;
  JS::SetReservedSlot(record,MessageLine,JS::Int32Value(NativeStackNumber(line)));
  JS::SetReservedSlot(record,MessageColumn,JS::Int32Value(NativeStackNumber(column)));
  JS::SetReservedSlot(record,MessageOriginKnown,JS::BooleanValue(true));
  JS::SetReservedSlot(record,MessageOriginLine,JS::Int32Value(0));
  JS::SetReservedSlot(record,MessageOriginColumn,JS::Int32Value(0));
  if(source){
    CHECK_GE(source->startLine(),1U);
    JS::SetReservedSlot(record,MessageOriginLine,JS::Int32Value(NativeStackNumber(source->startLine()-1)));
    JS::SetReservedSlot(record,MessageOriginColumn,JS::Int32Value(NativeStackNumber(source->startColumn().oneOriginValue()-1)));
    if(source->filename()){JS::RootedString name(cx,JS_NewStringCopyUTF8Z(cx,JS::ConstUTF8CharsZ(source->filename(),std::strlen(source->filename()))));if(!name)return {};JS::SetReservedSlot(record,MessageOriginResource,JS::StringValue(name));}
    if(source->hasSourceMapURL()){JS::RootedString map(cx,JS_NewUCStringCopyZ(cx,source->sourceMapURL()));if(!map)return {};JS::SetReservedSlot(record,MessageSourceMap,JS::StringValue(map));}
  }
  if(compilationOrigin){
    for(auto item:{std::pair{MessageOriginResource,CompilationResource},std::pair{MessageResource,CompilationResource},
        std::pair{MessageSourceMap,CompilationMap}}){
      JS::RootedValue input(cx,JS::GetReservedSlot(compilationOrigin,item.second));
      if(!JS_WrapValue(cx,&input))return {};JS::SetReservedSlot(record,item.first,input);
    }
    JS::SetReservedSlot(record,MessageOriginLine,JS::GetReservedSlot(compilationOrigin,CompilationLine));
    JS::SetReservedSlot(record,MessageOriginColumn,JS::GetReservedSlot(compilationOrigin,CompilationColumn));
    JS::SetReservedSlot(record,MessageOriginFlags,JS::GetReservedSlot(compilationOrigin,CompilationFlags));
    JS::SetReservedSlot(record,MessageOriginKnown,JS::BooleanValue(true));
  }
  JS::RootedObject traceInput(cx,creation?creation:location);
  const int traceLimit=bridge::UncaughtStackFrameLimit(isolate);
  if(traceLimit>=0){
    auto trace=NativeSavedStack(frame,traceInput,traceLimit);if(trace.IsEmpty())return {};
    JS::SetReservedSlot(record,MessageStack,Input(trace));
  }
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
namespace {
bool NativeDiagnosticEquals(Frame& frame,JS::HandleValue value,const char* text){
  if(value.isUndefined())return false;
  CHECK(value.isString());JS::RootedString string(frame.cx,value.toString());
  bool equal;
  if(!JS_StringEqualsAscii(frame.cx,string,text,&equal))
    bridge::FatalOutOfMemory(&frame.state->isolate,"Native parser metadata comparison",false);
  return equal;
}
// Pinned V8 generated keyword lookup's escaped hard/strict token groups.
// This compares native canonical token metadata, never source or error text.
bool NativeEscapedReservedWord(Frame& frame,JS::HandleValue word){
  static constexpr const char* words[]={"break","case","catch","class","const","continue","debugger","default","delete","do","else","enum","export","extends","false","finally","for","function","if","implements","import","in","instanceof","interface","let","new","null","package","private","protected","public","return","static","super","switch","this","throw","true","try","typeof","var","void","while","with"};
  for(const char* candidate:words)if(NativeDiagnosticEquals(frame,word,candidate))return true;
  return false;
}
NativeCompileDiagnosticKind NativeDiagnosticKind(Frame& frame,JS::HandleObject record){
  using Kind=NativeCompileDiagnosticKind;
  using Origin=JS::ParserDiagnostic::Origin;
  const auto code=uint32_t(JS::GetReservedSlot(record,MessageDiagnosticCode).toNumber());
  const auto origin=Origin(JS::GetReservedSlot(record,MessageDiagnosticOrigin).toInt32());
  const auto actual=JS::GetReservedSlot(record,MessageDiagnosticActual).toInt32();
  const auto flags=JS::GetReservedSlot(record,MessageDiagnosticFlags).toInt32();
  switch(code){
    case JSMSG_IMPORT_DECL_AT_TOP_LEVEL:case JSMSG_EXPORT_DECL_AT_TOP_LEVEL:
    case JSMSG_IMPORT_META_OUTSIDE_MODULE:return Kind::DefiniteModuleSyntax;
    case JSMSG_REDECLARED_VAR:
      CHECK(origin==Origin::Redeclaration&&JS::GetReservedSlot(record,MessageDiagnosticIdentifier).isString());
      return Kind::Redeclaration;
    case JSMSG_AWAIT_OUTSIDE_ASYNC:case JSMSG_AWAIT_OUTSIDE_ASYNC_OR_MODULE:
    case JSMSG_FOR_AWAIT_OUTSIDE_ASYNC:case JSMSG_PAREN_AFTER_ARGS:
    // V8 reports an UnexpectedToken for a missing declaration binding.
    case JSMSG_NO_VARIABLE_NAME:
    case JSMSG_BAD_STRICT_ASSIGN:case JSMSG_BAD_STRICT_ASSIGN_ARGUMENTS:
    case JSMSG_BAD_STRICT_ASSIGN_EVAL:case JSMSG_BAD_SUPERPRIVATE:
      return Kind::ConditionalModule;
    // V8 ParseVariableDeclarations reports DeclarationMissingInitializer.
    case JSMSG_BAD_CONST_DECL:case JSMSG_BAD_DESTRUCT_DECL:
      return Kind::UnrelatedSyntax;
    // Scanner errors select Invalid... templates rather than Unexpected...
    case JSMSG_BAD_ESCAPE:case JSMSG_ILLEGAL_CHARACTER:
    case JSMSG_MISSING_PRIVATE_NAME:
    case JSMSG_UNTERMINATED_COMMENT:case JSMSG_UNTERMINATED_REGEXP:
    case JSMSG_EOF_BEFORE_END_OF_LITERAL:case JSMSG_EOL_BEFORE_END_OF_STRING:
      return Kind::UnrelatedSyntax;
    default:break;
  }
  if(origin==Origin::SourceImportWithoutCall&&!(flags&2))return Kind::DefiniteModuleSyntax;
  if(origin==Origin::TokenMismatch){
    // Exact reviewed token-helper counterparts. New engine sites/diagnostics
    // require review and qualification instead of inheriting a broad fallback.
    switch(code){
      case JSMSG_BRACKET_AFTER_LIST:
      case JSMSG_BRACKET_IN_INDEX:
      case JSMSG_BRACKET_OPENED:
      case JSMSG_COLON_AFTER_CASE:
      case JSMSG_COLON_IN_COND:
      case JSMSG_COMP_PROP_UNTERM_EXPR:
      case JSMSG_CURLY_AFTER_CATCH:
      case JSMSG_CURLY_AFTER_FINALLY:
      case JSMSG_CURLY_AFTER_LIST:
      case JSMSG_CURLY_AFTER_TRY:
      case JSMSG_CURLY_BEFORE_CATCH:
      case JSMSG_CURLY_BEFORE_CLASS:
      case JSMSG_CURLY_BEFORE_FINALLY:
      case JSMSG_CURLY_BEFORE_SWITCH:
      case JSMSG_CURLY_BEFORE_TRY:
      case JSMSG_CURLY_OPENED:
      case JSMSG_FOR_AWAIT_OUTSIDE_ASYNC:
      case JSMSG_PAREN_AFTER_ARGS:
      case JSMSG_PAREN_AFTER_CATCH:
      case JSMSG_PAREN_AFTER_COND:
      case JSMSG_PAREN_AFTER_FOR:
      case JSMSG_PAREN_AFTER_FOR_CTRL:
      case JSMSG_PAREN_AFTER_SWITCH:
      case JSMSG_PAREN_AFTER_WITH:
      case JSMSG_PAREN_BEFORE_CATCH:
      case JSMSG_PAREN_BEFORE_COND:
      case JSMSG_PAREN_BEFORE_SWITCH:
      case JSMSG_PAREN_BEFORE_WITH:
      case JSMSG_PAREN_IN_PAREN:
      case JSMSG_SEMI_AFTER_FOR_COND:
      case JSMSG_SEMI_AFTER_FOR_INIT:
      case JSMSG_WHILE_AFTER_DO:
        break;
      default:return Kind::Unclassified;
    }
  }
  if(origin==Origin::TokenMismatch||origin==Origin::UnexpectedToken||origin==Origin::MetaProperty){
    JS::RootedValue word(frame.cx,JS::GetReservedSlot(record,MessageDiagnosticWord));
    if(flags&1){
      CHECK(word.isString());
      if(NativeEscapedReservedWord(frame,word))return Kind::UnrelatedSyntax;
      if(origin==Origin::MetaProperty&&(NativeDiagnosticEquals(frame,word,"meta")||
          NativeDiagnosticEquals(frame,word,"target")))return Kind::UnrelatedSyntax;
    }
    // The earlier immediate export predicate outranks the general Unexpected
    // branch. Ordinary-call missing-argument-parenthesis is handled above.
    if(actual==int(js::frontend::TokenKind::Export)&&!(flags&1))return Kind::DefiniteModuleSyntax;
    return Kind::ConditionalModule;
  }
  // No guessed NoRetry disposition for an unmapped engine failure. The native
  // owner must fail qualification until the actual report/source is reviewed.
  return Kind::Unclassified;
}
}
NativeCompileDiagnostic Message::GetNativeCompileDiagnostic(){
  auto& frame=*Frame::current;JS::RootedObject record(frame.cx,MessageRecord(frame,*this));
  NativeCompileDiagnostic result;result.kind=NativeDiagnosticKind(frame,record);
  result.engineCode=uint32_t(JS::GetReservedSlot(record,MessageDiagnosticCode).toNumber());
  result.origin=uint8_t(JS::GetReservedSlot(record,MessageDiagnosticOrigin).toInt32());
  result.actualToken=uint16_t(JS::GetReservedSlot(record,MessageDiagnosticActual).toInt32());
  result.expectedToken=uint16_t(JS::GetReservedSlot(record,MessageDiagnosticExpected).toInt32());
  auto flags=JS::GetReservedSlot(record,MessageDiagnosticFlags).toInt32();
  result.escaped=flags&1;result.inModule=flags&2;
  for(auto item:{std::pair{MessageDiagnosticName,&result.engineName},
      std::pair{MessageDiagnosticWord,&result.word},std::pair{MessageDiagnosticIdentifier,&result.identifier}}){
    JS::RootedValue value(frame.cx,JS::GetReservedSlot(record,item.first));
    if(!value.isUndefined()){CHECK(value.isString());*item.second=frame.Own<String>(value);}
  }
  return result;
}
Local<Message> Exception::CreateMessage(Isolate* isolate,Local<Value> exception){
  auto& frame=Current(isolate);JS::RootedObject stack(frame.cx);return NativeMessage(isolate,exception,stack,false);
}
Local<v8::Message> TryCatch::Message()const{
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
  auto& frame=*Frame::current;
  auto end=JS::GetReservedSlot(MessageRecord(frame,*this),MessageEndColumn);
  if(end.isInt32())return end.toInt32();
  // SavedFrame/JSErrorReport capture points, not end ranges. Expose the audited
  // interface's no-column sentinel; never invent a source-expression extent.
  return kNoColumnInfo;
}
ScriptOrigin Message::GetScriptOrigin(){auto& f=*Frame::current;JS::RootedValue value(f.cx,cell().value);auto flags=JS::GetReservedSlot(MessageRecord(f,*this),MessageOriginFlags);return ScriptOrigin(f.Own<Message>(value),nullptr,ScriptOriginOptions(flags.isInt32()?flags.toInt32():0));}
MaybeLocal<String> Message::GetSourceLine(Local<Context>){auto& f=*Frame::current;JS::RootedValue v(f.cx,JS::GetReservedSlot(MessageRecord(f,*this),MessageSourceLine));if(v.isUndefined())return String::Empty(&f.state->isolate);return f.Own<String>(v);}
Local<StackTrace> Message::GetStackTrace(){auto& f=*Frame::current;JS::RootedValue v(f.cx,JS::GetReservedSlot(MessageRecord(f,*this),MessageStack));if(v.isUndefined())return {};return f.Own<StackTrace>(v);}
int Message::ErrorLevel(){auto& f=*Frame::current;return JS::GetReservedSlot(MessageRecord(f,*this),MessageLevel).toInt32();}
Local<Value> ScriptOrigin::ResourceName()const{if(message_.IsEmpty())return resource_;(void)MessageOriginRecord(message_);return MessageValue(message_,MessageOriginResource);}
Local<Value> ScriptOrigin::SourceMapUrl()const{if(message_.IsEmpty())return sourceMap_;(void)MessageOriginRecord(message_);return MessageValue(message_,MessageSourceMap);}
int ScriptOrigin::LineOffset()const{if(message_.IsEmpty())return line_;return JS::GetReservedSlot(MessageOriginRecord(message_),MessageOriginLine).toInt32();}
int ScriptOrigin::ColumnOffset()const{if(message_.IsEmpty())return column_;return JS::GetReservedSlot(MessageOriginRecord(message_),MessageOriginColumn).toInt32();}
}
#endif
