#include "shell/node-upstream/trace-agent-native-api.h"
#include "shell/node-upstream/tracing-upstream/tracing/agent.h"
namespace kandelo_node_codec_impl {std::string GetProcessTitle(const char*);}
namespace node {
[[noreturn]] void
TraceInvariant(const char* expression, const char* file, int line)
{
  std::fprintf(
    stderr, "Native trace invariant: %s at %s:%d\n", expression, file, line);
  std::fflush(stderr);
  __builtin_trap();
}
namespace {
TraceOptions options;
}
namespace per_process {
TraceMetadata metadata;
const TraceOptions* cli_options = nullptr;
} // namespace per_process
void
ConfigureTraceInputs(TraceMetadata metadata, TraceOptions supplied)
{
  CHECK_NULL(tracing::Agent::GetInstance());
  CHECK(!metadata.versions.node.empty());
  CHECK(!metadata.arch.empty());
  CHECK(!metadata.platform.empty());
  per_process::metadata = std::move(metadata);
  options = std::move(supplied);
  per_process::cli_options = &options;
}
std::string
GetProcessTitle(const char* fallback)
{
  return kandelo_node_codec_impl::GetProcessTitle(fallback);
}

} // namespace node
