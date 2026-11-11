#ifndef KANDELO_NODE_PROCESS_VERSIONS_H
#define KANDELO_NODE_PROCESS_VERSIONS_H

#include "js/TypeDecls.h"

namespace kandelo::node {
// Metadata belongs only to the initial realm process, not constructor instances.
bool InitializeProcessVersions(JSContext* cx, JS::HandleObject process);
}

#endif
