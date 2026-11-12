#ifndef KANDELO_NATIVE_OBJECT_API_H
#define KANDELO_NATIVE_OBJECT_API_H

// Whole upstream metadata/declarations, backed by real engine native owners.
// Snapshot construction remains unavailable; no snapshot payload is emitted.
#define node kandelo_node_codec_impl
#define v8 kandelo_node_codec_api
#include "shell/node-upstream/codecs-upstream/base_object_types.h"
namespace node { enum class SnapshotFlags : uint32_t;struct SnapshotConfig; }
#include "shell/node-upstream/codecs-upstream/node_snapshotable.h"
#undef v8
#undef node

namespace kandelo_node_codec_impl {
template<class T> class BaseObjectPtr;
template<class T,class... Args> BaseObjectPtr<T> MakeDetachedBaseObject(Args&&...);
template<class T> class BaseObjectPtr {
  template<class U> friend class BaseObjectPtr;
  template<class U,class... Args> friend BaseObjectPtr<U> MakeDetachedBaseObject(Args&&...);
  std::shared_ptr<T> value_;
 public:
  BaseObjectPtr()=default;
  BaseObjectPtr(const BaseObjectPtr&)=default;
  BaseObjectPtr(BaseObjectPtr&&)=default;
  BaseObjectPtr& operator=(const BaseObjectPtr&)=default;
  BaseObjectPtr& operator=(BaseObjectPtr&&)=default;
  // Alias the canonical native cell; raw acquisition never creates a second
  // deleting owner and derived/base references share the same lifetime.
  explicit BaseObjectPtr(T* value) {
    if(value)value_=std::shared_ptr<T>(value->AcquireNativeReference(),value);
  }
  BaseObjectPtr(std::nullptr_t){}
  template<class U> requires std::is_convertible_v<U*,T*>
  BaseObjectPtr(const BaseObjectPtr<U>& other):value_(other.value_){}
  void reset(T* value=nullptr){*this=BaseObjectPtr(value);}
  T* get()const{return value_.get();}
  T* operator->()const{return get();}
  T& operator*()const{return *get();}
  explicit operator bool()const{return bool(value_);}
};
template<class T,class... Args> BaseObjectPtr<T> MakeDetachedBaseObject(Args&&... args) {
  // A detached native reference owns the native object and its actual wrapper.
  // The last C++ reference clears the wrapper's native pointer on destruction.
  BaseObjectPtr<T> result(new T(std::forward<Args>(args)...));
  result->ClearWeak();result->Detach();return result;
}
template<class T,class... Args> T* Realm::AddBindingData(Local<Object> target,Args&&... args) {
  auto item=std::make_unique<T>(this,target,std::forward<Args>(args)...);
  item->MakeWeak();auto* result=item.get();
  InstallBindingRaw(size_t(T::binding_type_int),result);item.release();return result;
}
}
namespace kandelo_diagnostics_adapter {
using namespace kandelo_node_codec_api;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
using IsolateInitializer=void(*)(kandelo_node_codec_impl::IsolateData*,Local<ObjectTemplate>);
extern Initializer initializer;
extern IsolateInitializer isolate_initializer;
}
#ifndef USE
#define USE(value) ((void)(value))
#endif
#endif
