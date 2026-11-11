#ifndef KANDELO_NODE_PER_CONTEXT_H
#define KANDELO_NODE_PER_CONTEXT_H

#include "js/RootingAPI.h"
#include "js/TypeDecls.h"

namespace kandelo::node {

// The embedding owns this persistent root and destroys it before its JSContext.
// One shell context is one guest runtime; child realms reuse this same owner.
JSObject* EnsureRuntimeState(JSContext* cx, JS::PersistentRootedObject& owner);

// Caller must already have entered the intended realm. Initialization is once
// per actual global; repeated explicit initialization rejects. Allocation before
// publishing the canonical carrier can retry; any later failure is terminal.
bool InitializeCurrentContext(JSContext* cx, JS::HandleObject runtime);
JSObject* GetCurrentContextExports(JSContext* cx, JS::HandleObject runtime);
JSObject* GetCurrentContextErrorStackState(JSContext* cx, JS::HandleObject runtime);
JSObject* GetCurrentContextModuleWrapBinding(JSContext* cx, JS::HandleObject runtime);
JS::Symbol* GetRuntimeSymbol(JSContext* cx, JS::HandleObject runtime, const char* name);
JSObject* CreateRuntimePrivateSymbolTable(JSContext* cx, JS::HandleObject runtime);
bool InitializeCurrentRealmLibrary(JSContext* cx, JS::HandleObject runtime);
JSObject* GetCurrentRealmLibrary(JSContext* cx, JS::HandleObject runtime, bool inspect);

// Privileged diagnostics return a snapshot, never the canonical carrier/key.
JSObject* InspectCurrentContextForTesting(JSContext* cx, JS::HandleObject runtime);

}  // namespace kandelo::node

#endif
