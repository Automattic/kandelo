#ifndef KANDELO_NODE_TIMERS_H
#define KANDELO_NODE_TIMERS_H

#include <cstdint>

#include "js/TypeDecls.h"

namespace kandelo::node {
bool ReadGuestMonotonicMillis(JSContext* cx, uint64_t* result);
JSObject* CreateRuntimeTimerState(JSContext* cx, double base);
JSObject* CreateTimersBinding(JSContext* cx, JS::HandleObject runtime,
                             JS::HandleObject realm, JS::HandleObject process);
// No public adapter hooks. The caller owns actual engine microtask checkpoints.
bool DispatchRuntimeTimers(JSContext* cx, JS::HandleObject runtime,
                           bool externalReferences, int* dispatched,
                           int64_t* nextDelay);
JSObject* InspectRuntimeTimers(JSContext* cx, JS::HandleObject runtime);
}  // namespace kandelo::node

#endif
