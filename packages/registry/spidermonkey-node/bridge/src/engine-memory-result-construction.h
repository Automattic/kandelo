#ifndef KANDELO_ENGINE_MEMORY_RESULT_CONSTRUCTION_H
#define KANDELO_ENGINE_MEMORY_RESULT_CONSTRUCTION_H

#include "engine-native-api.h"
#include "engine-checks.h"

namespace v8::bridge {
// Only construction primitives live here. The original upstream result builder
// still owns field selection, ranges, grouping and property insertion order.
class NativeMemoryResultConstruction final {
 public:
  explicit NativeMemoryResultConstruction(Isolate* isolate) : isolate_(isolate) {}
  Local<Object> NewJSObject() { return Object::New(isolate_); }
  Local<Value> NewNumberFromSize(size_t value) { return Number::New(isolate_, value); }
  Local<Array> NewFixedArray(int length) { return Array::New(isolate_, length); }
  Local<Array> NewJSArrayWithElements(Local<Array> elements) { return elements; }
  Local<String> NewStringFromAsciiChecked(const char* name) {
    return String::NewFromUtf8(isolate_, name).ToLocalChecked();
  }
  Local<String> total_string() { return NewStringFromAsciiChecked("total"); }
  Local<String> current_string() { return NewStringFromAsciiChecked("current"); }
  Local<String> other_string() { return NewStringFromAsciiChecked("other"); }
  Local<String> jsMemoryEstimate_string() { return NewStringFromAsciiChecked("jsMemoryEstimate"); }
  Local<String> jsMemoryRange_string() { return NewStringFromAsciiChecked("jsMemoryRange"); }
  void SetElement(Local<Array> array, int index, Local<Value> value) {
    CHECK(array->CreateDataProperty(isolate_->GetCurrentContext(), uint32_t(index), value).FromMaybe(false));
  }
  void AddProperty(Local<Object> object, Local<String> name, Local<Value> value) {
    CHECK(object->CreateDataProperty(isolate_->GetCurrentContext(), name, value).FromMaybe(false));
  }
 private:
  Isolate* isolate_;
};
}  // namespace v8::bridge

#endif
