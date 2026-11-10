#include "shell/node-upstream/builtin-compiler.h"

#include "mozilla/Utf8.h"

#include "builtin-source-registry.h"

#include "js/CompilationAndEvaluation.h"
#include "js/CompileOptions.h"
#include "js/EnvironmentChain.h"
#include "js/ErrorReport.h"
#include "js/Modules.h"
#include "js/SourceText.h"

namespace kandelo::node {
namespace {

std::optional<BuiltinSourceView> RequireSource(JSContext* cx,
                                              std::string_view id) {
  auto source = FindBuiltinSource(id);
  if (!source) {
    JS_ReportErrorASCII(cx, "Node builtin is absent from the pinned source registry");
  }
  return source;
}

bool InitSource(JSContext* cx, const BuiltinSourceView& source,
                JS::SourceText<mozilla::Utf8Unit>& text) {
  // Registry bytes outlive all contexts. Use explicit length rather than strlen:
  // embedded zero bytes must reach the parser and receive their real semantics.
  return text.init(cx,
                   reinterpret_cast<const mozilla::Utf8Unit*>(source.utf8),
                   source.length, JS::SourceOwnership::Borrowed);
}

}  // namespace

JSFunction* CompileBuiltinFunction(JSContext* cx, std::string_view id) {
  auto source = RequireSource(cx, id);
  if (!source) {
    return nullptr;
  }
  if (std::string_view(source->kindName) == "kSourceTextModule") {
    JS_ReportErrorASCII(cx, "Source-text builtin requires native module compilation");
    return nullptr;
  }
  const auto parameterCount = static_cast<unsigned>(source->parameterCount);
  if (static_cast<std::size_t>(parameterCount) != source->parameterCount) {
    JS_ReportErrorASCII(cx, "Node builtin parameter count exceeds the engine limit");
    return nullptr;
  }
  // Classification, argument names and diagnostic origin are admitted immutable
  // metadata. Their build-time producer executes the original Node C++ policy.
  // No std::string/vector allocation is introduced into this engine entrypath.
  JS::CompileOptions options(cx);
  // SM140's CompileFunction inserts `function (...) {\n` before the body.
  // Starting its wrapper at zero preserves original body line 1. The module
  // compiler below has no such prelude and must start at line 1.
  options.setFileAndLine(source->diagnosticFilename, 0).setForceFullParse();
  JS::SourceText<mozilla::Utf8Unit> text;
  if (!InitSource(cx, *source, text)) {
    return nullptr;
  }
  // Global lexical scope is implicit. No caller/user object enters the builtin
  // scope chain. A null name also avoids CompileFunction's Latin-1 name API.
  const JS::EnvironmentChain environment(cx, JS::SupportUnscopables::No);
  return JS::CompileFunction(cx, environment, options, nullptr,
                             parameterCount,
                             source->parameters, text);
}

JSObject* CompileBuiltinSourceTextModule(JSContext* cx, std::string_view id) {
  auto source = RequireSource(cx, id);
  if (!source) {
    return nullptr;
  }
  if (std::string_view(source->kindName) != "kSourceTextModule") {
    JS_ReportErrorASCII(cx, "Function builtin requires its upstream parameter scope");
    return nullptr;
  }
  JS::CompileOptions options(cx);
  options.setFileAndLine(source->diagnosticFilename, 1)
      .setModule()
      .setForceFullParse();
  JS::SourceText<mozilla::Utf8Unit> text;
  if (!InitSource(cx, *source, text)) {
    return nullptr;
  }
  // Return a genuine engine module record. Linking/import.meta/evaluation and
  // identity belong to the shared ModuleWrap owner, not this source compiler.
  return JS::CompileModule(cx, options, text);
}

}  // namespace kandelo::node
