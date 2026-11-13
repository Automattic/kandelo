#ifndef KANDELO_NODE_ASYNC_WRAP_H
#define KANDELO_NODE_ASYNC_WRAP_H

#include "js/TypeDecls.h"

namespace kandelo::node {
JSObject* CreateRuntimeAsyncState(JSContext* cx);
JSObject* CreateAsyncWrapBinding(JSContext* cx, JS::HandleObject runtime,
                                JS::HandleObject realm);
bool PushRuntimeAsyncContext(JSContext* cx, JS::HandleObject runtime,
                             double asyncId, double triggerId,
                             JS::HandleObject resource);
bool PopRuntimeAsyncContext(JSContext* cx, JS::HandleObject runtime,
                            double asyncId, bool* more);
bool RuntimeExecutionAsyncId(JSContext* cx, JS::HandleObject runtime, double* id);
JSObject* InspectRuntimeAsyncState(JSContext* cx, JS::HandleObject runtime);
}  // namespace kandelo::node

#endif
