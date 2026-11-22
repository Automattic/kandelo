#ifndef KANDELO_NATIVE_OBJECT_API_H
#define KANDELO_NATIVE_OBJECT_API_H

// Original ownership classes and algorithms share the engine's actual
// persistent handles/internal fields. Only embedding bookkeeping lives here.
#pragma push_macro("node")
#undef node
#define node kandelo_node_codec_impl
#include "shell/node-upstream/resource-upstream/memory_tracker.h"
namespace node {
// This declaration cannot produce a cppgc wrapper. Its implementation remains
// unavailable while the non-cppgc BaseObject ownership path is integrated.
class CppgcMixin : public MemoryRetainer {
 public:virtual Local<Object> object(Isolate*)const=0;
};
}
#include "shell/node-upstream/resource-upstream/base_object.h"
#include "shell/node-upstream/resource-upstream/base_object-inl.h"
#include "shell/node-upstream/resource-upstream/memory_tracker-inl.h"
#include "shell/node-upstream/resource-upstream/cleanup_queue.h"
#include "shell/node-upstream/resource-upstream/cleanup_queue-inl.h"
#include "shell/node-upstream/codecs-upstream/base_object_types.h"
namespace node { enum class SnapshotFlags : uint32_t;struct SnapshotConfig; }
#include "shell/node-upstream/codecs-upstream/node_snapshotable.h"
#undef node
#pragma pop_macro("node")

namespace kandelo_node_codec_impl {
template<class T> bool Unwrap(T** output,Local<Object> object){
  *output=static_cast<T*>(UnwrapCodecObject(object));return *output!=nullptr;
}
template<class T,class... Args> T* Realm::AddBindingData(Local<Object> target,Args&&... args) {
  auto item=std::make_unique<T>(this,target,std::forward<Args>(args)...);
  item->MakeWeak();auto* result=item.get();
  InstallBindingRaw(size_t(T::binding_type_int),result);item.release();return result;
}
}
namespace kandelo_diagnostics_adapter {
using namespace v8;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
using IsolateInitializer=void(*)(kandelo_node_codec_impl::IsolateData*,Local<ObjectTemplate>);
extern Initializer initializer;
extern IsolateInitializer isolate_initializer;
}
#ifndef USE
#define USE(value) ((void)(value))
#endif
#endif
