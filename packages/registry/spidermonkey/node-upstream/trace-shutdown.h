#ifndef KANDELO_NODE_TRACE_SHUTDOWN_H
#define KANDELO_NODE_TRACE_SHUTDOWN_H
namespace kandelo::node {
// Main shell teardown, before destroying JS contexts or the libuv pool.
void
ShutdownTraceProcess();
}
#endif
