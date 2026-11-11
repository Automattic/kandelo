#include "shell/node-upstream/trace-agent-test-api.h"

#include <fstream>
#include <iterator>
#include <string>
#include <unistd.h>

#include "jsapi.h"

#include "js/CallArgs.h"
#include "js/CharacterEncoding.h"
#include "js/PropertyAndElement.h"
#include "js/RootingAPI.h"
#include "js/String.h"
#include "js/Wrapper.h"
#include "shell/jsshell.h"
#include "shell/node-upstream/codecs.h"
#include "shell/node-upstream/options.h"
#include "shell/node-upstream/per-context.h"
#include "shell/node-upstream/trace-agent-native-api.h"
#include "shell/node-upstream/trace-native.h"
#include "shell/node-upstream/tracing-upstream/tracing/agent.h"
#include "shell/node-upstream/tracing-upstream/tracing/trace_event_helper.h"

namespace kandelo::node {
namespace {
std::string exitPath;
bool exitReaderArmed = false;

bool
ReadTraceFile(std::string* bytes)
{
  std::ifstream input(exitPath);
  if (!input.good())
    return false;
  bytes->assign(std::istreambuf_iterator<char>(input), {});
  return !input.bad();
}

void
ReadAtExit()
{
  // This observes the explicit main-thread shutdown after JS has finished.
  // It never calls JS or reaches into the host's filesystem.
  CHECK_NULL(::node::tracing::Agent::GetInstance());
  std::string bytes;
  CHECK(ReadTraceFile(&bytes));
  std::printf("TRACE_AGENT_EXIT %s\n", bytes.c_str());
  std::fflush(stdout);
}

bool
AgentControl(JSContext* cx, unsigned argc, JS::Value* vp)
{
  auto args = JS::CallArgsFromVp(argc, vp);
  if (argc != 1 || !args[0].isString()) {
    JS_ReportErrorASCII(cx,
                        "Native tracing control requires an operation string");
    return false;
  }
  JS::RootedString operation(cx, args[0].toString());
  auto encoded = JS_EncodeStringToUTF8(cx, operation);
  if (!encoded)
    return false;
  std::string name(encoded.get());
  if (name == "stop") {
    // This privileged fixture control must not destroy the source agent while
    // its tracing intrinsic or observer is still executing on this stack.
    if (TraceNativeCallIsActive()) {
      JS_ReportErrorASCII(cx, "Native tracing test teardown requires an idle native stack");
      return false;
    }
    ShutdownTraceProcess();
    std::string bytes;
    if (!ReadTraceFile(&bytes)) {
      JS_ReportErrorASCII(
        cx, "Native tracing control could not read the guest trace file");
      return false;
    }
    JS::RootedString result(
      cx, JS_NewStringCopyUTF8N(cx, JS::UTF8Chars(bytes.data(), bytes.size())));
    if (!result)
      return false;
    args.rval().setString(result);
    return true;
  }
  if (name != "start" && name != "armExit") {
    JS_ReportErrorASCII(cx, "Unknown native tracing control operation");
    return false;
  }
  JS::RootedObject runtime(cx,
                           js::shell::GetShellContext(cx)->upstreamNodeRuntime);
  JS::RootedObject realm(cx, GetRuntimePrincipalRealm(cx, runtime));
  if (!realm)
    return false;
  realm = js::CheckedUnwrapDynamic(realm, cx, false);
  if (!realm)
    return false;
  auto owner = GetTraceProcess(cx, realm);
  if (!owner)
    return false;
  NativeTracingConfiguration configuration;
  if (!ReadNativeTracingConfiguration(cx, realm, &configuration))
    return false;
  exitPath = ::node::tracing::GetTraceFilePath(configuration.filePattern, 1);
  auto* agent = GetTraceAgent(owner);
  auto* controller = agent->GetTracingController();
  const auto* flag = controller->GetCategoryGroupEnabled("node.native_probe");
  if (*flag) {
    controller->AddTraceEvent('i',
                              flag,
                              "native-engine-agent-probe",
                              "",
                              0,
                              0,
                              0,
                              nullptr,
                              nullptr,
                              nullptr,
                              nullptr,
                              1);
  }
  if (name == "armExit" && !exitReaderArmed) {
    CHECK_EQ(std::atexit(ReadAtExit), 0);
    exitReaderArmed = true;
  }
  JS::RootedObject snapshot(cx, JS_NewPlainObject(cx));
  JS::RootedString path(cx, JS_NewStringCopyZ(cx, exitPath.c_str()));
  auto categories = agent->GetEnabledCategories();
  JS::RootedString categoryString(cx,
                                  JS_NewStringCopyZ(cx, categories.c_str()));
  JS::RootedValue enabled(cx, JS::BooleanValue(*flag != 0));
  if (!snapshot || !path || !categoryString ||
      !JS_DefineProperty(cx, snapshot, "path", path, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(
        cx, snapshot, "categories", categoryString, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(
        cx, snapshot, "enabled", enabled, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, snapshot, "pid", getpid(), JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, snapshot, "tid", gettid(), JSPROP_ENUMERATE))
    return false;
  args.rval().setObject(*snapshot);
  return true;
}
} // namespace

bool
DefineTraceAgentTestAPI(JSContext* cx, JS::HandleObject api)
{
  return JS_DefineFunction(cx, api, "traceAgent", AgentControl, 1, 0);
}
} // namespace kandelo::node
