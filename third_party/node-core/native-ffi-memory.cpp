// Real guest address-space consumers. The engine is itself a Wasm program:
// uintptr_t is the actual guest data pointer, never a host JS memory address.
#include "kandelo-node-ffi-memory-owner.h"
#include "kandelo-node-ffi-borrowed-backing.h"
#include "js/ArrayBuffer.h"
#include "js/CharacterEncoding.h"
#include "js/SharedArrayBuffer.h"
#include "jsfriendapi.h"
#include "js/experimental/KandeloBackingStore.h"
#include "js/experimental/TypedData.h"
#include <cmath>
#include <cstring>
#include <limits>
#include <type_traits>
namespace {
namespace Ffi = kandelo::ffi;
static uintptr_t KandeloFfiMemoryPointer(HandleValue value, const char* label) {
  if (!value.isBigInt()) throw Ffi::Error("ERR_INVALID_ARG_TYPE",
      std::string("The ") + label + " must be a bigint");
  uint64_t pointer;
  if (!JS::BigIntFits<uint64_t>(value.toBigInt(), &pointer))
    throw Ffi::Error("ERR_INVALID_ARG_VALUE", std::string("The ") + label + " must be a non-negative bigint");
  if (pointer > std::numeric_limits<uintptr_t>::max())
    throw Ffi::Error("ERR_INVALID_ARG_VALUE", std::string("The ") + label + " exceeds the platform pointer range");
  return uintptr_t(pointer);
}
static size_t KandeloFfiMemorySize(HandleValue value, const char* label) {
  if (!value.isNumber()) throw Ffi::Error("ERR_INVALID_ARG_TYPE",
      std::string("The ") + label + " must be a number");
  return Ffi::MemorySize(value.toNumber(), label);
}
struct KandeloFfiMemoryAccess { uintptr_t pointer; size_t offset; };
static KandeloFfiMemoryAccess KandeloFfiMemoryArguments(const CallArgs& args, bool write) {
  const uintptr_t pointer = KandeloFfiMemoryPointer(args.get(0), "pointer");
  if (!pointer) throw Ffi::Error("ERR_FFI_INVALID_POINTER", "Cannot dereference a null pointer");
  size_t offset = 0;
  if (write && (args.length() < 2 || args[1].isUndefined()))
    throw Ffi::Error("ERR_INVALID_ARG_VALUE", "Expected an offset argument");
  if (!args.get(1).isUndefined()) offset = KandeloFfiMemorySize(args[1], "offset");
  Ffi::MemorySpan(pointer, offset, 1, "The pointer and offset exceed the platform address range");
  if (write && (args.length() < 3 || args[2].isUndefined()))
    throw Ffi::Error("ERR_INVALID_ARG_VALUE", "Expected a value argument");
  return {pointer, offset};
}
template<class T>
static bool KandeloFfiMemoryGet(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  return KandeloFfiTry(cx, [&] {
    auto access = KandeloFfiMemoryArguments(args, false);
    const T value = Ffi::MemoryLoad<T>(access.pointer, access.offset);
    if constexpr (std::is_same_v<T, int64_t> || std::is_same_v<T, uint64_t>) {
      JS::BigInt* integer = JS::NumberToBigInt(cx, value);
      if (!integer) return false;
      args.rval().setBigInt(integer);
    } else args.rval().setNumber(double(value));
    return true;
  });
}
template<class T>
static T KandeloFfiMemoryValue(HandleValue value) {
  constexpr bool big = std::is_same_v<T, int64_t> || std::is_same_v<T, uint64_t>;
  const char* name = std::is_same_v<T, int8_t> ? "int8" : std::is_same_v<T, uint8_t> ? "uint8" :
      std::is_same_v<T, int16_t> ? "int16" : std::is_same_v<T, uint16_t> ? "uint16" :
      std::is_same_v<T, int32_t> ? "int32" : std::is_same_v<T, uint32_t> ? "uint32" :
      std::is_same_v<T, int64_t> ? "int64" : std::is_same_v<T, uint64_t> ? "uint64" :
      std::is_same_v<T, float> ? "float" : "double";
  if constexpr (big) {
    if (value.isBigInt()) {
      T result;
      if (JS::BigIntFits<T>(value.toBigInt(), &result)) return result;
      throw Ffi::Error("ERR_INVALID_ARG_VALUE", std::string("Value must be ") +
          (std::is_signed_v<T> ? "an " : "a ") + name);
    }
    if (!value.isNumber()) throw Ffi::Error("ERR_INVALID_ARG_VALUE", "Value must be a bigint or a number");
  }
  if constexpr (std::is_floating_point_v<T>) {
    if (!value.isNumber()) throw Ffi::Error("ERR_INVALID_ARG_VALUE", std::string("Value must be a ") + name);
    return T(value.toNumber());
  } else if constexpr (std::is_signed_v<T>) {
    if (!value.isNumber()) throw Ffi::Error("ERR_INVALID_ARG_VALUE", std::string("Value must be an ") + name);
    const int64_t maximum = big ? int64_t(Ffi::MaxSafeInteger) : std::numeric_limits<T>::max();
    const int64_t minimum = big ? -int64_t(Ffi::MaxSafeInteger) : std::numeric_limits<T>::min();
    return T(Ffi::MemorySigned(value.toNumber(), minimum, maximum, name));
  } else {
    if (!value.isNumber()) throw Ffi::Error("ERR_INVALID_ARG_VALUE", std::string("Value must be a ") + name);
    const uint64_t maximum = big ? uint64_t(Ffi::MaxSafeInteger) : std::numeric_limits<T>::max();
    return T(Ffi::MemoryUnsigned(value.toNumber(), maximum, name));
  }
}
template<class T>
static bool KandeloFfiMemorySet(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  return KandeloFfiTry(cx, [&] {
    auto access = KandeloFfiMemoryArguments(args, true);
    Ffi::MemorySpan(access.pointer, access.offset, sizeof(T), "The accessed range exceeds the platform address range");
    const T value = KandeloFfiMemoryValue<T>(args[2]);
    Ffi::MemoryStore(access.pointer, access.offset, value);
    args.rval().setUndefined(); return true;
  });
}
static JS::KandeloBacking::MetadataRef KandeloFfiMemoryMetadata(
    size_t bytes, const JS::KandeloBacking::AccountRef& account) {
  auto metadata = JS::KandeloBacking::TrackMetadata(bytes, account);
  if (!metadata) throw Ffi::Error("ERR_FFI_CALL_FAILED", "FFI backing metadata provider is unavailable");
  return metadata;
}
static JS::KandeloBacking::SpanRef KandeloFfiMemorySource(JSContext* cx, HandleValue input, bool raw) {
  constexpr const char* expected = "The first argument must be a Buffer, ArrayBuffer, SharedArrayBuffer, or ArrayBufferView";
  if (!input.isObject()) throw Ffi::Error("ERR_INVALID_ARG_TYPE", expected);
  RootedObject actual(cx, js::CheckedUnwrapDynamic(&input.toObject(), cx));
  if (!actual) { if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx); return {}; }
  const bool view = JS_IsArrayBufferViewObject(actual);
  const bool array = JS::IsArrayBufferObject(actual);
  const bool sharedArray = JS::IsSharedArrayBufferObject(actual);
  if (!view && !array && !sharedArray) throw Ffi::Error("ERR_INVALID_ARG_TYPE", expected);
  RootedObject buffer(cx, actual);
  bool shared = sharedArray;
  if (view) {
    JSAutoRealm realm(cx, actual);
    buffer = JS_GetArrayBufferViewBuffer(cx, actual, &shared);
    if (!buffer) return {};
    buffer = shared ? JS::UnwrapSharedArrayBuffer(buffer) : JS::UnwrapArrayBuffer(buffer);
    if (!buffer) { if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx); return {}; }
  }
  {
    JSAutoRealm realm(cx, buffer);
    if (!shared && JS::IsDetachedArrayBufferObject(buffer))
      throw Ffi::Error("ERR_INVALID_ARG_VALUE", raw && view ?
          "ArrayBufferView is backed by a detached ArrayBuffer" : "ArrayBuffer is detached");
  }
  // Acquire installs the actual backing owner and externalizes inline bytes;
  // it does not pin visible RAB length or retain a pointer solely as a bigint.
  return view ? JS::KandeloBacking::Acquire(cx, actual) : JS::KandeloBacking::AcquireBuffer(cx, actual);
}
static bool KandeloFfiMemoryRawPointer(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  return KandeloFfiTry(cx, [&] {
    auto span = KandeloFfiMemorySource(cx, args.get(0), true);
    if (!span) return false;
    JS::BigInt* pointer = JS::NumberToBigInt(cx, uint64_t(reinterpret_cast<uintptr_t>(span->Data())));
    if (!pointer) return false;
    args.rval().setBigInt(pointer); return true;
  });
}
static bool KandeloFfiMemoryExport(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  return KandeloFfiTry(cx, [&] {
    auto span = KandeloFfiMemorySource(cx, args.get(0), false);
    if (!span) return false;
    const uintptr_t pointer = KandeloFfiMemoryPointer(args.get(1), "pointer");
    const size_t length = KandeloFfiMemorySize(args.get(2), "length");
    if (length < span->Length()) throw Ffi::Error("ERR_OUT_OF_RANGE", "The length must be >= source byte length");
    if (!pointer && span->Length()) throw Ffi::Error("ERR_FFI_INVALID_POINTER", "Cannot create a buffer from a null pointer");
    Ffi::MemorySpan(pointer, 0, length, "The pointer and length exceed the platform address range");
    if (span->Length()) {
      auto* destination = reinterpret_cast<uint8_t*>(pointer);
      if (span->Shared()) {
        for (size_t i = 0; i < span->Length(); ++i)
          destination[i] = __atomic_load_n(span->Data() + i, __ATOMIC_RELAXED);
      } else std::memcpy(destination, span->Data(), span->Length());
    }
    args.rval().setUndefined(); return true;
  });
}
template<bool Buffer>
static bool KandeloFfiMemoryArrayBuffer(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  return KandeloFfiTry(cx, [&] {
    const uintptr_t pointer = KandeloFfiMemoryPointer(args.get(0), "first argument");
    const size_t length = KandeloFfiMemorySize(args.get(1), "length");
    if (!pointer && length) throw Ffi::Error("ERR_FFI_INVALID_POINTER", Buffer ?
        "Cannot create a buffer from a null pointer" : "Cannot create an ArrayBuffer from a null pointer");
    Ffi::MemorySpan(pointer, 0, length, "The pointer and length exceed the platform address range");
    if (length > js::TypedArrayObject::ByteLengthLimit)
      throw Ffi::Error("ERR_BUFFER_TOO_LARGE", "Buffer is too large");
    if (!args.get(2).isUndefined() && !args[2].isBoolean())
      throw Ffi::Error("ERR_INVALID_ARG_TYPE", "The copy argument must be a boolean");
    RootedObject buffer(cx);
    if (!args.get(2).isFalse()) {
      mozilla::UniquePtr<void, JS::FreePolicy> data(length ? js_malloc(length) : nullptr);
      if (length && !data) throw Ffi::Error("ERR_MEMORY_ALLOCATION_FAILED", "Failed to allocate memory");
      if (length) std::memcpy(data.get(), reinterpret_cast<const void*>(pointer), length);
      buffer = JS::NewArrayBufferWithContents(cx, length, std::move(data));
    } else if (!pointer) buffer = JS::NewArrayBuffer(cx, 0);
    else {
      // Real non-owning payload, strongly owned alias descriptor. Existing
      // backing consumers retain descriptor metadata without double-charging
      // or freeing caller bytes; caller still guarantees the payload lifetime.
      auto borrowed = std::make_shared<Ffi::BorrowedAllocation>(reinterpret_cast<uint8_t*>(pointer),
          length, KandeloFfiMemoryMetadata, JS::KandeloBacking::ResolveAccount(cx));
      buffer = JS::NewArrayBufferWithUserOwnedContents(cx, length, reinterpret_cast<void*>(pointer));
      if (!buffer || !JS::KandeloBacking::InstallUserOwned(cx, buffer, borrowed)) return false;
    }
    if (!buffer) return false;
    if constexpr (Buffer) {
      RootedObject bytes(cx, JS_NewUint8ArrayWithBuffer(cx, buffer, 0, int64_t(length)));
      if (!bytes) return false;
      RootedValue prototypeValue(cx, js::GetFunctionNativeReserved(&args.callee(), 0));
      if (!prototypeValue.isObject()) throw Ffi::Error("ERR_FFI_CALL_FAILED", "FFI Buffer prototype owner is unavailable");
      RootedObject prototype(cx, &prototypeValue.toObject());
      if (!JS_SetPrototype(cx, bytes, prototype)) return false;
      if (args.get(2).isFalse()) {
        uint32_t marks;
        if (!cx->getKandeloObjectMarks(buffer, &marks) ||
            !cx->setKandeloObjectMarks(buffer, marks | JSContext::KandeloUntransferable)) return false;
        // Pinned node_buffer.cc CallbackInfo detaches null foreign backing.
        // Create the actual view first: constructing a new JS view afterward
        // is forbidden even when its length is zero. Do not length-pin it.
        if (!pointer && !JS::DetachArrayBuffer(cx, buffer)) return false;
      }
      args.rval().setObject(*bytes);
    } else args.rval().setObject(*buffer);
    return true;
  });
}
static bool KandeloFfiMemoryCreateBufferFunction(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  return KandeloFfiTry(cx, [&] {
    if (!args.get(0).isObject()) throw Ffi::Error("ERR_INVALID_ARG_TYPE",
        "FFI Buffer owner must be an actual prototype object");
    RootedFunction function(cx, js::NewFunctionWithReserved(cx,
        KandeloFfiMemoryArrayBuffer<true>, 0, 0, "toBuffer"));
    if (!function) return false;
    js::SetFunctionNativeReserved(JS_GetFunctionObject(function), 0, args[0]);
    args.rval().setObject(*JS_GetFunctionObject(function)); return true;
  });
}
static bool KandeloFfiMemoryString(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  return KandeloFfiTry(cx, [&] {
    const uintptr_t pointer = KandeloFfiMemoryPointer(args.get(0), "first argument");
    if (!pointer) { args.rval().setNull(); return true; }
    const char* data = reinterpret_cast<const char*>(pointer);
    const size_t length = std::strlen(data);
    if (length > JSString::MAX_LENGTH) throw Ffi::Error("ERR_STRING_TOO_LONG", "String is too long");
    size_t units;
    JS::UniqueTwoByteChars characters(JS::LossyUTF8CharsToNewTwoByteCharsZ(
        cx, JS::UTF8Chars(data, length), &units, js::MallocArena).get());
    if (!characters) return false;
    RootedString string(cx, JS_NewUCStringCopyN(cx, characters.get(), units));
    if (!string) return false;
    args.rval().setString(string); return true;
  });
}
static bool KandeloDefineFfiMemory(JSContext* cx, HandleObject native) {
  RootedObject memory(cx, JS_NewPlainObject(cx));
  if (!memory) return false;
  const JSFunctionSpec functions[] = {
    JS_FN("getInt8", (KandeloFfiMemoryGet<int8_t>), 0, JSPROP_ENUMERATE),
    JS_FN("getUint8", (KandeloFfiMemoryGet<uint8_t>), 0, JSPROP_ENUMERATE),
    JS_FN("getInt16", (KandeloFfiMemoryGet<int16_t>), 0, JSPROP_ENUMERATE),
    JS_FN("getUint16", (KandeloFfiMemoryGet<uint16_t>), 0, JSPROP_ENUMERATE),
    JS_FN("getInt32", (KandeloFfiMemoryGet<int32_t>), 0, JSPROP_ENUMERATE),
    JS_FN("getUint32", (KandeloFfiMemoryGet<uint32_t>), 0, JSPROP_ENUMERATE),
    JS_FN("getInt64", (KandeloFfiMemoryGet<int64_t>), 0, JSPROP_ENUMERATE),
    JS_FN("getUint64", (KandeloFfiMemoryGet<uint64_t>), 0, JSPROP_ENUMERATE),
    JS_FN("getFloat32", (KandeloFfiMemoryGet<float>), 0, JSPROP_ENUMERATE),
    JS_FN("getFloat64", (KandeloFfiMemoryGet<double>), 0, JSPROP_ENUMERATE),
    JS_FN("setInt8", (KandeloFfiMemorySet<int8_t>), 0, JSPROP_ENUMERATE),
    JS_FN("setUint8", (KandeloFfiMemorySet<uint8_t>), 0, JSPROP_ENUMERATE),
    JS_FN("setInt16", (KandeloFfiMemorySet<int16_t>), 0, JSPROP_ENUMERATE),
    JS_FN("setUint16", (KandeloFfiMemorySet<uint16_t>), 0, JSPROP_ENUMERATE),
    JS_FN("setInt32", (KandeloFfiMemorySet<int32_t>), 0, JSPROP_ENUMERATE),
    JS_FN("setUint32", (KandeloFfiMemorySet<uint32_t>), 0, JSPROP_ENUMERATE),
    JS_FN("setInt64", (KandeloFfiMemorySet<int64_t>), 0, JSPROP_ENUMERATE),
    JS_FN("setUint64", (KandeloFfiMemorySet<uint64_t>), 0, JSPROP_ENUMERATE),
    JS_FN("setFloat32", (KandeloFfiMemorySet<float>), 0, JSPROP_ENUMERATE),
    JS_FN("setFloat64", (KandeloFfiMemorySet<double>), 0, JSPROP_ENUMERATE),
    JS_FN("getRawPointer", KandeloFfiMemoryRawPointer, 0, JSPROP_ENUMERATE),
    JS_FN("exportBytes", KandeloFfiMemoryExport, 0, JSPROP_ENUMERATE),
    JS_FN("toString", KandeloFfiMemoryString, 0, JSPROP_ENUMERATE),
    JS_FN("toArrayBuffer", (KandeloFfiMemoryArrayBuffer<false>), 0, JSPROP_ENUMERATE),
    JS_FN("createToBuffer", KandeloFfiMemoryCreateBufferFunction, 1, JSPROP_ENUMERATE),
    JS_FS_END
  };
  return JS_DefineFunctions(cx, memory, functions) && JS_DefineProperty(cx, native, "ffiMemory", memory, 0);
}
}  // namespace
