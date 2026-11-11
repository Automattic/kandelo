#ifndef KANDELO_NODE_TYPES_H
#define KANDELO_NODE_TYPES_H
#include "js/TypeDecls.h"
namespace kandelo::node {
JSObject* CreateTypesBinding(JSContext* cx, JS::HandleObject realm);
// Opaque borrowed native data. The embedding owns payload lifetime; the JS
// value roots only this carrier, as with a native External value.
JSObject* CreateExternalPointer(JSContext* cx, void* payload);
bool GetExternalPointer(JSContext* cx, JS::HandleObject value, void** payload);
}
#endif
