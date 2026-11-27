#ifndef KANDELO_NODE_ENGINE_SOURCE_REGISTRY_INL_H
#define KANDELO_NODE_ENGINE_SOURCE_REGISTRY_INL_H

#include "vm/SavedFrame.h"
#include "vm/JSScript.h"

namespace v8 {
namespace {
bool IsNativeFunctionBodyScript(JSScript* script);
}
struct NativeSourceRecord;
struct NativeSourceRegistry {
  // Non-owning native identities. Each record erases itself before releasing
  // its source; a record's immutable source reference prevents address reuse.
  std::map<js::ScriptSource*,NativeSourceRecord*> records;
  ~NativeSourceRegistry(){CHECK(records.empty());}
};
struct NativeSourceRecord final:js::NativeFrameMetadata {
  uint32_t references=0;
  std::shared_ptr<NativeSourceRegistry> registry;
  RefPtr<js::ScriptSource> source;
  const bool functionBody;
  NativeSourceRecord(std::shared_ptr<NativeSourceRegistry> owner,
      js::ScriptSource* input,bool body):registry(std::move(owner)),source(input),functionBody(body){}
  void AddRef() override {CHECK_NE(references,UINT32_MAX);++references;}
  void Release() override {CHECK(references);if(!--references)delete this;}
  ~NativeSourceRecord() override {CHECK_EQ(registry->records.erase(source.get()),size_t(1));}
};
namespace {
bool CaptureNativeFrameMetadata(JSContext* cx,JSScript* script,
                                js::NativeFrameMetadata** output){
  *output=nullptr;
  auto state=ReadNativeEngineState(cx);if(!state)return false;
  try {
    if(!state->sourceRegistry)state->sourceRegistry=std::make_shared<NativeSourceRegistry>();
    auto& registry=*state->sourceRegistry;
    auto* source=script->scriptSource();
    auto found=registry.records.find(source);
    NativeSourceRecord* record;
    if(found!=registry.records.end())record=found->second;
    else {
      auto [position,inserted]=registry.records.emplace(source,nullptr);CHECK(inserted);
      try {
        record=new NativeSourceRecord(state->sourceRegistry,source,
            IsNativeFunctionBodyScript(script));
        position->second=record;
      }catch(...){registry.records.erase(position);throw;}
    }
    record->AddRef();*output=record;return true;
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(cx);return false;}
}
}
}
namespace kandelo::node {
inline v8::NativeSourceRecord* NativeFrameSourceRecord(js::SavedFrame& frame){
  return static_cast<v8::NativeSourceRecord*>(frame.getNativeFrameMetadata());
}
inline js::ScriptSource* NativeFrameSource(js::SavedFrame& frame){
  auto* record=NativeFrameSourceRecord(frame);return record?record->source.get():nullptr;
}
}
#endif
