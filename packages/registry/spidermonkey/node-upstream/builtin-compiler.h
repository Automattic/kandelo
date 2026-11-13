#ifndef KANDELO_SPIDERMONKEY_NODE_BUILTIN_COMPILER_H
#define KANDELO_SPIDERMONKEY_NODE_BUILTIN_COMPILER_H

#include <string_view>

// Mozilla's build defaults to hidden visibility. Its own declarations carry
// the JS_PUBLIC_API attributes that must agree across every including header.
#include "js/TypeDecls.h"

namespace kandelo::node {

// Compile in cx's current realm. Callers must immediately root the returned
// function/module and supply the correct upstream bootstrap arguments/hooks.
// Compilation neither executes a builtin nor owns module caches or policy.
// Failure returns nullptr with a pending engine exception.
JSFunction* CompileBuiltinFunction(JSContext* cx, std::string_view id);
JSObject* CompileBuiltinSourceTextModule(JSContext* cx, std::string_view id);

// Compile a complete runtime-provided UTF-16 body in the current global lexical
// environment. Filename and Latin-1 formal names are native C-string metadata,
// with the same lifetime/encoding contract as SpiderMonkey's CompileFunction.
// No caller object, lexical frame, module cache, code cache or snapshot is used.
JSFunction* CompileNativeFunctionBody(JSContext* cx, const char* filename,
                                      JS::HandleString body, unsigned parameterCount,
                                      const char* const* parameterNames);

}  // namespace kandelo::node

#endif  // KANDELO_SPIDERMONKEY_NODE_BUILTIN_COMPILER_H
