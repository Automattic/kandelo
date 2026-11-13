#include "shell/node-upstream/trace-native.h"
#include <cerrno>
#include <cstring>
#include <set>
#include <sys/utsname.h>
#include <unistd.h>

#include "jsapi.h"
#include "shell/node-upstream/options.h"
#include "shell/node-upstream/process-versions.h"
#include "shell/node-upstream/realm.h"
#include "shell/node-upstream/trace-agent-native-api.h"
#include "shell/node-upstream/tracing-upstream/tracing/agent.h"

namespace kandelo::node {
struct TraceProcess
{
  NativeTracingConfiguration configuration;
  std::unique_ptr<::node::tracing::Agent, ::node::tracing::Agent::Deleter>
    agent;
  std::set<v8::TracingController::TraceStateObserver*> observers;
  int mainThread = gettid();
  bool closed = false;
};
namespace {
std::shared_ptr<TraceProcess> process;
bool stopped = false;
bool
Failure(JSContext* cx, const char* text)
{
  JS_ReportErrorASCII(cx, "%s", text);
  return false;
}
} // namespace
bool
CheckTraceProcessActive(JSContext* cx,
                        const std::shared_ptr<TraceProcess>& owner)
{
  if (!owner || owner->closed || !owner->agent)
    return Failure(cx, "Native tracing process has shut down");
  if (owner->mainThread != gettid())
    return Failure(cx,
                   "Native tracing binding requires its owning engine thread");
  return true;
}
std::shared_ptr<TraceProcess>
GetTraceProcess(JSContext* cx, JS::HandleObject realm)
{
  if (!CheckRealmLibraryActive(cx, realm))
    return {};
  if (stopped) {
    Failure(cx, "Native tracing process has shut down");
    return {};
  }
  NativeTracingConfiguration configuration;
  if (!ReadNativeTracingConfiguration(cx, realm, &configuration))
    return {};
  if (configuration.permissionsEnabled) {
    Failure(cx, "Native tracing permission-policy adoption is not implemented");
    return {};
  }
  if (process) {
    if (!CheckTraceProcessActive(cx, process))
      return {};
    if (process->configuration.filePattern != configuration.filePattern ||
        process->configuration.categories != configuration.categories) {
      Failure(
        cx,
        "Native tracing configuration changed after process initialization");
      return {};
    }
    return process;
  }
  NativeVersionRows versions;
  if (!ReadNativeProcessVersions(cx, &versions))
    return {};
  ::node::TraceMetadata metadata;
  metadata.versions.values = versions;
  metadata.versions.node = versions.front().second;
  static_assert(sizeof(void*) == 4);
  struct utsname system;
  if (uname(&system) != 0) {
    JS_ReportErrorASCII(cx, "Guest uname failed: %s", std::strerror(errno));
    return {};
  }
  metadata.arch = system.machine;
  metadata.platform = system.sysname;
  metadata.release.name = "node";
  metadata.release.lts = NODE_VERSION_LTS_CODENAME;
  ::node::ConfigureTraceInputs(
    std::move(metadata),
    { configuration.filePattern, configuration.categories });
  auto owner = std::make_shared<TraceProcess>();
  owner->configuration = std::move(configuration);
  owner->agent = ::node::tracing::Agent::CreateDefault();
  process = owner;
  if (!owner->configuration.categories.empty())
    owner->agent->StartTracing(owner->configuration.categories);
  return owner;
}
::node::tracing::Agent*
GetTraceAgent(const std::shared_ptr<TraceProcess>& owner)
{
  return owner->agent.get();
}
void
RegisterTraceObserver(const std::shared_ptr<TraceProcess>& owner,
                      v8::TracingController::TraceStateObserver* observer)
{
  CHECK(!owner->closed && owner->agent);
  CHECK(owner->mainThread == gettid());
  CHECK(owner->observers.insert(observer).second);
  owner->agent->AddTraceStateObserver(observer);
}
void
RemoveTraceObserver(const std::shared_ptr<TraceProcess>& owner,
                    v8::TracingController::TraceStateObserver* observer)
{
  if (owner->observers.erase(observer))
    owner->agent->RemoveTraceStateObserver(observer);
}
void
ShutdownTraceProcess()
{
  stopped = true;
  if (!process || process->closed)
    return;
  CHECK(process->mainThread == gettid());
  process->closed = true;
  for (auto* observer : process->observers)
    process->agent->RemoveTraceStateObserver(observer);
  process->observers.clear();
  // No JS observer remains when the source flushes and joins its worker.
  process->agent.reset();
}
} // namespace kandelo::node
