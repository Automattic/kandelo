#ifndef KANDELO_NODE_PRIVATE_KEY_TEST_API_H
#define KANDELO_NODE_PRIVATE_KEY_TEST_API_H

#include "js/TypeDecls.h"

namespace kandelo::node {

// Install only for the explicitly requested privileged JS-shell diagnostic.
// Node startup and ordinary shell invocations must not expose these controls.
bool DefinePrivateKeyTestAPI(JSContext* cx);

}  // namespace kandelo::node

#endif
