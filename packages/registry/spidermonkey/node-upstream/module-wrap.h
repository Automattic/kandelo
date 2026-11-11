#ifndef KANDELO_NODE_MODULE_WRAP_H
#define KANDELO_NODE_MODULE_WRAP_H

#include "js/TypeDecls.h"

namespace kandelo::node {
// Current realm must have completed original per-context initialization.
// The canonical context carrier owns/cache-traces this binding, not a finalizer.
JSObject* CreateModuleWrapBinding(JSContext* cx, JS::HandleObject runtime);
}  // namespace kandelo::node

#endif
