#ifndef KANDELO_NODE_CODECS_H
#define KANDELO_NODE_CODECS_H
#include "js/TypeDecls.h"
namespace kandelo::node {
JSObject* CreateCodecState(JSContext* cx);
JSObject* CreateStringDecoderBinding(JSContext* cx, JS::HandleObject realm);
JSObject* InspectCodecState(JSContext* cx, JS::HandleObject runtime);
bool SetCodecGcStress(JSContext* cx, JS::HandleObject runtime, bool enabled);
}
#endif
