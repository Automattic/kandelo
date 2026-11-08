/* Actual POSIX OS state. Resource/CPU/interface measurement has no fake path. */
#include "kandelo-node-os-operations.h"
#include "kandelo-node-default-locale.h"
#include "kandelo-node-public-constants.h"
#include "js/LocaleSensitive.h"
#include "js/Exception.h"
#include "js/PropertyAndElement.h"
#include "js/Stack.h"
#include <new>
#include <type_traits>
namespace {
static bool KandeloOSBytes(JSContext* cx,const std::string& text,MutableHandleValue value) {
  RootedObject bytes(cx,KandeloNewUint8ArrayCopy(cx,
      reinterpret_cast<const uint8_t*>(text.data()),text.size()));
  if (!bytes) return false;
  value.setObject(*bytes); return true;
}
static bool KandeloOSResult(JSContext* cx,int status,HandleValue value,MutableHandleValue output) {
  RootedObject result(cx,JS_NewPlainObject(cx));
  RootedValue error(cx,Int32Value(status));
  if (!result || !JS_DefineProperty(cx,result,"error",error,JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx,result,"value",value,JSPROP_ENUMERATE)) return false;
  output.setObject(*result); return true;
}
// The result is consumed once by the environment's shared binding owner.
// FS and signal objects are supplied by their existing actual owners in JS.
static bool KandeloPublicConstants(JSContext* cx,HandleObject fs,HandleObject signals,MutableHandleValue output) {
  RootedObject binding(cx,JS_NewObjectWithGivenProto(cx,nullptr,nullptr));
  RootedObject os(cx,JS_NewObjectWithGivenProto(cx,nullptr,nullptr));
  RootedObject errors(cx,JS_NewObjectWithGivenProto(cx,nullptr,nullptr));
  RootedObject priority(cx,JS_NewObjectWithGivenProto(cx,nullptr,nullptr));
  RootedObject dlopen(cx,JS_NewObjectWithGivenProto(cx,nullptr,nullptr));
  RootedObject crypto(cx,JS_NewObjectWithGivenProto(cx,nullptr,nullptr));
  if(!binding || !os || !errors || !priority || !dlopen || !crypto)return false;
  constexpr unsigned attributes=JSPROP_ENUMERATE|JSPROP_READONLY|JSPROP_PERMANENT;
  auto numeric=[&](HandleObject object){
    return [&,object](const char* name,double number){
      return JS_DefineProperty(cx,object,name,number,attributes);
    };
  };
  auto cryptoDefine=[&](const char* name,auto value){
    if constexpr(std::is_same_v<decltype(value),double>)
      return JS_DefineProperty(cx,crypto,name,value,attributes);
    else {
      RootedString string(cx,JS_NewStringCopyZ(cx,value));
      return string && JS_DefineProperty(cx,crypto,name,string,attributes);
    }
  };
  using namespace kandelo::node_constants;
  if(!DefineErrnoConstants(numeric(errors)) || !DefineWindowsErrorConstants(numeric(errors)) ||
      !DefinePriorityConstants(numeric(priority)) || !DefineDLOpenConstants(numeric(dlopen)) ||
      !DefineCryptoConstants(cryptoDefine) ||
      !JS_DefineProperty(cx,os,"UV_UDP_REUSEADDR",int(kandelo::node_constants::uv::UV_UDP_REUSEADDR),attributes) ||
      !JS_DefineProperty(cx,os,"dlopen",dlopen,JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx,os,"errno",errors,JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx,os,"signals",signals,JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx,os,"priority",priority,JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx,binding,"os",os,JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx,binding,"fs",fs,JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx,binding,"crypto",crypto,JSPROP_ENUMERATE))return false;
  output.setObject(*binding);return true;
}
// Node GetGroups uses ErrnoException, whose errno is positive and whose
// message is the actual libc strerror text, rather than UVException's schema.
static bool KandeloProcessGroupsError(JSContext* cx, int errorNumber) {
  if (JS_IsExceptionPending(cx)) return false;
  const char* errorCode = "";
  const bool constants = kandelo::node_constants::DefineErrnoConstants(
      [&](const char* name, double value) {
        if (!*errorCode && value == errorNumber) errorCode = name;
        return true;
      });
  MOZ_RELEASE_ASSERT(constants);
  // Pinned errno_string returns an empty code for an unknown errno.
  const std::string messageText = std::string(errorCode) + ", " + strerror(errorNumber);
  RootedString message(cx, JS_NewStringCopyN(cx, messageText.data(), messageText.size()));
  RootedString file(cx, JS_GetEmptyString(cx));
  RootedObject stack(cx);
  RootedValue error(cx);
  if (!message || !JS::CaptureCurrentStack(cx, &stack) ||
      !JS::CreateError(cx, JSEXN_ERR, stack, file, 0, JS::ColumnNumberOneOrigin(1), nullptr,
                      message, JS::NothingHandleValue, &error)) return false;
  RootedObject object(cx, &error.toObject());
  auto checkedSet = [&](const char* key, HandleValue value) {
    RootedString name(cx, JS_NewStringCopyZ(cx, key));
    RootedId id(cx);
    if (!name || !JS_StringToId(cx, name, &id)) return false;
    RootedValue receiver(cx, ObjectValue(*object));
    JS::ObjectOpResult result;
    // Pinned ErrnoException performs checked ordinary Set in this order.
    // Keep inherited setters/false-result policy with its actual native owner.
    if (!JS_ForwardSetPropertyTo(cx, object, id, value, receiver, result))
      MOZ_CRASH("Checked native process credential error assignment failed");
    return true;
  };
  RootedValue value(cx, Int32Value(errorNumber));
  if (!checkedSet("errno", value)) return false;
  RootedString code(cx, JS_NewStringCopyZ(cx, errorCode));
  if (!code) return false;
  value.setString(code);
  if (!checkedSet("code", value)) return false;
  RootedString syscall(cx, JS_NewStringCopyZ(cx, "getgroups"));
  if (!syscall) return false;
  value.setString(syscall);
  if (!checkedSet("syscall", value)) return false;
  JS_SetPendingException(cx, error); return false;
}
static bool KandeloProcessGroups(JSContext* cx, MutableHandleValue value) {
  try {
    const auto result = kandelo::process_state::GetGroups();
    if (result.error) return KandeloProcessGroupsError(cx, result.error);
    RootedObject groups(cx, JS::NewArrayObject(cx, result.groups.size()));
    if (!groups) return false;
    for (size_t i = 0; i < result.groups.size(); ++i) {
      RootedValue group(cx, NumberValue(double(result.groups[i])));
      if (!JS_DefineElement(cx, groups, uint32_t(i), group, JSPROP_ENUMERATE)) return false;
    }
    value.setObject(*groups); return true;
  } catch (const std::bad_alloc&) {
    JS_ReportOutOfMemory(cx); return false;
  }
}
static bool KandeloNativeOS(JSContext* cx,unsigned argc,Value* vp) {
  CallArgs args = CallArgsFromVp(argc,vp);
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx,"OS operation requires a name"); return false; }
  RootedString operationName(cx,args[0].toString());
  JS::UniqueChars operation = JS_EncodeStringToUTF8(cx,operationName);
  if (!operation) return false;
  RootedValue value(cx,UndefinedValue()); int error = 0;
  const char* name = operation.get();
  // Read/start/control results are the publication boundary for captured
  // input requests. A later packet OOM must not hide newly linked ownership
  // or an already-committed cancellation/reference transition.
  if (strcmp(name, "tty-stream-open") == 0 || strcmp(name, "tty-stream-state") == 0 ||
      strcmp(name, "tty-stream-abort") == 0 ||
      strcmp(name, "tty-input-read") == 0 || strcmp(name, "tty-input-start") == 0 ||
      strcmp(name, "tty-input-stop") == 0 || strcmp(name, "tty-input-ref") == 0) {
    return KandeloTerminalDispatch(cx, args, name, args.rval(), &error);
  }
  if (strcmp(name, "process-getgroups") == 0) {
    if (!KandeloProcessGroups(cx, &value)) return false;
  } else if (strncmp(name, "trace-", 6) == 0) {
    if (!KandeloTraceDispatch(cx, args, name, &value, &error)) return false;
  } else if (strcmp(name,"constants") == 0) {
    if(!args.get(1).isObject() || !args.get(2).isObject()) {
      JS_ReportErrorASCII(cx,"Constants require the real FS and signal bags");return false;
    }
    RootedObject fs(cx,&args[1].toObject()),signals(cx,&args[2].toObject());
    if(!KandeloPublicConstants(cx,fs,signals,&value))return false;
  } else if (strncmp(name, "tty-", 4) == 0) {
    if (!KandeloTerminalDispatch(cx, args, name, &value, &error)) return false;
  } else if (strcmp(name,"info") == 0) {
    const auto result = kandelo::node_os::Information(); error = result.error;
    if (!error) {
      RootedObject list(cx,JS::NewArrayObject(cx,4)); if (!list) return false;
      for (uint32_t i = 0; i < 4; i++) {
        RootedValue field(cx);
        if (!KandeloOSBytes(cx,result.value[i],&field) || !JS_SetElement(cx,list,i,field)) return false;
      }
      value.setObject(*list);
    }
  } else if (strcmp(name,"hostname") == 0 || strcmp(name,"home") == 0) {
    const auto result = strcmp(name,"hostname") == 0 ? kandelo::node_os::Hostname() : kandelo::node_os::HomeDirectory();
    error = result.error;
    if (!error && !KandeloOSBytes(cx,result.value,&value)) return false;
  } else if (strcmp(name,"temp") == 0) {
    const auto result = kandelo::node_os::TemporaryDirectory();
    if (result && !KandeloOSBytes(cx,*result,&value)) return false;
  } else if (strcmp(name,"user") == 0) {
    const auto result = kandelo::node_os::UserInfo(); error = result.error;
    if (!error) {
      RootedObject user(cx,JS_NewObjectWithGivenProto(cx,nullptr,nullptr));
      RootedValue uid(cx,NumberValue(double(result.value.uid))),gid(cx,NumberValue(double(result.value.gid)));
      RootedValue username(cx),homedir(cx),shell(cx);
      if (!user || !KandeloOSBytes(cx,result.value.username,&username) ||
          !KandeloOSBytes(cx,result.value.homedir,&homedir) || !KandeloOSBytes(cx,result.value.shell,&shell) ||
          !JS_DefineProperty(cx,user,"uid",uid,JSPROP_ENUMERATE) || !JS_DefineProperty(cx,user,"gid",gid,JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx,user,"username",username,JSPROP_ENUMERATE) || !JS_DefineProperty(cx,user,"homedir",homedir,JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx,user,"shell",shell,JSPROP_ENUMERATE)) return false;
      value.setObject(*user);
    }
  } else if (strcmp(name,"getpriority") == 0 || strcmp(name,"setpriority") == 0) {
    if (!args.get(1).isInt32() || (strcmp(name,"setpriority") == 0 && !args.get(2).isInt32())) {
      JS_ReportErrorASCII(cx,"OS priority requires checked int32 values"); return false;
    }
    if (strcmp(name,"getpriority") == 0) {
      const auto result = kandelo::node_os::GetPriority(args[1].toInt32()); error = result.error;
      if (!error) value.setInt32(result.value);
    } else error = kandelo::node_os::SetPriority(args[1].toInt32(),args[2].toInt32());
  } else if (strcmp(name,"default-locale") == 0) {
    JS::UniqueChars identifier = JS_GetDefaultLocaleIdentifier(cx);
    if (!identifier) return false;
    const auto locale = kandelo::locale::DefaultLocale(identifier.get());
    RootedString string(cx, JS_NewStringCopyN(cx, locale.data(), locale.size()));
    if (!string) return false;
    value.setString(string);
  } else if (strcmp(name,"endianness") == 0) {
    value.setBoolean(kandelo::node_os::IsBigEndian());
  } else { JS_ReportErrorASCII(cx,"Unknown OS operation"); return false; }
  return KandeloOSResult(cx,error,value,args.rval());
}
}
