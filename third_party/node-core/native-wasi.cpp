// Actual guest WASI state and synchronous borrows of nested Wasm memory.
#include "kandelo-node-wasi-context.h"
#include <cmath>
#include "js/BigInt.h"
#include "js/Exception.h"
#include "js/Realm.h"
#include "js/Stack.h"
#include "js/Wrapper.h"
#include "vm/ArrayBufferObject.h"
#include "vm/ArrayBufferObject-inl.h"
#include "wasm/WasmJS.h"
namespace {
static void KandeloWasiFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);
  if (!slot.isUndefined()) delete static_cast<kandelo::wasi::Context*>(slot.toPrivate());
}
static const JSClassOps KandeloWasiOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloWasiFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloWasiClass = {"WASI",
  JSCLASS_HAS_RESERVED_SLOTS(2) | JSCLASS_FOREGROUND_FINALIZE, &KandeloWasiOps};
static bool KandeloWasiError(JSContext* cx, const char* code, const char* text,
                              JSExnType type = JSEXN_ERR, int number = -1) {
  if (JS_IsExceptionPending(cx)) return false;
  RootedString message(cx, JS_NewStringCopyZ(cx, text)), file(cx, JS_GetEmptyString(cx));
  RootedObject stack(cx); RootedValue value(cx);
  if (!message || !JS::CaptureCurrentStack(cx, &stack) ||
      !JS::CreateError(cx, type, stack, file, 0, JS::ColumnNumberOneOrigin(1), nullptr,
                       message, JS::NothingHandleValue, &value)) return false;
  RootedObject object(cx, &value.toObject());
  RootedString name(cx, JS_NewStringCopyZ(cx, code));
  if (!name || !JS_DefineProperty(cx, object, "code", name, JSPROP_ENUMERATE)) return false;
  if (number >= 0) {
    RootedString syscall(cx, JS_NewStringCopyZ(cx, "uvwasi_init"));
    if (!syscall || !JS_DefineProperty(cx, object, "errno", number, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, object, "syscall", syscall, JSPROP_ENUMERATE)) return false;
  }
  JS_SetPendingException(cx, value); return false;
}
static bool KandeloWasiReceiver(JSContext* cx, HandleValue input, MutableHandleObject owner) {
  if (input.isObject()) {
    owner.set(js::CheckedUnwrapDynamic(&input.toObject(), cx));
    if (!owner) { if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx,"WASI receiver access denied"); return false; }
    if (JS::GetClass(owner) == &KandeloWasiClass &&
        !JS::GetReservedSlot(owner, 0).isUndefined()) return true;
  }
  return KandeloWasiError(cx, "ERR_INVALID_THIS", "Value of this must be of type WASI", JSEXN_TYPEERR);
}
static bool KandeloWasiSetMemory(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedObject owner(cx); if (!KandeloWasiReceiver(cx, args.thisv(), &owner)) return false;
  RootedObject memory(cx);
  if (args.get(0).isObject()) {
    memory = js::CheckedUnwrapDynamic(&args[0].toObject(), cx);
    if (!memory) { if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx,"WASI memory access denied"); return false; }
  }
  if (!memory || !memory->is<js::WasmMemoryObject>())
    return KandeloWasiError(cx, "ERR_INVALID_ARG_TYPE",
      "\"instance.exports.memory\" property must be a WebAssembly.Memory object", JSEXN_TYPEERR);
  // Store a real traced/wrapped memory edge in the native owner's own realm.
  JSAutoRealm realm(cx, owner);
  RootedValue edge(cx, ObjectValue(*memory));
  if (!JS_WrapValue(cx, &edge)) return false;
  JS::SetReservedSlot(owner, 1, edge);
  args.rval().setUndefined(); return true;
}
static bool KandeloWasiStrings(JSContext* cx, HandleValue input, std::vector<std::string>& output) {
  bool array;
  if (!input.isObject() || !JS::IsArrayObject(cx, input, &array) || !array) {
    if (JS_IsExceptionPending(cx)) return false;
    return KandeloWasiError(cx,"ERR_INVALID_ARG_TYPE","WASI binding requires arrays",JSEXN_TYPEERR);
  }
  RootedObject object(cx, &input.toObject()); uint32_t count;
  if (!JS::GetArrayLength(cx, object, &count)) return false;
  output.reserve(count);
  for (uint32_t i = 0; i < count; ++i) {
    RootedValue value(cx); if (!JS_GetElement(cx, object, i, &value)) return false;
    if (!value.isString()) return KandeloWasiError(cx,"ERR_INVALID_ARG_TYPE","WASI binding requires strings",JSEXN_TYPEERR);
    RootedString string(cx, value.toString());
    JS::UniqueChars text = JS_EncodeStringToUTF8(cx, string); if (!text) return false;
    output.emplace_back(text.get());
  }
  return true;
}
static bool KandeloWasiConstruct(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.isConstructing() || argc != 4) {
    JS_ReportErrorASCII(cx, "WASI binding requires construction with four arrays"); return false;
  }
  try {
    RootedObject object(cx, JS_NewObjectForConstructor(cx, &KandeloWasiClass, args));
    if (!object) return false;
    std::vector<std::string> argv, env, preopens;
    if (!KandeloWasiStrings(cx,args[0],argv) || !KandeloWasiStrings(cx,args[1],env) ||
        !KandeloWasiStrings(cx,args[2],preopens)) return false;
    if (preopens.size() % 2) { JS_ReportErrorASCII(cx,"WASI preopens must be pairs"); return false; }
    bool array;
    if (!args[3].isObject() || !JS::IsArrayObject(cx,args[3],&array) || !array) {
      if (JS_IsExceptionPending(cx)) return false;
      return KandeloWasiError(cx,"ERR_INVALID_ARG_TYPE","WASI stdio requires an array",JSEXN_TYPEERR);
    }
    RootedObject stdioArray(cx,&args[3].toObject()); uint32_t length;
    if (!JS::GetArrayLength(cx,stdioArray,&length)) return false;
    if (length != 3) { JS_ReportErrorASCII(cx,"WASI stdio requires three descriptors"); return false; }
    int stdio[3];
    for (uint32_t i=0;i<3;++i) {
      RootedValue descriptor(cx); if (!JS_GetElement(cx,stdioArray,i,&descriptor)) return false;
      if (!descriptor.isInt32() || descriptor.toInt32()<0) { JS_ReportErrorASCII(cx,"WASI descriptor must be nonnegative int32"); return false; }
      stdio[i]=descriptor.toInt32();
    }
    // No observable JS runs between successful native admission and publication.
    auto context = std::make_unique<kandelo::wasi::Context>(std::move(argv),std::move(env),preopens,stdio,KandeloNativeMemoryOwner(cx));
    if (!JS_DefineFunction(cx, object, "_setMemory", KandeloWasiSetMemory, 1, JSPROP_ENUMERATE)) return false;
    JS::SetReservedSlot(object,0,PrivateValue(context.release()));
    args.rval().setObject(*object); return true;
  } catch (const kandelo::wasi::Error& error) {
    char text[128]; snprintf(text,sizeof(text),"%s, uvwasi_init",error.what());
    return KandeloWasiError(cx,error.what(),text,JSEXN_ERR,error.code);
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
// Direct JS follows Node's slow binding contract. Direct Wasm u32 provenance
// requires a genuine engine import-dispatch contract; a JS-call-stack guess or
// spoofable marker must not silently reinterpret negative direct-JS Numbers.
enum class KandeloWasiOperation { ArgsGet, ArgsSizesGet, ClockResGet, ClockTimeGet, EnvironGet, EnvironSizesGet, FdClose, FdDatasync, FdFdstatGet, FdFdstatSetFlags, FdFdstatSetRights, FdFilestatGet, FdFilestatSetSize, FdPread, FdPrestatGet, FdPrestatDirName, FdPwrite, FdRead, FdSeek, FdSync, FdTell, FdWrite, ProcExit, RandomGet, SchedYield };
template<KandeloWasiOperation Operation>
static bool KandeloWasiImport(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp);
  [[maybe_unused]] uint64_t v[5]{};
  if constexpr (Operation == KandeloWasiOperation::ArgsGet) {
    if (argc != 2) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::ArgsSizesGet) {
    if (argc != 2) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::ClockResGet) {
    if (argc != 2) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::ClockTimeGet) {
    if (argc != 3) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isBigInt()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=JS::ToBigUint64(args[1].toBigInt());
    if (!args[2].isNumber() || !std::isfinite(args[2].toNumber()) || args[2].toNumber() < 0 || args[2].toNumber() > UINT32_MAX || std::trunc(args[2].toNumber()) != args[2].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[2]=static_cast<uint32_t>(args[2].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::EnvironGet) {
    if (argc != 2) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::EnvironSizesGet) {
    if (argc != 2) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdClose) {
    if (argc != 1) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdDatasync) {
    if (argc != 1) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdFdstatGet) {
    if (argc != 2) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdFdstatSetFlags) {
    if (argc != 2) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdFdstatSetRights) {
    if (argc != 3) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isBigInt()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=JS::ToBigUint64(args[1].toBigInt());
    if (!args[2].isBigInt()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[2]=JS::ToBigUint64(args[2].toBigInt());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdFilestatGet) {
    if (argc != 2) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdFilestatSetSize) {
    if (argc != 2) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isBigInt()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=JS::ToBigUint64(args[1].toBigInt());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdPread) {
    if (argc != 5) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
    if (!args[2].isNumber() || !std::isfinite(args[2].toNumber()) || args[2].toNumber() < 0 || args[2].toNumber() > UINT32_MAX || std::trunc(args[2].toNumber()) != args[2].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[2]=static_cast<uint32_t>(args[2].toNumber());
    if (!args[3].isBigInt()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[3]=JS::ToBigUint64(args[3].toBigInt());
    if (!args[4].isNumber() || !std::isfinite(args[4].toNumber()) || args[4].toNumber() < 0 || args[4].toNumber() > UINT32_MAX || std::trunc(args[4].toNumber()) != args[4].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[4]=static_cast<uint32_t>(args[4].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdPrestatGet) {
    if (argc != 2) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdPrestatDirName) {
    if (argc != 3) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
    if (!args[2].isNumber() || !std::isfinite(args[2].toNumber()) || args[2].toNumber() < 0 || args[2].toNumber() > UINT32_MAX || std::trunc(args[2].toNumber()) != args[2].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[2]=static_cast<uint32_t>(args[2].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdPwrite) {
    if (argc != 5) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
    if (!args[2].isNumber() || !std::isfinite(args[2].toNumber()) || args[2].toNumber() < 0 || args[2].toNumber() > UINT32_MAX || std::trunc(args[2].toNumber()) != args[2].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[2]=static_cast<uint32_t>(args[2].toNumber());
    if (!args[3].isBigInt()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[3]=JS::ToBigUint64(args[3].toBigInt());
    if (!args[4].isNumber() || !std::isfinite(args[4].toNumber()) || args[4].toNumber() < 0 || args[4].toNumber() > UINT32_MAX || std::trunc(args[4].toNumber()) != args[4].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[4]=static_cast<uint32_t>(args[4].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdRead) {
    if (argc != 4) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
    if (!args[2].isNumber() || !std::isfinite(args[2].toNumber()) || args[2].toNumber() < 0 || args[2].toNumber() > UINT32_MAX || std::trunc(args[2].toNumber()) != args[2].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[2]=static_cast<uint32_t>(args[2].toNumber());
    if (!args[3].isNumber() || !std::isfinite(args[3].toNumber()) || args[3].toNumber() < 0 || args[3].toNumber() > UINT32_MAX || std::trunc(args[3].toNumber()) != args[3].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[3]=static_cast<uint32_t>(args[3].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdSeek) {
    if (argc != 4) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isBigInt()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=JS::ToBigUint64(args[1].toBigInt());
    if (!args[2].isNumber() || !std::isfinite(args[2].toNumber()) || args[2].toNumber() < 0 || args[2].toNumber() > UINT32_MAX || std::trunc(args[2].toNumber()) != args[2].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[2]=static_cast<uint32_t>(args[2].toNumber());
    if (!args[3].isNumber() || !std::isfinite(args[3].toNumber()) || args[3].toNumber() < 0 || args[3].toNumber() > UINT32_MAX || std::trunc(args[3].toNumber()) != args[3].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[3]=static_cast<uint32_t>(args[3].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdSync) {
    if (argc != 1) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdTell) {
    if (argc != 2) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::FdWrite) {
    if (argc != 4) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
    if (!args[2].isNumber() || !std::isfinite(args[2].toNumber()) || args[2].toNumber() < 0 || args[2].toNumber() > UINT32_MAX || std::trunc(args[2].toNumber()) != args[2].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[2]=static_cast<uint32_t>(args[2].toNumber());
    if (!args[3].isNumber() || !std::isfinite(args[3].toNumber()) || args[3].toNumber() < 0 || args[3].toNumber() > UINT32_MAX || std::trunc(args[3].toNumber()) != args[3].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[3]=static_cast<uint32_t>(args[3].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::ProcExit) {
    if (argc != 1) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::RandomGet) {
    if (argc != 2) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    if (!args[0].isNumber() || !std::isfinite(args[0].toNumber()) || args[0].toNumber() < 0 || args[0].toNumber() > UINT32_MAX || std::trunc(args[0].toNumber()) != args[0].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[0]=static_cast<uint32_t>(args[0].toNumber());
    if (!args[1].isNumber() || !std::isfinite(args[1].toNumber()) || args[1].toNumber() < 0 || args[1].toNumber() > UINT32_MAX || std::trunc(args[1].toNumber()) != args[1].toNumber()) { args.rval().setInt32(UVWASI_EINVAL); return true; }
    v[1]=static_cast<uint32_t>(args[1].toNumber());
  }
  else if constexpr (Operation == KandeloWasiOperation::SchedYield) {
    if (argc != 0) { args.rval().setInt32(UVWASI_EINVAL); return true; }
  }
  RootedObject owner(cx);
  if (!KandeloWasiReceiver(cx,args.thisv(),&owner)) return false;
  // The context is exclusively GC-owned by this rooted actual native instance.
  auto& context=*static_cast<kandelo::wasi::Context*>(JS::GetReservedSlot(owner,0).toPrivate());
  RootedObject memoryObject(cx);
  {
    JSAutoRealm realm(cx,owner);
    RootedValue edge(cx,JS::GetReservedSlot(owner,1));
    if (edge.isObject()) {
      memoryObject=js::CheckedUnwrapDynamic(&edge.toObject(),cx);
      if (!memoryObject) { if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx,"WASI memory access denied"); return false; }
    }
  }
  if (!memoryObject)
    return KandeloWasiError(cx,"ERR_WASI_NOT_STARTED","wasi.start() has not been called");
  MOZ_ASSERT(memoryObject->is<js::WasmMemoryObject>());
  try {
    JSAutoRealm realm(cx,memoryObject);
    auto& actual=memoryObject->as<js::WasmMemoryObject>();
    RootedObject backing(cx,&actual.buffer());
    JS::AutoCheckCannotGC nogc;
    // Actual current memory length may exceed the old fixed SAB wrapper length.
    [[maybe_unused]] kandelo::wasi::Memory memory{actual.buffer().dataPointerEither().unwrap(),
                                 actual.volatileMemoryLength(),actual.isShared()};
    uint32_t result=0;
    if constexpr (Operation == KandeloWasiOperation::ArgsGet) result=context.Strings(memory,false,false,v[0],v[1]);
    else if constexpr (Operation == KandeloWasiOperation::ArgsSizesGet) result=context.Strings(memory,false,true,v[0],v[1]);
    else if constexpr (Operation == KandeloWasiOperation::ClockResGet) result=context.Clock(memory,v[0],v[1],true);
    else if constexpr (Operation == KandeloWasiOperation::ClockTimeGet) result=context.Clock(memory,v[0],v[2],false);
    else if constexpr (Operation == KandeloWasiOperation::EnvironGet) result=context.Strings(memory,true,false,v[0],v[1]);
    else if constexpr (Operation == KandeloWasiOperation::EnvironSizesGet) result=context.Strings(memory,true,true,v[0],v[1]);
    else if constexpr (Operation == KandeloWasiOperation::FdClose) result=context.Close(v[0]);
    else if constexpr (Operation == KandeloWasiOperation::FdDatasync) result=context.Sync(v[0],true);
    else if constexpr (Operation == KandeloWasiOperation::FdFdstatGet) result=context.Fdstat(memory,v[0],v[1]);
    else if constexpr (Operation == KandeloWasiOperation::FdFdstatSetFlags) result=context.SetFlags(v[0],v[1]);
    else if constexpr (Operation == KandeloWasiOperation::FdFdstatSetRights) result=context.SetRights(v[0],v[1],v[2]);
    else if constexpr (Operation == KandeloWasiOperation::FdFilestatGet) result=context.Filestat(memory,v[0],v[1]);
    else if constexpr (Operation == KandeloWasiOperation::FdFilestatSetSize) result=context.SetSize(v[0],v[1]);
    else if constexpr (Operation == KandeloWasiOperation::FdPread) result=context.Io(memory,v[0],v[1],v[2],v[3],v[4],false,true);
    else if constexpr (Operation == KandeloWasiOperation::FdPrestatGet) result=context.Prestat(memory,v[0],v[1]);
    else if constexpr (Operation == KandeloWasiOperation::FdPrestatDirName) result=context.PrestatName(memory,v[0],v[1],v[2]);
    else if constexpr (Operation == KandeloWasiOperation::FdPwrite) result=context.Io(memory,v[0],v[1],v[2],v[3],v[4],true,true);
    else if constexpr (Operation == KandeloWasiOperation::FdRead) result=context.Io(memory,v[0],v[1],v[2],0,v[3],false,false);
    else if constexpr (Operation == KandeloWasiOperation::FdSeek) result=context.Seek(memory,v[0],static_cast<int64_t>(v[1]),v[2],v[3]);
    else if constexpr (Operation == KandeloWasiOperation::FdSync) result=context.Sync(v[0],false);
    else if constexpr (Operation == KandeloWasiOperation::FdTell) result=context.Seek(memory,v[0],0,UVWASI_WHENCE_CUR,v[1],true);
    else if constexpr (Operation == KandeloWasiOperation::FdWrite) result=context.Io(memory,v[0],v[1],v[2],0,v[3],true,false);
    else if constexpr (Operation == KandeloWasiOperation::ProcExit) { context.Exit(v[0]); }
    else if constexpr (Operation == KandeloWasiOperation::RandomGet) result=context.Random(memory,v[0],v[1]);
    else if constexpr (Operation == KandeloWasiOperation::SchedYield) result=context.Yield();
    args.rval().setNumber(result); return true;
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
    catch (const kandelo::wasi::Error& error) { args.rval().setInt32(error.code); return true; }
}
static const JSFunctionSpec KandeloWasiMethods[] = {
  JS_FN("args_get",KandeloWasiImport<KandeloWasiOperation::ArgsGet>,2,JSPROP_ENUMERATE),
  JS_FN("args_sizes_get",KandeloWasiImport<KandeloWasiOperation::ArgsSizesGet>,2,JSPROP_ENUMERATE),
  JS_FN("clock_res_get",KandeloWasiImport<KandeloWasiOperation::ClockResGet>,2,JSPROP_ENUMERATE),
  JS_FN("clock_time_get",KandeloWasiImport<KandeloWasiOperation::ClockTimeGet>,3,JSPROP_ENUMERATE),
  JS_FN("environ_get",KandeloWasiImport<KandeloWasiOperation::EnvironGet>,2,JSPROP_ENUMERATE),
  JS_FN("environ_sizes_get",KandeloWasiImport<KandeloWasiOperation::EnvironSizesGet>,2,JSPROP_ENUMERATE),
  JS_FN("fd_close",KandeloWasiImport<KandeloWasiOperation::FdClose>,1,JSPROP_ENUMERATE),
  JS_FN("fd_datasync",KandeloWasiImport<KandeloWasiOperation::FdDatasync>,1,JSPROP_ENUMERATE),
  JS_FN("fd_fdstat_get",KandeloWasiImport<KandeloWasiOperation::FdFdstatGet>,2,JSPROP_ENUMERATE),
  JS_FN("fd_fdstat_set_flags",KandeloWasiImport<KandeloWasiOperation::FdFdstatSetFlags>,2,JSPROP_ENUMERATE),
  JS_FN("fd_fdstat_set_rights",KandeloWasiImport<KandeloWasiOperation::FdFdstatSetRights>,3,JSPROP_ENUMERATE),
  JS_FN("fd_filestat_get",KandeloWasiImport<KandeloWasiOperation::FdFilestatGet>,2,JSPROP_ENUMERATE),
  JS_FN("fd_filestat_set_size",KandeloWasiImport<KandeloWasiOperation::FdFilestatSetSize>,2,JSPROP_ENUMERATE),
  JS_FN("fd_pread",KandeloWasiImport<KandeloWasiOperation::FdPread>,5,JSPROP_ENUMERATE),
  JS_FN("fd_prestat_get",KandeloWasiImport<KandeloWasiOperation::FdPrestatGet>,2,JSPROP_ENUMERATE),
  JS_FN("fd_prestat_dir_name",KandeloWasiImport<KandeloWasiOperation::FdPrestatDirName>,3,JSPROP_ENUMERATE),
  JS_FN("fd_pwrite",KandeloWasiImport<KandeloWasiOperation::FdPwrite>,5,JSPROP_ENUMERATE),
  JS_FN("fd_read",KandeloWasiImport<KandeloWasiOperation::FdRead>,4,JSPROP_ENUMERATE),
  JS_FN("fd_seek",KandeloWasiImport<KandeloWasiOperation::FdSeek>,4,JSPROP_ENUMERATE),
  JS_FN("fd_sync",KandeloWasiImport<KandeloWasiOperation::FdSync>,1,JSPROP_ENUMERATE),
  JS_FN("fd_tell",KandeloWasiImport<KandeloWasiOperation::FdTell>,2,JSPROP_ENUMERATE),
  JS_FN("fd_write",KandeloWasiImport<KandeloWasiOperation::FdWrite>,4,JSPROP_ENUMERATE),
  JS_FN("proc_exit",KandeloWasiImport<KandeloWasiOperation::ProcExit>,1,JSPROP_ENUMERATE),
  JS_FN("random_get",KandeloWasiImport<KandeloWasiOperation::RandomGet>,2,JSPROP_ENUMERATE),
  JS_FN("sched_yield",KandeloWasiImport<KandeloWasiOperation::SchedYield>,0,JSPROP_ENUMERATE),
  JS_FS_END,
};
static bool KandeloNativeWasiConstructor(JSContext* cx,unsigned argc,Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp);
  RootedObject scope(cx,JS_NewPlainObject(cx));
  if (!scope) return false;
  RootedObject prototype(cx,JS_InitClass(cx,scope,&KandeloWasiClass,nullptr,"WASI",
    KandeloWasiConstruct,4,nullptr,KandeloWasiMethods,nullptr,nullptr));
  if (!prototype) return false;
  return JS_GetProperty(cx,scope,"WASI",args.rval());
}
} // namespace
