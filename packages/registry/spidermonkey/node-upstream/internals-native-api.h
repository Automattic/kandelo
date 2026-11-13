#ifndef KANDELO_NODE_INTERNALS_NATIVE_API_H
#define KANDELO_NODE_INTERNALS_NATIVE_API_H
#pragma push_macro("node")
#pragma push_macro("v8")
#undef node
#undef v8
// Whole node_internals.h owns the Buffer/allocator/helper bodies. These are
// declarations for its unactivated embedding/serialization dependencies only;
// activating an unavailable operation still requires an actual implementation.
#include <atomic>
#include <ctime>
#include <ostream>
#include <signal.h>
#include <unordered_map>
#include "shell/node-upstream/resource-native-api.h"
#include "shell/node-upstream/trace-native.h"
#ifndef __POSIX__
#define __POSIX__ 1
#endif
namespace kandelo_node_codec_api {
class IsolateGroup;class HeapSnapshot;
class HeapProfiler {public:struct HeapSnapshotOptions;};
}
namespace kandelo_node_codec_impl {
class ArrayBufferAllocator:public ArrayBuffer::Allocator {
 public:static std::unique_ptr<ArrayBufferAllocator> Create(bool=false);
 private:virtual NodeArrayBufferAllocator* GetImpl()=0;friend class IsolateData;
};
class MultiIsolatePlatform;
class InitializationResult {
 public:virtual ~InitializationResult()=default;
  virtual int exit_code()const=0;virtual bool early_return()const=0;
  virtual const std::vector<std::string>& args()const=0;
  virtual const std::vector<std::string>& exec_args()const=0;
  virtual const std::vector<std::string>& errors()const=0;
  virtual MultiIsolatePlatform* platform()const=0;
};
// The complete settings/configuration API is not implemented. An undefined
// constructor permits declaration of the original default argument while
// preventing an active native isolate-creation path from linking.
struct IsolateSettings {IsolateSettings();};
struct StartExecutionCallbackInfoWithModule;
using StartExecutionCallbackWithModule=std::function<MaybeLocal<Value>(const StartExecutionCallbackInfoWithModule&)>;
struct node_module;struct napi_module;struct PropInfo;struct EnvSerializeInfo;struct SnapshotMetadata;
class ImmediateInfo {public:struct SerializeInfo;};
class TickInfo {public:struct SerializeInfo;};
namespace performance {class PerformanceState {public:struct SerializeInfo;};}
}
#define node kandelo_node_codec_impl
#define v8 kandelo_node_codec_api
#include "shell/node-upstream/internals-upstream/node_internals.h"
#undef v8
#undef node
#pragma pop_macro("v8")
#pragma pop_macro("node")
#endif
