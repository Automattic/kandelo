#ifndef KANDELO_NODE_TRACE_AGENT_NATIVE_API_H
#define KANDELO_NODE_TRACE_AGENT_NATIVE_API_H
#include <bit>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <libplatform/v8-tracing.h>
#include <memory>
#include <string>
#include <utility>
#include <uv.h>
#include <vector>

#include "shell/node-upstream/tracing-upstream/node_version.h"
namespace node {
[[noreturn]] void
TraceInvariant(const char*, const char*, int);
template<class T, size_t N>
constexpr size_t
arraysize(T (&)[N])
{
  return N;
}
template<class Outer, class Inner>
Outer*
ContainerOf(Inner Outer::* member, Inner* value)
{
  // wasm32 clang uses the Itanium data-member-pointer ABI: an offset from the
  // containing object. The native agent's async callbacks exercise this path.
  static_assert(sizeof(member) == sizeof(ptrdiff_t));
  ptrdiff_t offset = std::bit_cast<ptrdiff_t>(member);
  return reinterpret_cast<Outer*>(reinterpret_cast<char*>(value) - offset);
}
inline void
CheckedUvLoopClose(uv_loop_t* loop)
{
  int status = uv_loop_close(loop);
  if (status)
    TraceInvariant("uv_loop_close", __FILE__, __LINE__);
}
std::string
GetProcessTitle(const char* fallback);
struct TraceVersions
{
  std::string node;
  std::vector<std::pair<std::string, std::string>> values;
  const auto& pairs() const { return values; }
};
struct TraceMetadata
{
  TraceVersions versions;
  std::string arch, platform;
  struct
  {
    std::string name, lts;
  } release;
};
struct TraceOptions
{
  std::string trace_event_file_pattern, trace_event_categories;
};
namespace per_process {
extern TraceMetadata metadata;
extern const TraceOptions* cli_options;
} // namespace per_process
void ConfigureTraceInputs(TraceMetadata, TraceOptions);
} // namespace node
#define NODE_WANT_INTERNALS 1
#define NODE_HAVE_I18N_SUPPORT 1
#define CHECK(x)                                                               \
  do {                                                                         \
    if (!(x))                                                                  \
      ::node::TraceInvariant(#x, __FILE__, __LINE__);                          \
  } while (false)
#define CHECK_EQ(a, b) CHECK((a) == (b))
#define CHECK_NE(a, b) CHECK((a) != (b))
#define CHECK_GE(a, b) CHECK((a) >= (b))
#define CHECK_NULL(a) CHECK((a) == nullptr)
#define CHECK_NOT_NULL(a) CHECK((a) != nullptr)
#define UNREACHABLE() ::node::TraceInvariant("UNREACHABLE", __FILE__, __LINE__)
#endif
