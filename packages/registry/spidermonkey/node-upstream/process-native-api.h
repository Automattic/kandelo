#ifndef KANDELO_NODE_PROCESS_NATIVE_API_H
#define KANDELO_NODE_PROCESS_NATIVE_API_H
// Additional consumed contracts for the whole original process units. A declared
// operation without a backend must fail to link when activated; no empty queues,
// fabricated measurements or successful unsupported operations are supplied.
#include <climits>
#include <cstdio>
#include <pthread.h>
#include <sys/resource.h>
#include <termios.h>
#include <unistd.h>
#define node kandelo_node_codec_impl
#include "node-exit-code.h"
#undef node
#include "shell/node-upstream/codec-native-api.h"
#include "shell/node-upstream/codecs-upstream/node_mutex.h"
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/permission/permission_base.h"
#undef node
#include "shell/node-upstream/internals-native-api.h"
#include "shell/node-upstream/request-native-api.h"
namespace kandelo_node_codec_impl {
std::string GetProcessTitle(const char*);
namespace tracing=::node::tracing;
// The namespace-token adapter also changes an ordinary member named `node`.
// Forward that member to the actual shared native metadata; never copy V8 facts.
struct ProcessVersionsView {
  const std::string& kandelo_node_codec_impl=::node::per_process::metadata.versions.node;
  const auto& pairs() const {return ::node::per_process::metadata.versions.pairs();}
};
struct ProcessMetadataView {
  ProcessVersionsView versions;
  const std::string& arch=::node::per_process::metadata.arch;
  const std::string& platform=::node::per_process::metadata.platform;
  const decltype(::node::per_process::metadata.release)& release=::node::per_process::metadata.release;
};
namespace per_process {
inline const ProcessMetadataView metadata;
extern uint64_t node_start_time;
}
class ProcessImmediateInfo {
  Environment* environment_;
 public:
  explicit ProcessImmediateInfo(Environment* environment):environment_(environment) {}
  uint32_t ref_count() const;
};
class HandleWrap : public AsyncWrap {public:static bool HasRef(HandleWrap*);};
void RunAtExit(Environment*);bool HasSignalJSHandler(int);
bool CheckProcessPermission(Environment*,permission::PermissionScope,std::string_view);
namespace binding {
void DLOpen(const FunctionCallbackInfo<Value>&);
void DLOpenBinary(const FunctionCallbackInfo<Value>&);
}
BaseObject* UnwrapSnapshotable(Local<Object>,EmbedderObjectType);
template<class T> T* FromJSObject(Local<Object> object) {
  return static_cast<T*>(UnwrapSnapshotable(object,T::type_int));
}
}
namespace kandelo_process_methods_adapter {
using namespace kandelo_node_codec_api;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
using IsolateInitializer=void(*)(kandelo_node_codec_impl::IsolateData*,Local<ObjectTemplate>);
extern Initializer initializer;
extern IsolateInitializer isolate_initializer;
}

// Original formatting algorithms operate over the native byte/stream bridge.
// Other debug/inspection operations remain declarations until actually backed.
#ifndef NODE_EXTERN_PRIVATE
#define NODE_EXTERN_PRIVATE
#endif
#include "shell/node-upstream/codecs-upstream/process-support/async-provider-metadata.h"
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/process-support/debug_utils-inl.h"
#undef node
#undef v8

#define __POSIX__ 1
#define THROW_IF_INSUFFICIENT_PERMISSIONS(env,scope,path) \
 do {if(!kandelo_node_codec_impl::CheckProcessPermission(env,scope,path))return;}while(false)
#endif
