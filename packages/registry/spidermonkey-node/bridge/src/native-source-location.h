#ifndef KANDELO_NODE_NATIVE_SOURCE_LOCATION_H
#define KANDELO_NODE_NATIVE_SOURCE_LOCATION_H
#include "vm/JSScript.h"
namespace kandelo::node {
inline void NativeFunctionBodyLocation(v8::NativeSourceRecord* record,
    uint32_t* line,uint32_t* column) {
  auto* source=record?record->source.get():nullptr;
  if(!source||!record->functionBody||*line<=source->startLine())return;
  if(*line==source->startLine()+1){
    const uint64_t adjusted=uint64_t(*column)+source->startColumn().oneOriginValue()-1;
    MOZ_RELEASE_ASSERT(adjusted<=UINT32_MAX);*column=uint32_t(adjusted);
  }
  --*line;
}
}
#endif
