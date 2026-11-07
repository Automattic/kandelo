/* Real parser goals and explicit patched-CJS script execution. Detection never
 * evaluates source. Syntax errors, OOM and arbitrary thrown values propagate. */
#include <iterator>
#include <new>
#include <kandelo-node/merve/merve.h>
#include "js/Array.h"
#include "js/CharacterEncoding.h"
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
  if (strcmp(mode.get(), "cjs-exports") == 0) {
    Rooted<JSLinearString*> linear(cx, JS_EnsureLinearString(cx, source));
    if (!linear) return false;
    UniqueChars utf8 = JS_EncodeStringToUTF8(cx, linear);
    if (!utf8) return false;
    std::optional<lexer::lexer_analysis> analysis;
    try {
      analysis = lexer::parse_commonjs(std::string_view(utf8.get(), JS::GetDeflatedUTF8StringLength(linear)));
    } catch (const std::bad_alloc&) {
      JS_ReportOutOfMemory(cx); return false;
    }
    RootedObject exports(cx, JS::NewArrayObject(cx, 0));
    RootedObject reexports(cx, JS::NewArrayObject(cx, 0));
    if (!exports || !reexports) return false;
    if (analysis.has_value()) {
      uint32_t index = 0;
      for (const auto& value : analysis->exports) {
        const auto text = lexer::get_string_view(value);
        RootedString name(cx, JS_NewStringCopyUTF8N(cx, JS::UTF8Chars(text.data(), text.size())));
        RootedValue element(cx);
        if (!name) return false;
        element.setString(name);
        if (!JS_DefineElement(cx, exports, index++, element, JSPROP_ENUMERATE)) return false;
      }
      index = 0;
      for (const auto& value : analysis->re_exports) {
        const auto text = lexer::get_string_view(value);
        RootedString name(cx, JS_NewStringCopyUTF8N(cx, JS::UTF8Chars(text.data(), text.size())));
        RootedValue element(cx);
        if (!name) return false;
        element.setString(name);
        if (!JS_DefineElement(cx, reexports, index++, element, JSPROP_ENUMERATE)) return false;
      }
    }
    RootedObject result(cx, JS::NewArrayObject(cx, 0));
    RootedValue a(cx, ObjectValue(*exports)), b(cx, ObjectValue(*reexports));
    if (!result || !JS_DefineElement(cx, result, 0, a, JSPROP_ENUMERATE) ||
        !JS_DefineElement(cx, result, 1, b, JSPROP_ENUMERATE)) return false;
    args.rval().setObject(*result); return true;
  }
  if (strcmp(mode.get(), "wrap") == 0) {
    // Module.wrap can supply an arbitrary script. Retain its complete UTF-16
    // source, evaluate only this explicitly patched route, and register the
    // referring source for nested dynamic imports before executing it.
    AutoStableStringChars chars(cx); if (!chars.initTwoByte(cx, source)) return false;
    JS::SourceText<char16_t> text; if (!text.initMaybeBorrowed(cx, chars)) return false;
    JS::CompileOptions options(cx); options.setFileAndLine(filename.get(), 1).setForceFullParse();
    RootedScript script(cx, JS::Compile(cx, options, text)); if (!script) return false;
    RootedObject info(cx, js::CreateScriptPrivate(cx, file)); if (!info) return false;
    JS::SetScriptPrivate(script, ObjectValue(*info));
    return JS_ExecuteScript(cx, script, args.rval());
  }
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
