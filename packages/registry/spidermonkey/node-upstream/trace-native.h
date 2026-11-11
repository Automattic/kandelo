#ifndef KANDELO_NODE_TRACE_NATIVE_H
#define KANDELO_NODE_TRACE_NATIVE_H
#include <memory>
#include <v8-platform.h>

#include "js/TypeDecls.h"
#include "shell/node-upstream/trace-shutdown.h"
namespace node::tracing {
class Agent;
}
namespace kandelo::node {
struct TraceProcess;
std::shared_ptr<TraceProcess>
GetTraceProcess(JSContext*, JS::HandleObject realm);
bool
CheckTraceProcessActive(JSContext*, const std::shared_ptr<TraceProcess>&);
::node::tracing::Agent*
GetTraceAgent(const std::shared_ptr<TraceProcess>&);
void
RegisterTraceObserver(const std::shared_ptr<TraceProcess>&,
                      v8::TracingController::TraceStateObserver*);
void
RemoveTraceObserver(const std::shared_ptr<TraceProcess>&,
                    v8::TracingController::TraceStateObserver*);
} // namespace kandelo::node
#endif
