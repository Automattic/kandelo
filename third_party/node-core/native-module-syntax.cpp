/* Real parser goals, never source evaluation. Private error reports distinguish
 * syntax rejection from OOM/interruption; arbitrary thrown values propagate. */
#include <iterator>
#include "js/CompilationAndEvaluation.h"
#include "js/EnvironmentChain.h"
#include "js/ErrorReport.h"
#include "js/Exception.h"
#include "js/Modules.h"
#include "js/friend/ErrorMessages.h"
namespace {
static JSFunction* KandeloCompileCommonJsBody(JSContext* cx, HandleString source,
                                             const char* filename) {
  AutoStableStringChars chars(cx);
  if (!chars.initTwoByte(cx, source)) return nullptr;
  JS::SourceText<char16_t> text;
  if (!text.initMaybeBorrowed(cx, chars)) return nullptr;
  JS::CompileOptions options(cx);
  options.setFileAndLine(filename, 1).setForceFullParse();
  JS::EnvironmentChain chain(cx, JS::SupportUnscopables::No);
  static constexpr const char* parameters[] = {
    "exports", "require", "module", "__filename", "__dirname"};
  return JS::CompileFunction(cx, chain, options, nullptr,
      std::size(parameters), parameters, text);
}
static bool KandeloTakeModuleSyntaxError(JSContext* cx, unsigned* number) {
  RootedValue value(cx);
  if (!JS_IsExceptionPending(cx) || !JS_GetPendingException(cx, &value) || !value.isObject()) return false;
  RootedObject object(cx, &value.toObject());
  JSErrorReport* report = JS_ErrorFromException(cx, object);
  if (!report || report->exnType != JSEXN_SYNTAXERR) return false;
  *number = report->errorNumber;
  JS_ClearPendingException(cx); return true;
}
static bool KandeloNativeModuleSyntax(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isString() || !args.get(1).isString() || !args.get(2).isString()) {
    JS_ReportErrorASCII(cx, "Module parser requires operation, source and filename strings"); return false;
  }
  RootedString operation(cx, args[0].toString()), source(cx, args[1].toString()), file(cx, args[2].toString());
  JS::UniqueChars mode = JS_EncodeStringToUTF8(cx, operation), filename = JS_EncodeStringToUTF8(cx, file);
  if (!mode || !filename) return false;
  const bool compile = strcmp(mode.get(), "compile") == 0;
  if (!compile && strcmp(mode.get(), "detect") != 0) {
    JS_ReportErrorASCII(cx, "Unknown module parser operation"); return false;
  }
  RootedFunction function(cx, KandeloCompileCommonJsBody(cx, source, filename.get()));
  if (function) {
    if (!compile) { args.rval().setBoolean(false); return true; }
    // Register the real referring source for nested dynamic import(). No body
    // or concatenated wrapper text executes while constructing this function.
    RootedScript script(cx, JS_GetFunctionScript(cx, function));
    if (!script) return false;
    RootedObject info(cx, js::CreateScriptPrivate(cx, file)); if (!info) return false;
    JS::SetScriptPrivate(script, ObjectValue(*info));
    args.rval().setObject(*JS_GetFunctionObject(function)); return true;
  }
  if (compile) return false;
  unsigned error;
  if (!KandeloTakeModuleSyntaxError(cx, &error)) return false;
  // Like the target's native contextify policy, actual import/export/meta
  // diagnostics identify module syntax even if another module error follows.
  if (error == JSMSG_IMPORT_DECL_AT_TOP_LEVEL || error == JSMSG_EXPORT_DECL_AT_TOP_LEVEL ||
      error == JSMSG_IMPORT_META_OUTSIDE_MODULE) {
    args.rval().setBoolean(true); return true;
  }
  // Lexical wrapper-name collisions and top-level await require a real module
  // parse. Invalid syntax in both goals stays a CommonJS diagnostic. This
  // engine's error ordering/grammar still needs native/guest reconciliation.
  AutoStableStringChars chars(cx); if (!chars.initTwoByte(cx, source)) return false;
  JS::SourceText<char16_t> text; if (!text.initMaybeBorrowed(cx, chars)) return false;
  JS::CompileOptions options(cx); options.setFileAndLine(filename.get(), 1).setForceFullParse();
  RootedObject module(cx, JS::CompileModule(cx, options, text));
  if (module) { args.rval().setBoolean(true); return true; }
  if (!KandeloTakeModuleSyntaxError(cx, &error)) return false;
  args.rval().setBoolean(false); return true;
}
}  // namespace
