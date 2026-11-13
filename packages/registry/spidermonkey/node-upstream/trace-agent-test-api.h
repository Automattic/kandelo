#ifndef KANDELO_NODE_TRACE_AGENT_TEST_API_H
#define KANDELO_NODE_TRACE_AGENT_TEST_API_H
#include "js/TypeDecls.h"
namespace kandelo::node {
// Available only through the shell's explicit --kandelo-test-upstream surface.
bool
DefineTraceAgentTestAPI(JSContext*, JS::HandleObject);
} // namespace kandelo::node
#endif
