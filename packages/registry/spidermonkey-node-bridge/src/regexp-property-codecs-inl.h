#ifndef KANDELO_NODE_REGEXP_PROPERTY_CODECS_INL_H
#define KANDELO_NODE_REGEXP_PROPERTY_CODECS_INL_H

#include "builtin/RegExp.h"
#include "vm/RegExpObject.h"

namespace v8 {
namespace {
constexpr std::pair<RegExp::Flags,uint8_t> regexpFlags[] = {
  {RegExp::kGlobal,JS::RegExpFlag::Global},
  {RegExp::kIgnoreCase,JS::RegExpFlag::IgnoreCase},
  {RegExp::kMultiline,JS::RegExpFlag::Multiline},
  {RegExp::kSticky,JS::RegExpFlag::Sticky},
  {RegExp::kUnicode,JS::RegExpFlag::Unicode},
  {RegExp::kDotAll,JS::RegExpFlag::DotAll},
  {RegExp::kHasIndices,JS::RegExpFlag::HasIndices},
  {RegExp::kUnicodeSets,JS::RegExpFlag::UnicodeSets}
};
bool NativeRegExpFlags(Frame& frame,RegExp::Flags input,JS::RegExpFlags* output){
  const unsigned bits=unsigned(input);
  if((bits&~((1u<<RegExp::kFlagCount)-1))||(bits&RegExp::kLinear)||
     ((bits&RegExp::kUnicode)&&(bits&RegExp::kUnicodeSets))){
    auto message=String::NewFromUtf8(&frame.state->isolate,"Invalid regular expression flags").ToLocalChecked();
    frame.state->isolate.ThrowException(Exception::SyntaxError(message));return false;
  }
  uint8_t native=0;for(const auto& flag:regexpFlags)if(bits&flag.first)native|=flag.second;
  *output=JS::RegExpFlags(native);return true;
}
}
MaybeLocal<RegExp> RegExp::New(Local<Context> context,Local<String> pattern,Flags flags){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};Context::Scope home(context);
  JS::RegExpFlags native;if(!NativeRegExpFlags(frame,flags,&native))return {};
  JS::RootedString string(frame.cx,Input(pattern).toString());
  JS::Rooted<JSAtom*> source(frame.cx,js::AtomizeString(frame.cx,string));if(!source)return {};
  JS::RootedObject object(frame.cx,js::RegExpObject::create(frame.cx,source,native,js::GenericObject));if(!object)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<RegExp>(value);
}
MaybeLocal<Object> RegExp::Exec(Local<Context> context,Local<String> subject){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};Context::Scope home(context);
  JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedValue input(frame.cx,Input(subject)),result(frame.cx);
  if(!JS_WrapObject(frame.cx,&object)||!JS_WrapValue(frame.cx,&input))return {};
  JS::RootedString string(frame.cx,input.toString());
  // Like the pinned V8 API, the complete engine RegExpExec operation observes
  // a replaced exec method and preserves its result/failure and lastIndex.
  if(!js::RegExpExec(frame.cx,object,string,false,&result))return {};
  CHECK(result.isNull()||result.isObject());
  return result.isNull()?frame.Own<Object>(result):frame.OwnValue(result).As<Object>();
}
Local<String> RegExp::GetSource()const{
  auto& frame=*Frame::current;NativeNoScriptEntry entry(frame);
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(object&&object->is<js::RegExpObject>());
  JS::RootedValue value(frame.cx);
  {JSAutoRealm home(frame.cx,object);JS::Rooted<JSAtom*> source(frame.cx,object->as<js::RegExpObject>().getSource());
    JS::RootedString escaped(frame.cx,js::EscapeRegExpPattern(frame.cx,source));if(!escaped)return {};value.setString(escaped);}
  if(JS::CurrentGlobalOrNull(frame.cx)&&!JS_WrapValue(frame.cx,&value))return {};
  return frame.Own<String>(value);
}
RegExp::Flags RegExp::GetFlags()const{
  auto& frame=*Frame::current;NativeNoScriptEntry entry(frame);
  auto* object=UnwrapObject(frame.cx,cell().value);CHECK(object&&object->is<js::RegExpObject>());
  const auto native=object->as<js::RegExpObject>().getFlags().value();unsigned flags=0;
  for(const auto& flag:regexpFlags)if(native&flag.second)flags|=flag.first;
  return Flags(flags);
}
void RegExp::CheckCast(Value* value){CHECK(value&&value->IsRegExp());}
MaybeLocal<Array> Array::New(Local<Context> context,size_t length,std::function<MaybeLocal<Value>()> next){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};Context::Scope home(context);
  CHECK(next&&length<=size_t(INT_MAX));JS::RootedValueVector values(frame.cx);
  if(!values.reserve(length))return {};
  for(size_t index=0;index<length;++index){
    if(frame.cx->isNativeExecutionTerminating())return {};
    HandleScope scope(context->isolate);Local<Value> item;
    if(!next().ToLocal(&item)){CHECK(JS_IsExceptionPending(frame.cx)||frame.cx->isNativeExecutionTerminating());return {};}
    if(JS_IsExceptionPending(frame.cx)||frame.cx->isNativeExecutionTerminating())return {};
    JS::RootedValue value(frame.cx,Input(item));if(!JS_WrapValue(frame.cx,&value)||!values.append(value))return {};
  }
  JS::RootedObject object(frame.cx,JS::NewArrayObject(frame.cx,values));if(!object)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<Array>(value);
}
Maybe<void> Array::Iterate(Local<Context> context,IterationCallback callback,void* data){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};Context::Scope home(context);CHECK(callback);
  JS::RootedObject object(frame.cx,&cell().value.toObject());if(!JS_WrapObject(frame.cx,&object))return {};
  uint32_t length;if(!JS::GetArrayLength(frame.cx,object,&length))return {};
  for(uint32_t index=0;index<length;++index){
    if(frame.cx->isNativeExecutionTerminating())return {};
    HandleScope scope(context->isolate);JS::RootedValue value(frame.cx);
    if(!JS_GetElement(frame.cx,object,index,&value))return {};
    const auto result=callback(index,frame.OwnValue(value),data);
    if(result==CallbackResult::kException){CHECK(JS_IsExceptionPending(frame.cx)||frame.cx->isNativeExecutionTerminating());return {};}
    if(JS_IsExceptionPending(frame.cx)||frame.cx->isNativeExecutionTerminating())return {};
    if(result==CallbackResult::kBreak)return JustVoid();CHECK(result==CallbackResult::kContinue);
  }
  return JustVoid();
}
MaybeLocal<Array> Object::GetOwnPropertyNames(Local<Context> context){
  return GetOwnPropertyNames(context,PropertyFilter(ONLY_ENUMERABLE|SKIP_SYMBOLS));
}
MaybeLocal<Array> Object::GetOwnPropertyNames(Local<Context> context,PropertyFilter filter,KeyConversionMode conversion){
  return GetPropertyNames(context,KeyCollectionMode::kOwnOnly,filter,IndexFilter::kIncludeIndices,conversion);
}
MaybeLocal<Array> Object::GetPropertyNames(Local<Context> context){
  return GetPropertyNames(context,KeyCollectionMode::kIncludePrototypes,
      PropertyFilter(ONLY_ENUMERABLE|SKIP_SYMBOLS),IndexFilter::kIncludeIndices);
}
MaybeLocal<Array> Object::GetPropertyNames(Local<Context> context,KeyCollectionMode mode,
    PropertyFilter filter,IndexFilter indices,KeyConversionMode conversion){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};Context::Scope home(context);
  CHECK(!(unsigned(filter)&~31u));
  JS::RootedObject object(frame.cx,&cell().value.toObject());if(!JS_WrapObject(frame.cx,&object))return {};
  JS::RootedObject seen(frame.cx,JS_NewObjectWithGivenProto(frame.cx,nullptr,nullptr));if(!seen)return {};
  JS::RootedValueVector values(frame.cx);unsigned proxies=0;
  while(object){
    if(frame.cx->isNativeExecutionTerminating())return {};
    JS::RootedIdVector keys(frame.cx);
    if(!js::GetPropertyKeys(frame.cx,object,JSITER_OWNONLY|JSITER_HIDDEN|JSITER_SYMBOLS,&keys))return {};
    const bool proxy=js::IsScriptedProxy(object);
    for(size_t index=0;index<keys.length();++index){
      JS::RootedId key(frame.cx,keys[index]);const bool symbol=key.isSymbol();
      if((symbol&&(filter&SKIP_SYMBOLS))||(!symbol&&(filter&SKIP_STRINGS)))continue;
      uint32_t numeric=0;const bool isIndex=key.isInt()?(numeric=uint32_t(key.toInt()),true):
        key.isString()&&key.toString()->asAtom().isIndex(&numeric)&&numeric!=UINT32_MAX;
      // Preserve the pinned proxy-key path: ALL_PROPERTIES bypasses its
      // index filter; other filters honor the explicit index choice.
      if(isIndex&&indices==IndexFilter::kSkipIndices&&!(proxy&&filter==ALL_PROPERTIES))continue;
      bool duplicate=false;if(!JS_HasOwnPropertyById(frame.cx,seen,key,&duplicate))return {};if(duplicate)continue;
      bool include=true;
      // V8's proxy-key filter queries enumerability, while its ordinary
      // descriptor filter also honors writable/configurable flags.
      const unsigned attributes=unsigned(filter)&(proxy?ONLY_ENUMERABLE:7u);
      if(attributes){
        JS::Rooted<mozilla::Maybe<JS::PropertyDescriptor>> descriptor(frame.cx);
        if(!JS_GetOwnPropertyDescriptorById(frame.cx,object,key,&descriptor))return {};
        if(descriptor.isNothing())continue;
        const auto& prop=descriptor.get().ref();
        if((attributes&ONLY_ENUMERABLE)&&!prop.enumerable())include=false;
        if((attributes&ONLY_CONFIGURABLE)&&!prop.configurable())include=false;
        if((attributes&ONLY_WRITABLE)&&prop.isDataDescriptor()&&!prop.writable())include=false;
      }
      // Non-enumerable/non-writable own keys must still shadow a prototype.
      if(!JS_DefinePropertyById(frame.cx,seen,key,JS::TrueHandleValue,0))return {};
      if(!include)continue;
      JS::RootedValue value(frame.cx);
      if(isIndex&&conversion==KeyConversionMode::kKeepNumbers)value.setNumber(double(numeric));
      else {
        CHECK(conversion!=KeyConversionMode::kNoNumbers||!isIndex);
        if(!JS_IdToValue(frame.cx,key,&value))return {};
        if(isIndex&&value.isInt32()){
          JS::RootedString string(frame.cx,JS::ToString(frame.cx,value));if(!string)return {};value.setString(string);
        }
      }
      if(!values.append(value))return {};
    }
    if(mode==KeyCollectionMode::kOwnOnly)break;
    if(proxy&&++proxies>unsigned(kandelo::node::property::ProxyTraversalLimits::kMaxIterationLimit)){
      auto message=String::NewFromUtf8(context->isolate,"Maximum call stack size exceeded").ToLocalChecked();
      context->isolate->ThrowException(Exception::RangeError(message));return {};
    }
    JS::RootedObject prototype(frame.cx);if(!JS_GetPrototype(frame.cx,object,&prototype))return {};object=prototype;
  }
  JS::RootedObject result(frame.cx,JS::NewArrayObject(frame.cx,values));if(!result)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*result));return frame.Own<Array>(value);
}
}
#endif
