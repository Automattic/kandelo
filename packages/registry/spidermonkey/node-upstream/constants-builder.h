#ifndef KANDELO_NODE_CONSTANTS_BUILDER_H
#define KANDELO_NODE_CONSTANTS_BUILDER_H

// A private property-builder bridge for the complete original constants.cc.
// These local names adapt only its declaration API to real rooted JS objects;
// they are not a V8 engine, resource handles or a general Node Environment.
#include "mozilla/Assertions.h"
#include <cstring>
#include <memory>
#include <openssl/opensslv.h>
#include <uv.h>
#include <vector>

#include "js/Object.h"
#include "js/RootingAPI.h"
#include "js/TypeDecls.h"
#include "shell/node-upstream/constants-upstream/trace_event_legacy.h"

#define NODE_WANT_INTERNALS 1
// This recipe declares and links OpenSSL, and Kandelo is a POSIX target.
#define HAVE_OPENSSL 1
#define __POSIX__ 1

namespace v8 {
class Object;
struct Value {};
struct NullValue {};
struct Context { JSContext* cx; };
template<class T> class Local {
  T* pointer_ = nullptr;
 public:
  Local() = default;
  explicit Local(T* pointer) : pointer_(pointer) {}
  T* operator->() const { MOZ_RELEASE_ASSERT(pointer_); return pointer_; }
};
class Result {
  bool success_;
 public:
  explicit Result(bool success) : success_(success) {}
  bool FromJust() const { return success_; }
  void Check() const { MOZ_RELEASE_ASSERT(success_, "Original Node constant property invariant"); }
};
class Isolate {
  Context context_;
  std::vector<std::unique_ptr<Object>> objects_;
  Isolate* previous_;
  inline static thread_local Isolate* current_ = nullptr;
 public:
  explicit Isolate(JSContext* cx) : context_{cx}, previous_(current_) { current_ = this; }
  ~Isolate() { current_ = previous_; }
  static Isolate* GetCurrent() { MOZ_RELEASE_ASSERT(current_); return current_; }
  Local<Context> GetCurrentContext() { return Local<Context>(&context_); }
  Local<Object> Own(JS::HandleObject object);
};
inline NullValue Null(Isolate*) { return {}; }
class Object {
  JS::PersistentRootedObject object_;
 public:
  Object(JSContext* cx, JS::HandleObject object) : object_(cx, object) {}
  JSObject* Get() const { return object_; }
  static Local<Object> New(Isolate* isolate, NullValue, void* keys, void* values, size_t length);
  Result SetPrototypeV2(Local<Context> context, NullValue);
  Result Set(Local<Context> context, const char* name, Local<Object> value);
  void DefineNumber(const char* name, double number);
  void DefineString(const char* name, const char* text);
};
inline Local<Object> Isolate::Own(JS::HandleObject object) {
  objects_.push_back(std::make_unique<Object>(context_.cx, object));
  return Local<Object>(objects_.back().get());
}
}  // namespace v8
namespace node {
class Environment {
 public:
  static Environment* GetCurrent(v8::Local<v8::Context>) { static Environment owner; return &owner; }
  v8::Local<v8::Context> context() { return v8::Isolate::GetCurrent()->GetCurrentContext(); }
  const char* errno_string() { return "errno"; }
};
void DefineZlibConstants(v8::Local<v8::Object> target);
}  // namespace node
namespace kandelo::node::constantbuilder {
using Initializer = void (*)(v8::Local<v8::Object>, v8::Local<v8::Value>, v8::Local<v8::Context>, void*);
extern Initializer initializer;
extern const char* moduleName;
}
#define CHECK(condition) MOZ_RELEASE_ASSERT(condition, "Original Node constants assertion")
#define FIXED_ONE_BYTE_STRING(isolate, text) text
#define NODE_DEFINE_CONSTANT(target, constant) (target)->DefineNumber(#constant, static_cast<double>(constant))
#define NODE_DEFINE_STRING_CONSTANT(target, name, constant) (target)->DefineString(name, constant)
#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(name, callback) \
  namespace kandelo::node::constantbuilder { Initializer initializer = ::callback; const char* moduleName = #name; }
#endif
