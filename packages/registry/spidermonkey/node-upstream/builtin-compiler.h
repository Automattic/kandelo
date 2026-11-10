#ifndef KANDELO_SPIDERMONKEY_NODE_BUILTIN_COMPILER_H
#define KANDELO_SPIDERMONKEY_NODE_BUILTIN_COMPILER_H

#include <string_view>

struct JSContext;
class JSFunction;
class JSObject;

namespace kandelo::node {

// Compile in cx's current realm. Callers must immediately root the returned
// function/module and supply the correct upstream bootstrap arguments/hooks.
// Compilation neither executes a builtin nor owns module caches or policy.
// Failure returns nullptr with a pending engine exception.
JSFunction* CompileBuiltinFunction(JSContext* cx, std::string_view id);
JSObject* CompileBuiltinSourceTextModule(JSContext* cx, std::string_view id);

}  // namespace kandelo::node

#endif  // KANDELO_SPIDERMONKEY_NODE_BUILTIN_COMPILER_H
