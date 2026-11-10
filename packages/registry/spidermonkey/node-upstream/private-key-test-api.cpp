#include "shell/node-upstream/private-key-test-api.h"

#include "jsapi.h"

#include "js/CallArgs.h"
#include "js/Conversions.h"
#include "js/ErrorReport.h"
#include "js/GlobalObject.h"
#include "js/PropertyAndElement.h"
#include "js/RootingAPI.h"
#include "js/Symbol.h"

namespace kandelo::node {
namespace {

bool NewPrivateKey(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedString description(cx);
  if (argc && !args[0].isUndefined()) {
    description = JS::ToString(cx, args[0]);
    if (!description) {
      return false;
    }
  }
  JS::RootedSymbol key(cx, JS::NewEmbeddingPrivateSymbol(cx, description));
  if (!key) {
    return false;
  }
  args.rval().setSymbol(key);
  return true;
}

bool InitializePrivateKey(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  if (argc != 3 || !args[0].isObject() || !args[1].isSymbol()) {
    JS_ReportErrorASCII(cx, "initializePrivateKey requires object, private key, value");
    return false;
  }
  JS::RootedSymbol key(cx, args[1].toSymbol());
  if (JS::GetSymbolCode(key) != JS::SymbolCode::EmbeddingPrivateSymbol) {
    JS_ReportErrorASCII(cx, "initializePrivateKey requires an embedding-private key");
    return false;
  }
  JS::RootedObject target(cx, &args[0].toObject());
  JS::RootedId id(cx, JS::PropertyKey::Symbol(key));
  // Native DefineProperty initializes proxy-owned hidden storage. Using Set
  // here would conflate native initialization with the rejected first JS write.
  if (!JS_DefinePropertyById(cx, target, id, args[2], 0)) {
    return false;
  }
  args.rval().setUndefined();
  return true;
}

}  // namespace

bool DefinePrivateKeyTestAPI(JSContext* cx) {
  static const JSFunctionSpec functions[] = {
      JS_FN("newPrivateKey", NewPrivateKey, 0, 0),
      JS_FN("initializePrivateKey", InitializePrivateKey, 3, 0),
      JS_FS_END,
  };
  JS::RootedObject api(cx, JS_NewPlainObject(cx));
  if (!api || !JS_DefineFunctions(cx, api, functions)) {
    return false;
  }
  JS::RootedObject global(cx, JS::CurrentGlobalOrNull(cx));
  return JS_DefineProperty(cx, global,
                           "__kandeloUpstreamTest", api, 0);
}

}  // namespace kandelo::node
