#ifndef KANDELO_NODE_ERROR_STACK_H
#define KANDELO_NODE_ERROR_STACK_H

#include "js/TypeDecls.h"

namespace kandelo::node {
// Install before original primordials snapshot the realm's Error intrinsics.
JSObject* CreateErrorStackState(JSContext* cx);
JSObject* GetErrorStackBinding(JSContext* cx);
// Reading a message can use the pending structured capture without formatting it.
bool ReadUnformattedErrorStack(JSContext* cx, JS::HandleValue value,
                               JS::MutableHandleObject stack);
enum class ErrorStackCallback { Prepare, BeforeFatal, AfterFatal };
bool GetCurrentErrorStackCallback(JSContext*,JS::HandleObject,ErrorStackCallback,JS::MutableHandleValue);
bool SetCurrentErrorStackCallback(JSContext*,JS::HandleObject,ErrorStackCallback,JS::HandleValue);
bool EnhanceFatalExceptionStack(JSContext* cx, JS::HandleValue error,
                               bool afterInspector, JS::MutableHandleValue out);
}  // namespace kandelo::node

#endif
