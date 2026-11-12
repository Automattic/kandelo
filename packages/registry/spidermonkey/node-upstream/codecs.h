#ifndef KANDELO_NODE_CODECS_H
#define KANDELO_NODE_CODECS_H
#include "js/TypeDecls.h"
namespace kandelo::node {
JSObject* CreateBufferBinding(JSContext* cx, JS::HandleObject realm);
JSObject* CreateSnapshotBinding(JSContext*,JS::HandleObject);
bool DefineNativeContextTestAPI(JSContext*,JS::HandleObject);
JSObject* CreateCodecState(JSContext* cx);
JSObject* CreateStringDecoderBinding(JSContext* cx, JS::HandleObject realm);
JSObject* CreateIcuBinding(JSContext* cx, JS::HandleObject realm);
JSObject* CreateTraceBinding(JSContext* cx, JS::HandleObject realm);
JSObject* CreateContinuationBinding(JSContext* cx, JS::HandleObject realm);
bool DefineContinuationTestAPI(JSContext* cx, JS::HandleObject api);
bool TraceNativeCallIsActive();
JSObject* InspectCodecState(JSContext* cx, JS::HandleObject runtime);
bool SetCodecGcStress(JSContext* cx, JS::HandleObject runtime, bool enabled);
void ShutdownRuntimeCodecs(JSContext* cx);
bool DefineAliasedTestAPI(JSContext* cx, JS::HandleObject api);
bool DefineBufferNativeTestAPI(JSContext* cx, JS::HandleObject api);
bool DefineEnvironmentTestAPI(JSContext* cx, JS::HandleObject api);
}
#endif
