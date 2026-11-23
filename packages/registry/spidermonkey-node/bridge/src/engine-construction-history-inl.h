#ifndef KANDELO_NODE_ENGINE_CONSTRUCTION_HISTORY_INL_H
#define KANDELO_NODE_ENGINE_CONSTRUCTION_HISTORY_INL_H

#include "gc/WeakMap.h"
#include "gc/WeakMap-inl.h"

// The same zone-native ephemeron table and barriers previously lived in the
// engine's Realm class. This bridge owner preserves that weak-key algorithm
// and the realm's trace/finishRoots/destruction order without rooting a global.
namespace v8::bridge {
class ConstructionHistory final:public js::NativeObjectRealmMetadata {
 public:
  js::WeakMap<JSObject*,JS::Value,js::ZoneAllocPolicy> identities;
  explicit ConstructionHistory(JS::Zone* zone):identities(zone){}
  void trace(JSTracer* tracer)override{identities.trace(tracer);}
  void finishRoots()override{identities.clear();}
  size_t sizeOfIncludingThis(mozilla::MallocSizeOf mallocSizeOf)override{
    return mallocSizeOf(this)+identities.shallowSizeOfExcludingThis(mallocSizeOf);
  }
};
ConstructionHistory* ObjectConstructionHistory(JSObject* object){
  return static_cast<ConstructionHistory*>(js::ObjectRealm::get(object).embeddingMetadata());
}
bool RecordConstructionHistory(JSContext* cx,JS::HandleObject object,
                               JS::HandleObject constructor,bool direct){
  auto& realm=js::ObjectRealm::get(object);
  MOZ_ASSERT(!direct||&js::ObjectRealm::get(constructor)==&realm);
  cx->check(object);
  if(!realm.embeddingMetadata()){
    auto history=cx->make_unique<ConstructionHistory>(cx->zone());
    if(!history)return false;
    realm.setEmbeddingMetadata(std::move(history));
  }
  auto& identities=ObjectConstructionHistory(object)->identities;
  JS::Value identity=direct?JS::ObjectValue(*constructor):JS::BooleanValue(false);
  if(auto previous=identities.lookup(object)){
    MOZ_RELEASE_ASSERT(previous->value()==identity);return true;
  }
  if(!identities.put(object,identity)){js::ReportOutOfMemory(cx);return false;}
  return true;
}
JSObject* OriginalConstructor(JSObject* object){
  auto* history=ObjectConstructionHistory(object);
  JS::Value identity=history?history->identities.get(object):JS::UndefinedValue();
  return identity.isObject()?&identity.toObject():nullptr;
}
bool WasPrototypeConstruction(JSObject* object){
  auto* history=ObjectConstructionHistory(object);
  if(!history)return false;
  auto identity=history->identities.get(object);
  return identity.isBoolean()&&!identity.toBoolean();
}
void InitializeNativeContextMetadata(JSContext* cx){
  // Install before self-hosted initialization: early construction events have
  // no Node State yet, and the record must also survive State disposal.
  cx->embedderConstructionObserver=RecordConstructionHistory;
}
}
#endif
