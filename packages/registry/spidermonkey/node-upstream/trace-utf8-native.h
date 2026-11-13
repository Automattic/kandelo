#ifndef KANDELO_NODE_TRACE_UTF8_NATIVE_H
#define KANDELO_NODE_TRACE_UTF8_NATIVE_H
#include <vector>
#include "js/TypeDecls.h"
namespace kandelo::node {
// Includes the terminating NUL. The complete upstream encoder preserves WTF-8.
bool EncodeTraceString(JSContext*, JS::HandleString, std::vector<char>*);
}
#endif
