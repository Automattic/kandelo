#ifndef KANDELO_ENGINE_GC_API_H
#define KANDELO_ENGINE_GC_API_H

// Source interfaces consumed by Node's two Contextify allocation types. The
// collector is SpiderMonkey; no Oilpan heap, JS holder or second GC is created.
#include <cstddef>
#include <memory>
#include <new>
#include <utility>
#include "js/TracingAPI.h"
#include "v8-source-api/cppgc-heap-statistics.h"

namespace v8 {
class CppHeap;
template<class T> class TracedReference;
}
namespace cppgc {
class Visitor {
  JSTracer* tracer_;
 public:
  explicit Visitor(JSTracer* tracer):tracer_(tracer){}
  template<class T> void Trace(const v8::TracedReference<T>& value)const {
    value.Trace(tracer_);
  }
};
namespace internal {
struct NativeAllocation;
using NativeTrace=void(*)(void*,Visitor*);
using NativeDestroy=void(*)(void*);
bool NativeAllocationIsAlive(const std::shared_ptr<NativeAllocation>&);
class AllocationMember {
  std::weak_ptr<NativeAllocation> allocation_;
 protected:
  AllocationMember();
 public:
  std::shared_ptr<NativeAllocation> NativeAllocationControl()const{return allocation_.lock();}
};
}
template<class T> class GarbageCollected:public internal::AllocationMember {
 protected:
  GarbageCollected()=default;
};
class GarbageCollectedMixin:public internal::AllocationMember {
 public:
  virtual ~GarbageCollectedMixin()=default;
  virtual void Trace(Visitor*)const=0;
};
class NameProvider {
 public:
  virtual ~NameProvider()=default;
  virtual const char* GetHumanReadableName()const=0;
};
class AllocationHandle {
  v8::CppHeap* heap_;
 public:
  explicit AllocationHandle(v8::CppHeap* heap):heap_(heap){}
  v8::CppHeap* NativeHeap()const{return heap_;}
};
namespace internal {
// The lease exists before any C++ base/member constructor. A failed constructor
// unwinds its own bases/members; the lease then removes the JS association and
// releases storage without invoking that partially constructed destructor twice.
class Construction {
  std::shared_ptr<NativeAllocation> allocation_,previous_;
  bool complete_=false;
 public:
  Construction(AllocationHandle&,size_t,size_t,NativeTrace,NativeDestroy);
  ~Construction();
  void* Storage()const;
  void Complete();
  Construction(const Construction&)=delete;
  Construction& operator=(const Construction&)=delete;
};
}
template<class T,class... Args>
T* MakeGarbageCollected(AllocationHandle& handle,Args&&... args){
  internal::Construction construction(handle,sizeof(T),alignof(T),
      [](void* raw,Visitor* visitor){static_cast<T*>(raw)->Trace(visitor);},
      [](void* raw){static_cast<T*>(raw)->~T();});
  T* result=::new(construction.Storage()) T(std::forward<Args>(args)...);
  construction.Complete();return result;
}
template<class T> class WeakPersistent {
  std::shared_ptr<internal::NativeAllocation> allocation_;
  T* pointer_=nullptr;
 public:
  WeakPersistent()=default;
  WeakPersistent(std::nullptr_t){}
  explicit WeakPersistent(T* pointer){Reset(pointer);}
  void Reset(T* pointer=nullptr){
    allocation_=pointer?static_cast<const GarbageCollectedMixin*>(pointer)->NativeAllocationControl():nullptr;
    pointer_=pointer;
  }
  T* Get()const{return internal::NativeAllocationIsAlive(allocation_)?pointer_:nullptr;}
  T* operator->()const{return Get();}
  explicit operator bool()const{return Get()!=nullptr;}
};
}
#endif
