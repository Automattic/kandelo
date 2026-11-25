#ifndef KANDELO_ENGINE_SERIALIZATION_CODECS_INL_H
#define KANDELO_ENGINE_SERIALIZATION_CODECS_INL_H

#include "js/GCHashTable.h"
#include "js/GCVector.h"
#include "js/Stack.h"
#include "js/friend/StackLimits.h"
#include "builtin/BigInt.h"
#include "builtin/DataViewObject.h"
#include "builtin/MapObject.h"
#include "vm/ArrayBufferObject-inl.h"
#include "vm/BooleanObject-inl.h"
#include "vm/NumberObject-inl.h"
#include "vm/StringObject-inl.h"
#include "vm/DateObject.h"
#include "vm/PlainObject.h"

#include "kandelo-node/engine-shared-conveyor-data.h"
namespace v8 {
// Wrapper ownership belongs to the bridge, independent of the eventual
// shared-GC backend. These operations do not create or successfully transfer
// an experimental shared value; ordinary shared buffers have a separate owner.
SharedValueConveyor::SharedValueConveyor(SharedValueConveyor&&) noexcept = default;
SharedValueConveyor::~SharedValueConveyor() = default;
SharedValueConveyor& SharedValueConveyor::operator=(SharedValueConveyor&&) noexcept = default;

// No payload can be created before the deferred backend is selected. The
// move/destruction interface is needed by Node's original transfer containers.
struct CompiledWasmModule::Data {Data()=delete;};
CompiledWasmModule::~CompiledWasmModule()=default;
CompiledWasmModule::CompiledWasmModule(CompiledWasmModule&&)noexcept=default;

namespace serialization {
using Tag=internal::SerializationTag;
using ObjectIds=JS::GCHashMap<JSObject*,uint32_t,js::StableCellHasher<JSObject*>,js::SystemAllocPolicy>;

// Graph traversal follows deps/v8/src/objects/value-serializer.cc. Heap/map
// operations use real SpiderMonkey objects. Persistent roots belong to the
// serializer, not to an API call frame: getters may collect and reenter.
static bool Fail(JSContext* cx,const char* message){
  if(!JS_IsExceptionPending(cx)&&!cx->isNativeExecutionTerminating())JS_ReportErrorASCII(cx,"%s",message);
  return false;
}
static bool WriteString(JSContext* cx,internal::ValueSerializer& wire,JS::HandleString string){
  JS::AutoStableStringChars chars(cx);
  if(!chars.init(cx,string))return false;
  if(chars.isLatin1()){
    wire.WriteTag(Tag::kOneByteString);
    wire.WriteOneByteString({reinterpret_cast<const uint8_t*>(chars.latin1Chars()),string->length()});
  }else{
    size_t bytes=string->length()*sizeof(char16_t);
    size_t varint=1;for(size_t rest=bytes;rest>=128;rest>>=7)++varint;
    if((wire.Size()+1+varint)&1)wire.WriteTag(Tag::kPadding);
    wire.WriteTag(Tag::kTwoByteString);
    wire.WriteTwoByteString({chars.twoByteChars(),string->length()});
  }
  return true;
}
static bool ReadString(JSContext* cx,internal::ValueDeserializer& wire,Tag tag,JS::MutableHandleValue result){
  uint32_t length;const void* bytes;
  if(!wire.ReadUint32(&length)||!wire.ReadRawBytes(length,&bytes))return false;
  JSString* string=nullptr;
  switch(tag){
    case Tag::kOneByteString:string=JS_NewStringCopyN(cx,static_cast<const char*>(bytes),length);break;
    case Tag::kUtf8String:string=JS_NewStringCopyUTF8N(cx,JS::UTF8Chars(static_cast<const char*>(bytes),length));break;
    case Tag::kTwoByteString:{
      if(length%2)return false;
      // External input is not necessarily aligned, even though V8 writers pad.
      std::vector<char16_t> aligned(length/2);if(length)std::memcpy(aligned.data(),bytes,length);
      string=JS_NewUCStringCopyN(cx,aligned.data(),aligned.size());break;
    }
    default:return false;
  }
  if(!string)return false;result.setString(string);return true;
}
static void WriteBigInt(internal::ValueSerializer& wire,JS::Handle<JS::BigInt*> bigint){
  JS::AutoCheckCannotGC nogc;
  auto digits=bigint->digits();
  size_t bytes=digits.size()*sizeof(JS::BigInt::Digit);
  // V8's persisted integer format uses little-endian bytes independent of the
  // engine's digit width. Pad to its 64-bit serialized limb boundary.
  size_t padded=(bytes+7)&~size_t(7);
  wire.WriteUint32(uint32_t(padded<<1)|(bigint->isNegative()?1:0));
  for(size_t i=0;i<padded;++i)wire.WriteByte(i<bytes?uint8_t(digits[i/sizeof(JS::BigInt::Digit)]>>(8*(i%sizeof(JS::BigInt::Digit)))):0);
}
static bool ReadBigInt(JSContext* cx,internal::ValueDeserializer& wire,JS::MutableHandleValue result){
  uint32_t bits;const void* data;if(!wire.ReadUint32(&bits)||!wire.ReadRawBytes(bits>>1,&data))return false;
  const auto* bytes=static_cast<const uint8_t*>(data);size_t length=bits>>1;
  while(length&&!bytes[length-1])--length;
  if(!length){auto* zero=JS::BigInt::zero(cx);if(!zero)return false;result.setBigInt(zero);return true;}
  size_t count=(length+sizeof(JS::BigInt::Digit)-1)/sizeof(JS::BigInt::Digit);
  auto* bigint=JS::BigInt::createUninitialized(cx,count,bits&1);if(!bigint)return false;
  auto digits=bigint->digits();for(size_t i=0;i<count;++i)digits[i]=0;
  for(size_t i=0;i<length;++i)digits[i/sizeof(JS::BigInt::Digit)]|=JS::BigInt::Digit(bytes[i])<<(8*(i%sizeof(JS::BigInt::Digit)));
  result.setBigInt(bigint);return true;
}
struct ViewType {JS::Scalar::Type scalar;internal::ArrayBufferViewTag tag;unsigned bytes;};
constexpr ViewType viewTypes[]={
  {JS::Scalar::Int8,internal::ArrayBufferViewTag::kInt8Array,1},
  {JS::Scalar::Uint8,internal::ArrayBufferViewTag::kUint8Array,1},
  {JS::Scalar::Uint8Clamped,internal::ArrayBufferViewTag::kUint8ClampedArray,1},
  {JS::Scalar::Int16,internal::ArrayBufferViewTag::kInt16Array,2},
  {JS::Scalar::Uint16,internal::ArrayBufferViewTag::kUint16Array,2},
  {JS::Scalar::Int32,internal::ArrayBufferViewTag::kInt32Array,4},
  {JS::Scalar::Uint32,internal::ArrayBufferViewTag::kUint32Array,4},
  {JS::Scalar::Float16,internal::ArrayBufferViewTag::kFloat16Array,2},
  {JS::Scalar::Float32,internal::ArrayBufferViewTag::kFloat32Array,4},
  {JS::Scalar::Float64,internal::ArrayBufferViewTag::kFloat64Array,8},
  {JS::Scalar::BigInt64,internal::ArrayBufferViewTag::kBigInt64Array,8},
  {JS::Scalar::BigUint64,internal::ArrayBufferViewTag::kBigUint64Array,8}
};
struct ErrorType {const char* name;internal::ErrorTag tag;JSExnType type;};
constexpr ErrorType errorTypes[]={
  {"EvalError",internal::ErrorTag::kEvalErrorPrototype,JSEXN_EVALERR},
  {"RangeError",internal::ErrorTag::kRangeErrorPrototype,JSEXN_RANGEERR},
  {"ReferenceError",internal::ErrorTag::kReferenceErrorPrototype,JSEXN_REFERENCEERR},
  {"SyntaxError",internal::ErrorTag::kSyntaxErrorPrototype,JSEXN_SYNTAXERR},
  {"TypeError",internal::ErrorTag::kTypeErrorPrototype,JSEXN_TYPEERR},
  {"URIError",internal::ErrorTag::kUriErrorPrototype,JSEXN_URIERR}
};
}

struct ValueSerializer::PrivateData final:internal::WireAllocationDelegate {
  Isolate* isolate;JSContext* cx;Delegate* delegate;
  JS::PersistentRooted<serialization::ObjectIds> objects,transfers;
  internal::ValueSerializer wire;
  bool customHost=false,treatViews=false;
  PrivateData(Isolate* owner,Delegate* callback):isolate(owner),cx(Current(owner).cx),delegate(callback),
      objects(cx),transfers(cx),wire(callback?this:nullptr){
    if(delegate)customHost=delegate->HasCustomHostObject(isolate);
  }
  void* ReallocateBufferMemory(void* data,size_t size,size_t* actual)override{
    return delegate->ReallocateBufferMemory(data,size,actual);
  }
  void FreeBufferMemory(void* data)override{delegate->FreeBufferMemory(data);}
  bool CloneError(const char* message){
    if(JS_IsExceptionPending(cx)||cx->isNativeExecutionTerminating())return false;
    if(delegate){Local<String> text;if(!String::NewFromUtf8(isolate,message).ToLocal(&text))return false;delegate->ThrowDataCloneError(text);return false;}
    return serialization::Fail(cx,message);
  }
  bool Check(){
    if(JS_IsExceptionPending(cx)||cx->isNativeExecutionTerminating())return false;
    return !wire.Failed()||CloneError("Serialization failed due to an out-of-memory condition");
  }
  bool Host(JS::HandleObject object){
    if(!delegate)return CloneError("Object could not be cloned");
    wire.WriteTag(serialization::Tag::kHostObject);
    JS::RootedValue value(cx,JS::ObjectValue(*object));
    return delegate->WriteHostObject(isolate,Current(isolate).Own<Object>(value)).FromMaybe(false)&&Check();
  }
  bool Properties(JS::HandleObject object,JS::HandleIdVector keys,uint32_t* count,bool skipIndices=false){
    *count=0;
    for(size_t i=0;i<keys.length();++i){
      JS::RootedId key(cx,keys[i]);bool own;
      uint32_t index;if(skipIndices&&(key.isInt()||(key.isString()&&key.toString()->asAtom().isIndex(&index)&&index!=UINT32_MAX)))continue;
      if(!JS_HasOwnPropertyById(cx,object,key,&own))return false;
      if(!own)continue; // A prior getter may have deleted this property.
      JS::RootedValue name(cx),value(cx);
      if(!JS_IdToValue(cx,key,&name)||!JS_GetPropertyById(cx,object,key,&value)||!Write(name)||!Write(value))return false;
      ++*count;
    }
    return Check();
  }
  bool Error(JS::HandleObject object){
    using ErrorTag=internal::ErrorTag;
    JS::Rooted<mozilla::Maybe<JS::PropertyDescriptor>> message(cx),cause(cx);
    if(!JS_GetOwnPropertyDescriptor(cx,object,"message",&message)||!JS_GetOwnPropertyDescriptor(cx,object,"cause",&cause))return false;
    wire.WriteTag(serialization::Tag::kError);
    JS::RootedValue value(cx);if(!JS_GetProperty(cx,object,"name",&value))return false;
    JS::RootedString name(cx,JS::ToString(cx,value));if(!name)return false;
    for(const auto& type:serialization::errorTypes){bool equal;if(!JS_StringEqualsAscii(cx,name,type.name,&equal))return false;
      if(equal){wire.WriteByte(uint8_t(type.tag));break;}}
    if(message.isSome()&&message.get().ref().isDataDescriptor()){
      value=message.get().ref().value();JS::RootedString string(cx,JS::ToString(cx,value));if(!string)return false;
      wire.WriteByte(uint8_t(ErrorTag::kMessage));if(!serialization::WriteString(cx,wire,string))return false;
    }
    if(!JS_GetProperty(cx,object,"stack",&value))return false;
    if(value.isString()){wire.WriteByte(uint8_t(ErrorTag::kStack));JS::RootedString stack(cx,value.toString());if(!serialization::WriteString(cx,wire,stack))return false;}
    // Cause is last because it can reference this Error's already assigned ID.
    if(cause.isSome()&&cause.get().ref().isDataDescriptor()){
      wire.WriteByte(uint8_t(ErrorTag::kCause));value=cause.get().ref().value();if(!Write(value))return false;
    }
    wire.WriteByte(uint8_t(ErrorTag::kEnd));return Check();
  }
  bool Write(JS::HandleValue value){
    using Tag=serialization::Tag;
    js::AutoCheckRecursionLimit recursion(cx);if(!Check()||!recursion.check(cx))return false;
    if(value.isUndefined())wire.WriteTag(Tag::kUndefined);
    else if(value.isNull())wire.WriteTag(Tag::kNull);
    else if(value.isBoolean())wire.WriteTag(value.toBoolean()?Tag::kTrue:Tag::kFalse);
    else if(value.isInt32()){wire.WriteTag(Tag::kInt32);wire.WriteZigZag<int32_t>(value.toInt32());}
    else if(value.isDouble()){wire.WriteTag(Tag::kDouble);wire.WriteDouble(value.toDouble());}
    else if(value.isBigInt()){wire.WriteTag(Tag::kBigInt);JS::Rooted<JS::BigInt*> bigint(cx,value.toBigInt());serialization::WriteBigInt(wire,bigint);}
    else if(value.isString()){JS::RootedString string(cx,value.toString());return serialization::WriteString(cx,wire,string)&&Check();}
    else if(value.isObject()){
      JS::RootedObject object(cx,js::CheckedUnwrapDynamic(&value.toObject(),cx,false));
      if(!object)return CloneError("Object could not be cloned");
      JSAutoRealm home(cx,object);
      auto found=objects.get().lookup(object);
      if(found){wire.WriteTag(Tag::kObjectReference);wire.WriteUint32(found->value());return Check();}
      // Views are preceded by their backing buffer, before assigning a view ID.
      if(JS_IsArrayBufferViewObject(object)&&!treatViews){
        bool shared;JS::RootedObject buffer(cx,JS_GetArrayBufferViewBuffer(cx,object,&shared));if(!buffer)return false;
        JS::RootedValue backing(cx,JS::ObjectValue(*buffer));if(!Write(backing))return false;
        // A shared-buffer delegate can serialize the view reentrantly.
        found=objects.get().lookup(object);
        if(found){wire.WriteTag(Tag::kObjectReference);wire.WriteUint32(found->value());return Check();}
      }
      if(objects.get().count()>=UINT32_MAX)return CloneError("Too many objects to serialize");
      if(!objects.get().putNew(object,uint32_t(objects.get().count()))){JS_ReportOutOfMemory(cx);return false;}
      if(JS::IsCallable(object)||js::IsProxy(object))return CloneError("Object could not be cloned");
      if((object->is<js::PlainObject>()||JS::GetClass(object)->cOps==&nativeWrapperOps||object->is<js::ErrorObject>())&&delegate){
        auto local=Current(isolate).Own<Object>(value);
        auto host=customHost?delegate->IsHostObject(isolate,local):Just(local->InternalFieldCount()!=0);
        if(host.IsNothing()||!Check())return false;if(host.FromJust())return Host(object);
      }
      if(object->is<js::ArrayObject>()){
        uint32_t length;if(!JS::GetArrayLength(cx,object,&length))return false;
        bool dense=object->as<js::ArrayObject>().getDenseInitializedLength()==length;
        if(dense)for(uint32_t i=0;i<length;++i)if(object->as<js::ArrayObject>().getDenseElement(i).isMagic(JS_ELEMENTS_HOLE)){dense=false;break;}
        wire.WriteTag(dense?Tag::kBeginDenseJSArray:Tag::kBeginSparseJSArray);wire.WriteUint32(length);
        if(dense)for(uint32_t i=0;i<length;++i){
          bool own;JS::RootedId id(cx);if(!JS_IndexToId(cx,i,&id)||!JS_HasOwnPropertyById(cx,object,id,&own))return false;
          if(!own){wire.WriteTag(Tag::kTheHole);continue;}
          JS::RootedValue item(cx);if(!JS_GetElement(cx,object,i,&item)||!Write(item))return false;
        }
        JS::RootedIdVector keys(cx);uint32_t count;
        if(!js::GetPropertyKeys(cx,object,JSITER_OWNONLY,&keys)||!Properties(object,keys,&count,dense))return false;
        wire.WriteTag(dense?Tag::kEndDenseJSArray:Tag::kEndSparseJSArray);wire.WriteUint32(count);wire.WriteUint32(length);
      }else if(object->is<js::PlainObject>()||JS::GetClass(object)->cOps==&nativeWrapperOps){
        wire.WriteTag(Tag::kBeginJSObject);JS::RootedIdVector keys(cx);uint32_t count;
        if(!js::GetPropertyKeys(cx,object,JSITER_OWNONLY,&keys)||!Properties(object,keys,&count))return false;
        wire.WriteTag(Tag::kEndJSObject);wire.WriteUint32(count);
      }else if(object->is<js::MapObject>()||object->is<js::SetObject>()){
        const bool map=object->is<js::MapObject>();JS::Rooted<JS::GCVector<JS::Value>> entries(cx,JS::GCVector<JS::Value>(cx));
        if(!(map?object->as<js::MapObject>().getKeysAndValuesInterleaved(&entries):object->as<js::SetObject>().keys(&entries)))return false;
        wire.WriteTag(map?Tag::kBeginJSMap:Tag::kBeginJSSet);
        for(size_t i=0;i<entries.length();++i){JS::RootedValue item(cx,entries[i]);if(!Write(item))return false;}
        wire.WriteTag(map?Tag::kEndJSMap:Tag::kEndJSSet);wire.WriteUint32(entries.length());
      }else if(object->is<js::DateObject>()){
        wire.WriteTag(Tag::kDate);wire.WriteDouble(object->as<js::DateObject>().UTCTime().toNumber());
      }else if(object->is<js::ErrorObject>())return Error(object);
      else if(object->is<js::BooleanObject>())wire.WriteTag(object->as<js::BooleanObject>().unbox()?Tag::kTrueObject:Tag::kFalseObject);
      else if(object->is<js::NumberObject>()){wire.WriteTag(Tag::kNumberObject);wire.WriteDouble(object->as<js::NumberObject>().unbox());}
      else if(object->is<js::StringObject>()){
        wire.WriteTag(Tag::kStringObject);JS::RootedString string(cx,object->as<js::StringObject>().unbox());return serialization::WriteString(cx,wire,string)&&Check();
      }else if(object->is<js::BigIntObject>()){
        wire.WriteTag(Tag::kBigIntObject);JS::Rooted<JS::BigInt*> bigint(cx,object->as<js::BigIntObject>().unbox());serialization::WriteBigInt(wire,bigint);
      }else if(object->is<js::RegExpObject>()){
        wire.WriteTag(Tag::kRegExp);JS::RootedString string(cx,object->as<js::RegExpObject>().getSource());
        if(!serialization::WriteString(cx,wire,string))return false;
        unsigned flags=0;auto native=object->as<js::RegExpObject>().getFlags().value();
        for(const auto& flag:regexpFlags)if(native&flag.second)flags|=flag.first;wire.WriteUint32(flags);
      }else if(JS::IsArrayBufferObject(object)){
        if(JS::IsDetachedArrayBufferObject(object))return CloneError("An ArrayBuffer is detached and could not be cloned");
        auto transfer=transfers.get().lookup(object);
        if(transfer){wire.WriteTag(Tag::kArrayBufferTransfer);wire.WriteUint32(transfer->value());}
        else{
          auto& buffer=object->as<js::ArrayBufferObject>();
          size_t length=JS::GetArrayBufferByteLength(object);if(length>UINT32_MAX)return CloneError("ArrayBuffer is too large to serialize");
          wire.WriteTag(buffer.isResizable()?Tag::kResizableArrayBuffer:buffer.isImmutable()?Tag::kImmutableArrayBuffer:Tag::kArrayBuffer);wire.WriteUint32(length);
          if(buffer.isResizable()){size_t maximum=buffer.as<js::ResizableArrayBufferObject>().maxByteLength();if(maximum>UINT32_MAX)return CloneError("ArrayBuffer is too large to serialize");wire.WriteUint32(maximum);}
          JS::AutoCheckCannotGC nogc;bool shared;
          wire.WriteRawBytes(JS::GetArrayBufferData(object,&shared,nogc),length);
        }
      }else if(JS::IsSharedArrayBufferObject(object)){
        if(!delegate)return CloneError("SharedArrayBuffer could not be cloned");
        auto id=delegate->GetSharedArrayBufferId(isolate,Current(isolate).Own<SharedArrayBuffer>(value));
        if(id.IsNothing()||!Check())return false;wire.WriteTag(Tag::kSharedArrayBuffer);wire.WriteUint32(id.FromJust());
      }else if(JS_IsArrayBufferViewObject(object)){
        if(treatViews)return Host(object);
        auto& view=object->as<js::ArrayBufferViewObject>();
        bool resizable=view.hasResizableBuffer();
        if(view.hasDetachedBuffer()||(resizable&&!view.isSharedMemory()&&view.isOutOfBounds()))
          return CloneError("ArrayBuffer view is detached or out of bounds and could not be cloned");
        auto type=JS_GetArrayBufferViewType(object);auto tag=internal::ArrayBufferViewTag::kDataView;
        for(const auto& entry:serialization::viewTypes)if(entry.scalar==type)tag=entry.tag;
        size_t offset=JS_GetArrayBufferViewByteOffset(object),length=JS_GetArrayBufferViewByteLength(object);
        if(offset>UINT32_MAX||length>UINT32_MAX)return CloneError("ArrayBuffer view is too large to serialize");
        uint32_t flags=(resizable&&view.isAutoLength()?1u:0u)|(resizable&&!view.isSharedMemory()?2u:0u);
        wire.WriteTag(Tag::kArrayBufferView);wire.WriteUint32(uint8_t(tag));wire.WriteUint32(offset);wire.WriteUint32(length);wire.WriteUint32(flags);
      }
      else return CloneError("Object could not be cloned");
    }else return CloneError("Value could not be cloned");
    return Check();
  }
};

struct ValueDeserializer::PrivateData {
  Isolate* isolate;JSContext* cx;Delegate* delegate;bool legacy=false,legacyBroken=false;
  JS::PersistentRooted<JS::GCVector<JS::Value>> objects;
  JS::PersistentRooted<JS::GCHashMap<uint32_t,JSObject*,js::DefaultHasher<uint32_t>,js::SystemAllocPolicy>> transfers,sharedTransfers;
  internal::ValueDeserializer wire;
  static void VersionError(void* data){auto* self=static_cast<PrivateData*>(data);serialization::Fail(self->cx,"Unable to deserialize cloned data due to invalid or unsupported version");}
  PrivateData(Isolate* owner,const uint8_t* data,size_t size,Delegate* callback):
    isolate(owner),cx(Current(owner).cx),delegate(callback),objects(cx,JS::GCVector<JS::Value>(cx)),transfers(cx),sharedTransfers(cx),wire(data,size,VersionError,this){}
  bool Remember(JS::HandleObject object,uint32_t* id=nullptr){
    if(objects.length()>=UINT32_MAX)return false;if(id)*id=objects.length();
    if(!objects.append(JS::ObjectValue(*object))){JS_ReportOutOfMemory(cx);return false;}return true;
  }
  bool Properties(JS::HandleObject object,serialization::Tag end,uint32_t* count){
    *count=0;
    for(;;){
      serialization::Tag next;if(!wire.PeekTag().To(&next))return false;
      if(next==end){wire.ConsumeTag(end);return true;}
      JS::RootedValue key(cx),value(cx);if(!Read(&key)||(!key.isString()&&!key.isInt32()&&!key.isDouble()))return false;
      JS::RootedId id(cx);if(!JS_ValueToId(cx,key,&id))return false;
      bool duplicate;if(!JS_HasOwnPropertyById(cx,object,id,&duplicate)||duplicate||!Read(&value)||
          !JS_DefinePropertyById(cx,object,id,value,JSPROP_ENUMERATE))return false;
      ++*count;
    }
  }
  bool View(JS::MutableHandleValue result){
    using Tag=serialization::Tag;Tag next;
    if(!result.isObject()||(!JS::IsArrayBufferObject(&result.toObject())&&!JS::IsSharedArrayBufferObject(&result.toObject()))||
       !wire.PeekTag().To(&next)||next!=Tag::kArrayBufferView)return true;
    wire.ConsumeTag(next);uint8_t type;uint32_t offset,length,flags=0;
    if(!wire.ReadVarint<uint8_t>().To(&type)||!wire.ReadUint32(&offset)||!wire.ReadUint32(&length)||
       ((wire.GetWireFormatVersion()>=14||legacyBroken)&&!wire.ReadUint32(&flags)))return false;
    JS::RootedObject buffer(cx,&result.toObject()),view(cx);
    JS::RootedObject raw(cx,js::CheckedUnwrapDynamic(buffer,cx,false));if(!raw)return false;
    const bool shared=JS::IsSharedArrayBufferObject(raw);
    const bool resizable=shared?raw->as<js::SharedArrayBufferObject>().isResizable():raw->as<js::ArrayBufferObject>().isResizable();
    const bool tracking=flags&1,backedByRab=flags&2;
    // Preserve upstream's low-bit validation, including its intentional
    // acceptance of unrelated high flag bits in format15.
    if(((tracking||backedByRab)&&!resizable)||(backedByRab&&shared)||(resizable&&!shared&&!backedByRab))return false;
    size_t total=JS::IsArrayBufferObject(buffer)?JS::GetArrayBufferByteLength(buffer):JS::GetSharedArrayBufferByteLength(buffer);
    if(offset>total||length>total-offset)return false;
    auto tag=static_cast<internal::ArrayBufferViewTag>(type);
    if(type==uint32_t(internal::ArrayBufferViewTag::kDataView))
      view=tracking?js::NewDataView(cx,buffer,offset):JS_NewDataView(cx,buffer,offset,length);
    else{
      unsigned size=0;for(const auto& entry:serialization::viewTypes)if(entry.tag==tag)size=entry.bytes;
      if(!size||offset%size||length%size)return false;
      switch(tag){
#define KANDELO_READ_VIEW(Name) case internal::ArrayBufferViewTag::k##Name##Array:view=JS_New##Name##ArrayWithBuffer(cx,buffer,offset,tracking?-1:int64_t(length/size));break;
        KANDELO_READ_VIEW(Int8) KANDELO_READ_VIEW(Uint8) KANDELO_READ_VIEW(Uint8Clamped)
        KANDELO_READ_VIEW(Int16) KANDELO_READ_VIEW(Uint16) KANDELO_READ_VIEW(Int32) KANDELO_READ_VIEW(Uint32)
        KANDELO_READ_VIEW(Float16) KANDELO_READ_VIEW(Float32) KANDELO_READ_VIEW(Float64)
        KANDELO_READ_VIEW(BigInt64) KANDELO_READ_VIEW(BigUint64)
#undef KANDELO_READ_VIEW
        default:return false;
      }
    }
    if(!view||!Remember(view))return false;result.setObject(*view);return true;
  }
  bool Read(JS::MutableHandleValue result){
    using Tag=serialization::Tag;
    js::AutoCheckRecursionLimit recursion(cx);if(!recursion.check(cx))return false;
    Tag tag;if(!wire.ReadTag().To(&tag))return false;
    switch(tag){
      case Tag::kVerifyObjectCount:{uint32_t ignored;return wire.ReadUint32(&ignored)&&Read(result);}
      case Tag::kUndefined:result.setUndefined();return true;
      case Tag::kNull:result.setNull();return true;
      case Tag::kTrue:case Tag::kFalse:result.setBoolean(tag==Tag::kTrue);return true;
      case Tag::kInt32:{int32_t value;if(!wire.ReadZigZag<int32_t>().To(&value))return false;result.setInt32(value);return true;}
      case Tag::kUint32:{uint32_t value;if(!wire.ReadUint32(&value))return false;result.setNumber(value);return true;}
      case Tag::kDouble:{double value;if(!wire.ReadDouble(&value))return false;result.setNumber(value);return true;}
      case Tag::kBigInt:return serialization::ReadBigInt(cx,wire,result);
      case Tag::kUtf8String:case Tag::kOneByteString:case Tag::kTwoByteString:return serialization::ReadString(cx,wire,tag,result);
      case Tag::kObjectReference:{uint32_t id;if(!wire.ReadUint32(&id)||id>=objects.length()||!objects[id].isObject())return false;result.set(objects[id]);return View(result);}
      default:break;
    }
    JS::RootedObject object(cx);
    if(tag==Tag::kBeginJSObject||tag==Tag::kBeginSparseJSArray||tag==Tag::kBeginDenseJSArray){
      const bool array=tag!=Tag::kBeginJSObject;uint32_t length=0;
      if(array&&!wire.ReadUint32(&length))return false;
      if(tag==Tag::kBeginDenseJSArray&&length>wire.Remaining())return false;
      object=array?JS::NewArrayObject(cx,length):JS_NewPlainObject(cx);if(!object||!Remember(object))return false;
      if(tag==Tag::kBeginDenseJSArray){
        if(length>wire.Remaining())return false;
        for(uint32_t i=0;i<length;++i){
          Tag next;if(!wire.PeekTag().To(&next))return false;
          if(next==Tag::kTheHole){wire.ConsumeTag(next);continue;}
          JS::RootedValue item(cx);if(!Read(&item)||!JS_DefineElement(cx,object,i,item,JSPROP_ENUMERATE))return false;
        }
      }
      uint32_t actual,expected,finalLength;
      Tag end=array?(tag==Tag::kBeginDenseJSArray?Tag::kEndDenseJSArray:Tag::kEndSparseJSArray):Tag::kEndJSObject;
      if(!Properties(object,end,&actual)||!wire.ReadUint32(&expected)||actual!=expected||
          (array&&(!wire.ReadUint32(&finalLength)||length!=finalLength)))return false;
    }else if(tag==Tag::kBeginJSMap||tag==Tag::kBeginJSSet){
      const bool map=tag==Tag::kBeginJSMap;object=map?static_cast<JSObject*>(js::MapObject::create(cx)):static_cast<JSObject*>(js::SetObject::create(cx));
      if(!object||!Remember(object))return false;
      Tag end=map?Tag::kEndJSMap:Tag::kEndJSSet;uint32_t count=0,expected;
      for(;;){Tag next;if(!wire.PeekTag().To(&next))return false;if(next==end){wire.ConsumeTag(end);break;}
        JS::RootedValue key(cx),value(cx);if(!Read(&key))return false;++count;
        if(map){if(!Read(&value)||!object->as<js::MapObject>().set(cx,key,value))return false;++count;}
        else if(!object->as<js::SetObject>().add(cx,key))return false;
      }
      if(!wire.ReadUint32(&expected)||expected!=count)return false;
    }else if(tag==Tag::kDate){double number;if(!wire.ReadDouble(&number))return false;object=JS::NewDateObject(cx,JS::TimeClip(number));if(!object||!Remember(object))return false;
    }else if(tag==Tag::kTrueObject||tag==Tag::kFalseObject){object=js::BooleanObject::create(cx,tag==Tag::kTrueObject);if(!object||!Remember(object))return false;
    }else if(tag==Tag::kNumberObject){double number;if(!wire.ReadDouble(&number))return false;object=js::NumberObject::create(cx,number);if(!object||!Remember(object))return false;
    }else if(tag==Tag::kBigIntObject){JS::RootedValue value(cx);if(!serialization::ReadBigInt(cx,wire,&value))return false;JS::Rooted<JS::BigInt*> bigint(cx,value.toBigInt());object=js::BigIntObject::create(cx,bigint);if(!object||!Remember(object))return false;
    }else if(tag==Tag::kStringObject||tag==Tag::kRegExp){
      JS::RootedValue value(cx);if(!Read(&value)||!value.isString())return false;JS::RootedString string(cx,value.toString());
      if(tag==Tag::kStringObject)object=js::StringObject::create(cx,string);
      else{
        uint32_t flags;if(!wire.ReadUint32(&flags))return false;JS::RegExpFlags native;
        if(!NativeRegExpFlags(Current(isolate),RegExp::Flags(flags),&native))return false;
        JS::Rooted<JSAtom*> source(cx,js::AtomizeString(cx,string));if(!source)return false;object=js::RegExpObject::create(cx,source,native,js::GenericObject);
      }
      if(!object||!Remember(object))return false;
    }else if(tag==Tag::kError){
      // Reserve the receiver ID before reading fields, as the original reader
      // does. A host delegate reached by malformed data can read nested values.
      uint32_t id=objects.length();if(!objects.append(JS::UndefinedValue())){JS_ReportOutOfMemory(cx);return false;}
      using ErrorTag=internal::ErrorTag;uint8_t next;if(!wire.ReadVarint<uint8_t>().To(&next))return false;
      JSExnType type=JSEXN_ERR;for(const auto& entry:serialization::errorTypes)if(next==uint8_t(entry.tag)){type=entry.type;if(!wire.ReadVarint<uint8_t>().To(&next))return false;break;}
      JS::RootedString message(cx),filename(cx,JS_GetEmptyString(cx));JS::RootedValue stack(cx);
      if(next==uint8_t(ErrorTag::kMessage)){JS::RootedValue value(cx);if(!Read(&value)||!value.isString())return false;message=value.toString();if(!wire.ReadVarint<uint8_t>().To(&next))return false;}
      if(next==uint8_t(ErrorTag::kStack)){if(!Read(&stack)||!stack.isString()||!wire.ReadVarint<uint8_t>().To(&next))return false;}
      JS::RootedObject emptyStack(cx);JS::Rooted<mozilla::Maybe<JS::Value>> cause(cx,mozilla::Nothing());JS::RootedValue value(cx);
      if(!JS::CreateError(cx,type,emptyStack,filename,0,JS::ColumnNumberOneOrigin(1),nullptr,message,cause,&value))return false;
      object=&value.toObject();if(!JS_DefineProperty(cx,object,"stack",stack,0))return false;objects[id].setObject(*object);
      if(next==uint8_t(ErrorTag::kCause)){if(!Read(&value)||!JS_DefineProperty(cx,object,"cause",value,0)||!wire.ReadVarint<uint8_t>().To(&next))return false;}
      if(next!=uint8_t(ErrorTag::kEnd))return false;
    }else if(tag==Tag::kArrayBuffer||tag==Tag::kResizableArrayBuffer||tag==Tag::kImmutableArrayBuffer){
      uint32_t length,maximum=0;const void* bytes;if(!wire.ReadUint32(&length)||
          (tag==Tag::kResizableArrayBuffer&&(!wire.ReadUint32(&maximum)||length>maximum))||!wire.ReadRawBytes(length,&bytes))return false;
      object=tag==Tag::kResizableArrayBuffer?static_cast<JSObject*>(js::ResizableArrayBufferObject::createZeroed(cx,length,maximum)):
        tag==Tag::kImmutableArrayBuffer?static_cast<JSObject*>(js::ImmutableArrayBufferObject::createZeroed(cx,length)):JS::NewArrayBuffer(cx,length);if(!object)return false;
      {JS::AutoCheckCannotGC nogc;bool shared;if(length)std::memcpy(JS::GetArrayBufferData(object,&shared,nogc),bytes,length);}
      if(!Remember(object))return false;
    }else if(tag==Tag::kArrayBufferTransfer||tag==Tag::kSharedArrayBuffer){
      uint32_t id;if(!wire.ReadUint32(&id))return false;
      auto found=(tag==Tag::kArrayBufferTransfer?transfers.get():sharedTransfers.get()).lookup(id);
      if(found)object=found->value();
      else if(tag==Tag::kSharedArrayBuffer&&delegate){Local<SharedArrayBuffer> local;if(!delegate->GetSharedArrayBufferFromId(isolate,id).ToLocal(&local)||JS_IsExceptionPending(cx)||cx->isNativeExecutionTerminating())return false;object=&Input(local).toObject();}
      if(!object||!JS_WrapObject(cx,&object)||!Remember(object))return false;
    }else if(tag==Tag::kHostObject&&delegate){
      // Reserve identity before the delegate, which may deserialize nested data.
      uint32_t id=objects.length();if(!objects.append(JS::UndefinedValue())){JS_ReportOutOfMemory(cx);return false;}
      Local<Object> local;if(!delegate->ReadHostObject(isolate).ToLocal(&local)||JS_IsExceptionPending(cx)||cx->isNativeExecutionTerminating())return false;object=&Input(local).toObject();if(!JS_WrapObject(cx,&object))return false;objects[id].setObject(*object);
    }else return false;
    result.setObject(*object);return View(result);
  }
};

bool ValueSerializer::Delegate::HasCustomHostObject(Isolate*){return false;}
Maybe<bool> ValueSerializer::Delegate::IsHostObject(Isolate*,Local<Object> object){return Just(object->InternalFieldCount()!=0);}
Maybe<bool> ValueSerializer::Delegate::WriteHostObject(Isolate* isolate,Local<Object>){serialization::Fail(Current(isolate).cx,"Object could not be cloned");return {};}
Maybe<uint32_t> ValueSerializer::Delegate::GetSharedArrayBufferId(Isolate* isolate,Local<SharedArrayBuffer>){serialization::Fail(Current(isolate).cx,"SharedArrayBuffer could not be cloned");return {};}
Maybe<uint32_t> ValueSerializer::Delegate::GetWasmModuleTransferId(Isolate*,Local<WasmModuleObject>){return {};}
bool ValueSerializer::Delegate::AdoptSharedValueConveyor(Isolate* isolate,SharedValueConveyor&&){return serialization::Fail(Current(isolate).cx,"Shared value could not be cloned");}
void* ValueSerializer::Delegate::ReallocateBufferMemory(void* data,size_t size,size_t* actual){*actual=size;return std::realloc(data,size);}
void ValueSerializer::Delegate::FreeBufferMemory(void* data){std::free(data);}
ValueSerializer::ValueSerializer(Isolate* isolate):ValueSerializer(isolate,nullptr){}
ValueSerializer::ValueSerializer(Isolate* isolate,Delegate* delegate):private_(new PrivateData(isolate,delegate)){}
ValueSerializer::~ValueSerializer(){delete private_;}
void ValueSerializer::WriteHeader(){private_->wire.WriteHeader();}
Maybe<bool> ValueSerializer::WriteValue(Local<Context> context,Local<Value> value){
  auto& frame=Current(private_->isolate);NativeEntry entry(frame,context);if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedValue input(frame.cx,Input(value));
  try{if(!JS_WrapValue(frame.cx,&input)||!private_->Write(input))return {};return Just(true);}
  catch(const std::bad_alloc&){JS_ReportOutOfMemory(frame.cx);return {};}
}
std::pair<uint8_t*,size_t> ValueSerializer::Release(){return private_->wire.Release();}
void ValueSerializer::TransferArrayBuffer(uint32_t id,Local<ArrayBuffer> buffer){
  auto& data=*private_;JS::RootedObject object(data.cx,js::CheckedUnwrapDynamic(&Input(buffer).toObject(),data.cx,false));
  if(!object){serialization::Fail(data.cx,"ArrayBuffer could not be transferred");return;}
  CHECK(!data.transfers.get().has(object));if(!data.transfers.get().putNew(object,id))JS_ReportOutOfMemory(data.cx);
}
void ValueSerializer::SetTreatArrayBufferViewsAsHostObjects(bool mode){CHECK(private_->delegate);private_->treatViews=mode;}
void ValueSerializer::WriteUint32(uint32_t value){private_->wire.WriteUint32(value);}
void ValueSerializer::WriteUint64(uint64_t value){private_->wire.WriteUint64(value);}
void ValueSerializer::WriteDouble(double value){private_->wire.WriteDouble(value);}
void ValueSerializer::WriteRawBytes(const void* bytes,size_t size){private_->wire.WriteRawBytes(bytes,size);}
MaybeLocal<Object> ValueDeserializer::Delegate::ReadHostObject(Isolate* isolate){serialization::Fail(Current(isolate).cx,"Unable to deserialize cloned data");return {};}
MaybeLocal<WasmModuleObject> ValueDeserializer::Delegate::GetWasmModuleFromId(Isolate* isolate,uint32_t){serialization::Fail(Current(isolate).cx,"Unable to deserialize cloned data");return {};}
MaybeLocal<SharedArrayBuffer> ValueDeserializer::Delegate::GetSharedArrayBufferFromId(Isolate* isolate,uint32_t){serialization::Fail(Current(isolate).cx,"Unable to deserialize cloned data");return {};}
const SharedValueConveyor* ValueDeserializer::Delegate::GetSharedValueConveyor(Isolate* isolate){serialization::Fail(Current(isolate).cx,"Unable to deserialize cloned data");return nullptr;}
ValueDeserializer::ValueDeserializer(Isolate* isolate,const uint8_t* bytes,size_t size):ValueDeserializer(isolate,bytes,size,nullptr){}
ValueDeserializer::ValueDeserializer(Isolate* isolate,const uint8_t* bytes,size_t size,Delegate* delegate):private_(new PrivateData(isolate,bytes,size,delegate)){}
ValueDeserializer::~ValueDeserializer(){delete private_;}
Maybe<bool> ValueDeserializer::ReadHeader(Local<Context> context){
  auto& frame=Current(private_->isolate);NativeNoScriptEntry entry(frame);Context::Scope home(context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx)||private_->wire.ReadHeader().IsNothing())return {};
  if(GetWireFormatVersion()<13&&!private_->legacy){PrivateData::VersionError(private_);return {};}return Just(true);
}
MaybeLocal<Value> ValueDeserializer::ReadValue(Local<Context> context){
  auto& frame=Current(private_->isolate);NativeEntry entry(frame,context);if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedValue result(frame.cx);
  try{
    size_t original=private_->wire.Position();bool read=private_->Read(&result);
    // Preserve the pinned reader's single format13 compatibility attempt and
    // its retained object-ID state. Existing exceptions/termination forbid it.
    if(!read&&GetWireFormatVersion()==13&&!JS_IsExceptionPending(frame.cx)&&!frame.cx->isNativeExecutionTerminating()){
      private_->legacyBroken=true;private_->wire.Rewind(original);read=private_->Read(&result);
    }
    if(!read||JS_IsExceptionPending(frame.cx)||frame.cx->isNativeExecutionTerminating()){
      serialization::Fail(frame.cx,"Unable to deserialize cloned data");return {};
    }return frame.OwnValue(result);
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(frame.cx);return {};}
}
void ValueDeserializer::TransferArrayBuffer(uint32_t id,Local<ArrayBuffer> buffer){
  if(!private_->transfers.get().put(id,&Input(buffer).toObject()))JS_ReportOutOfMemory(private_->cx);
}
void ValueDeserializer::TransferSharedArrayBuffer(uint32_t id,Local<SharedArrayBuffer> buffer){
  if(!private_->sharedTransfers.get().put(id,&Input(buffer).toObject()))JS_ReportOutOfMemory(private_->cx);
}
void ValueDeserializer::SetSupportsLegacyWireFormat(bool legacy){private_->legacy=legacy;}
uint32_t ValueDeserializer::GetWireFormatVersion()const{return private_->wire.GetWireFormatVersion();}
bool ValueDeserializer::ReadUint32(uint32_t* value){return private_->wire.ReadUint32(value);}
bool ValueDeserializer::ReadUint64(uint64_t* value){return private_->wire.ReadUint64(value);}
bool ValueDeserializer::ReadDouble(double* value){return private_->wire.ReadDouble(value);}
bool ValueDeserializer::ReadRawBytes(size_t size,const void** bytes){return private_->wire.ReadRawBytes(size,bytes);}
}
#endif
