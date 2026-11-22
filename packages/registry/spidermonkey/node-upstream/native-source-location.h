#ifndef KANDELO_NODE_NATIVE_SOURCE_LOCATION_H
#define KANDELO_NODE_NATIVE_SOURCE_LOCATION_H
#include "vm/JSScript.h"
namespace kandelo::node {
inline void NativeFunctionBodyLocation(js::ScriptSource* source,
    uint32_t* line,uint32_t* column) {
#ifdef KANDELO_NATIVE_NODE_ENGINE
  if(!source||!source->isKandeloNativeFunctionBody()||*line<=source->startLine())return;
  if(*line==source->startLine()+1){
    const uint64_t adjusted=uint64_t(*column)+source->startColumn().oneOriginValue()-1;
    MOZ_RELEASE_ASSERT(adjusted<=UINT32_MAX);*column=uint32_t(adjusted);
  }
  --*line;
#else
  // The preserved standalone shell keeps its original engine coordinates.
  (void)source;(void)line;(void)column;
#endif
}
}
#endif
