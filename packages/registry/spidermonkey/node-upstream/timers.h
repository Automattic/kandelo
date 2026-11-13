#ifndef KANDELO_NODE_TIMERS_H
#define KANDELO_NODE_TIMERS_H

#include <cstdint>
#include <uv.h>

#include "js/TypeDecls.h"

namespace kandelo::node {
bool ReadGuestMonotonicMillis(JSContext* cx, uint64_t* result);
JSObject* CreateRuntimeTimerState(JSContext* cx, double base);
JSObject* CreateTimersBinding(JSContext* cx, JS::HandleObject runtime,
                             JS::HandleObject realm, JS::HandleObject process);
// No public adapter hooks. The caller provides actual engine job checkpoints.
using RuntimeTimerCheckpoint = bool (*)(JSContext* cx, bool* yield);
bool DispatchRuntimeTimers(JSContext* cx, JS::HandleObject runtime,
                           bool externalReferences, RuntimeTimerCheckpoint checkpoint,
                           int* dispatched,
                           int64_t* nextDelay);
JSObject* InspectRuntimeTimers(JSContext* cx, JS::HandleObject runtime);
// Borrowed from the canonical timer state. The caller must retain the runtime;
// array storage is borrowed separately under the codec frame's pin/root rules.
uv_loop_t* GetRuntimeEventLoop(JSContext*, JS::HandleObject);
JSObject* GetRuntimeTimerInfo(JSContext*, JS::HandleObject, bool immediate);
// The canonical loop owns the actual async handle. Native producers may only
// send its wake token; attaching, ref changes and retirement stay foreground.
using RuntimeForegroundCallback = bool (*)(JSContext*, void*);
using RuntimeForegroundPending = bool (*)(void*);
void* AttachRuntimeForeground(JSContext*, JS::HandleObject, void*,
                              RuntimeForegroundCallback, RuntimeForegroundPending);
int SendRuntimeForeground(void*);
void DetachRuntimeForeground(JSContext*, JS::HandleObject, void*);
}  // namespace kandelo::node

#endif
