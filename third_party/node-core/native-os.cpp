/* Actual POSIX OS state. Resource/CPU/interface measurement has no fake path. */
#include "kandelo-node-os-operations.h"
#include "kandelo-node-default-locale.h"
#include "js/LocaleSensitive.h"
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
static bool KandeloNativeOS(JSContext* cx,unsigned argc,Value* vp) {
  CallArgs args = CallArgsFromVp(argc,vp);
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx,"OS operation requires a name"); return false; }
  RootedString operationName(cx,args[0].toString());
  JS::UniqueChars operation = JS_EncodeStringToUTF8(cx,operationName);
  if (!operation) return false;
  RootedValue value(cx,UndefinedValue()); int error = 0;
  const char* name = operation.get();
  if (strncmp(name, "tty-", 4) == 0) {
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
