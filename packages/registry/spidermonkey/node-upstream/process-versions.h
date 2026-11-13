#ifndef KANDELO_NODE_PROCESS_VERSIONS_H
#define KANDELO_NODE_PROCESS_VERSIONS_H

#include <string>
#include <utility>
#include <vector>

#include "js/TypeDecls.h"

namespace kandelo::node {
using NativeVersionRows = std::vector<std::pair<std::string, std::string>>;
// Shared actual data provider for process properties and native tracing.
bool ReadNativeProcessVersions(JSContext* cx, NativeVersionRows* rows);
// Metadata belongs only to the initial realm process, not constructor instances.
bool InitializeProcessVersions(JSContext* cx, JS::HandleObject process);
}

#endif
