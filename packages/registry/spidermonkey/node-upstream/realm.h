#ifndef KANDELO_NODE_REALM_H
#define KANDELO_NODE_REALM_H

#include "js/TypeDecls.h"

namespace kandelo::node {
// Allocation does not run JS. Publish in the canonical context before Run.
JSObject* AllocateRealmLibraryState(JSContext* cx);
bool RunRealmLibrary(JSContext* cx, JS::HandleObject state,
                     JS::HandleObject primordials);
bool RejectRepeatedRealmLibraryInitialization(JSContext* cx, JS::HandleObject state);
// Executes only the original node.js body, not web/switches/bootstrap completion.
bool RunNodeBootstrap(JSContext* cx, JS::HandleObject state);
JSObject* RealmLibrarySnapshot(JSContext* cx, JS::HandleObject state, bool inspect);
}  // namespace kandelo::node

#endif
