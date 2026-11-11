#ifndef KANDELO_NODE_ERROR_STACK_H
#define KANDELO_NODE_ERROR_STACK_H

#include "js/TypeDecls.h"

namespace kandelo::node {
// Install before original primordials snapshot the realm's Error intrinsics.
JSObject* CreateErrorStackState(JSContext* cx);
JSObject* GetErrorStackBinding(JSContext* cx);
bool EnhanceFatalExceptionStack(JSContext* cx, JS::HandleValue error,
                               bool afterInspector, JS::MutableHandleValue out);
}  // namespace kandelo::node

#endif
