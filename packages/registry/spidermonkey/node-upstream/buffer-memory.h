#ifndef KANDELO_NODE_BUFFER_MEMORY_H
#define KANDELO_NODE_BUFFER_MEMORY_H

#include "js/TypeDecls.h"

namespace kandelo::node {
// Engine primitives for the upstream ArrayBuffer embedding contract. These do
// not initialize or stand in for the original native Buffer binding.
bool SetBufferDetachKey(JSContext*, JS::HandleObject, JS::HandleValue);
bool DetachBufferWithKey(JSContext*, JS::HandleObject, JS::HandleValue);
bool DefineBufferMemoryTestAPI(JSContext*, JS::HandleObject);
}

#endif
