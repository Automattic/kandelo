/* Real dotenv parser and file/environment owners, included after FS helpers. */
#include "kandelo-node-dotenv-file.h"
namespace {
static bool KandeloDotenvEncode(JSContext* cx, HandleString text, std::string* output) {
  JSLinearString* linear = JS_EnsureLinearString(cx, text); if (!linear) return false;
  const size_t length = JS::GetDeflatedUTF8StringLength(linear);
  if (length == SIZE_MAX) { JS_ReportOutOfMemory(cx); return false; }
  output->resize(length);
  JS::AutoCheckCannotGC nogc;
  if (length) JS::DeflateStringToUTF8Buffer(linear, mozilla::Span<char>(output->data(), length));
  return true;
}
static bool KandeloDotenvObject(JSContext* cx, const kandelo::dotenv::Dotenv& parser,
                                MutableHandleValue value) {
  RootedObject object(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  if (!object) return false;
  for (const auto& entry : parser.Entries()) {
    RootedValue name(cx), text(cx);
    if (!KandeloFsPathString(cx, entry.first.data(), entry.first.size(), &name) ||
        !KandeloFsPathString(cx, entry.second.data(), entry.second.size(), &text)) return false;
    RootedId id(cx);
    if (!JS_ValueToId(cx, name, &id) ||
        !JS_DefinePropertyById(cx, object, id, text, JSPROP_ENUMERATE)) return false;
  }
  value.setObject(*object); return true;
}
static bool KandeloNativeParseEnv(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (args.length() != 1 || !args[0].isString()) {
    JS_ReportErrorASCII(cx, "Dotenv parser requires one string"); return false;
  }
  RootedString text(cx, args[0].toString());
  std::string content;
  // Length-bearing conversion retains embedded NULs and Node's UTF-8
  // replacement for unpaired UTF-16. No borrowed engine bytes cross parsing.
  if (!KandeloDotenvEncode(cx, text, &content)) return false;
  kandelo::dotenv::Dotenv parser;
  parser.ParseContent(content);
  return KandeloDotenvObject(cx, parser, args.rval());
}
static bool KandeloNativeLoadEnvFile(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (args.length() != 1) { JS_ReportErrorASCII(cx, "Dotenv file requires one path"); return false; }
  JS::UniqueChars path; size_t length;
  if (!KandeloFsPath(cx, args[0], &path, &length)) return false;
  kandelo::dotenv::Dotenv parser;
  const auto result = kandelo::dotenv::Load(path.get(), parser);
  if (result.failure == kandelo::dotenv::Failure::None) {
    for (const auto& entry : parser.Entries()) {
      // Native Node checks the raw C-string key before converting the UTF-8
      // strings for RealEnvStore. Do not hold the environment mutex over JS
      // allocation; existing values (including empty strings) take precedence.
      if (kandelo::process_state::GetEnvironment(entry.first.c_str())) continue;
      RootedValue name(cx), value(cx);
      if (!KandeloFsPathString(cx, entry.first.data(), entry.first.size(), &name) ||
          !KandeloFsPathString(cx, entry.second.data(), entry.second.size(), &value)) return false;
      RootedString nameString(cx, name.toString()), valueString(cx, value.toString());
      std::string encodedName, encodedValue;
      if (!KandeloDotenvEncode(cx, nameString, &encodedName) ||
          !KandeloDotenvEncode(cx, valueString, &encodedValue)) return false;
      // Target RealEnvStore ignores invalid-name/setenv status; no shadow key.
      kandelo::process_state::SetEnvironment(encodedName.c_str(), encodedValue.c_str());
    }
    args.rval().setUndefined(); return true;
  }
  const char* operation = result.failure == kandelo::dotenv::Failure::Open ? "open" :
      result.failure == kandelo::dotenv::Failure::Read ? "read" : "close";
  RootedObject error(cx, JS_NewPlainObject(cx));
  RootedString kind(cx, JS_NewStringCopyZ(cx, operation));
  RootedValue kindValue(cx), errnoValue(cx, Int32Value(-result.error)), pathValue(cx);
  if (!error || !kind || !KandeloFsPathString(cx, path.get(), length, &pathValue)) return false;
  kindValue.setString(kind);
  if (!JS_DefineProperty(cx, error, "kind", kindValue, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, error, "errno", errnoValue, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, error, "path", pathValue, JSPROP_ENUMERATE)) return false;
  args.rval().setObject(*error); return true;
}
}  // namespace
