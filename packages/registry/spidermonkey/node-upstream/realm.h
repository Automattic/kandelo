#ifndef KANDELO_NODE_REALM_H
#define KANDELO_NODE_REALM_H

#include "js/TypeDecls.h"

namespace kandelo::node {
enum class SnapshotCallback { Serialize, Deserialize, Main };
bool GetSnapshotCallback(JSContext*,JS::HandleObject,SnapshotCallback,JS::MutableHandleValue);
bool SetSnapshotCallback(JSContext*,JS::HandleObject,SnapshotCallback,JS::HandleValue);
bool ClearSnapshotCallbacks(JSContext*,JS::HandleObject);
bool GetMessagingDeserializer(JSContext*,JS::HandleObject,JS::MutableHandleValue);
bool SetMessagingDeserializer(JSContext*,JS::HandleObject,JS::HandleValue);
bool ClearMessagingDeserializer(JSContext*,JS::HandleObject);
bool CallMessagingDeserializer(JSContext*,JS::HandleObject,JS::HandleString,JS::MutableHandleValue);
bool RequireRealmBuiltin(JSContext*,JS::HandleObject,JS::HandleValue,JS::MutableHandleValue);
// Allocation does not run JS. Publish in the canonical context before Run.
JSObject* AllocateRealmLibraryState(JSContext* cx);
bool SetRealmBufferPrototype(JSContext*,JS::HandleObject,JS::HandleObject);
JSObject* GetRealmBufferPrototype(JSContext*,JS::HandleObject);
bool RunRealmLibrary(JSContext* cx, JS::HandleObject state,
                     JS::HandleObject primordials);
bool RejectRepeatedRealmLibraryInitialization(JSContext* cx, JS::HandleObject state);
// Executes only the original node.js body, not web/switches/bootstrap completion.
bool RunNodeBootstrap(JSContext* cx, JS::HandleObject state);
bool CheckRealmLibraryActive(JSContext* cx, JS::HandleObject state);
bool RealmLibraryIsFailed(JSObject* state);
JSObject* GetRealmRuntime(JSContext* cx, JS::HandleObject state);
JSObject* GetRealmSafeMapPrototype(JSContext* cx, JS::HandleObject state);
bool HasCompletedNodeBootstrap(JSContext* cx, JS::HandleObject state);
JSObject* RealmLibrarySnapshot(JSContext* cx, JS::HandleObject state, bool inspect);
}  // namespace kandelo::node

#endif
