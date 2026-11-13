#ifndef KANDELO_NODE_TASK_QUEUE_H
#define KANDELO_NODE_TASK_QUEUE_H

#include "js/Promise.h"
#include "js/TypeDecls.h"

namespace kandelo::node {
JSObject* CreateRuntimeTaskState(JSContext* cx);
JSObject* CreateTaskQueueBinding(JSContext* cx, JS::HandleObject runtime,
                                JS::HandleObject realm);
// A microtask-only checkpoint is distinct from the outer tick/rejection seam.
bool RunRuntimeMicrotasks(JSContext* cx);
bool CheckpointRuntimeTasks(JSContext* cx);
// Consumes a pending job exception only inside this owner's checkpoint.
bool HandleRuntimeJobException(JSContext* cx);
// True means the native environment owns this engine notification, including
// callback error reporting. False retains ordinary shell tracking behavior.
bool ForwardRuntimePromiseRejection(JSContext* cx, JS::HandleObject promise,
                                    JS::PromiseRejectionHandlingState event);
}  // namespace kandelo::node

#endif
