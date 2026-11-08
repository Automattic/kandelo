// Exact pinned Node26.13.0 internal declaration. Control dependency only.
// No Environment/private object layout is accessed. See native-reference.json.
#ifndef KANDELO_NODE_SIGNATURE_FRAME_REFERENCE_H
#define KANDELO_NODE_SIGNATURE_FRAME_REFERENCE_H
#include <node.h>
#include <v8.h>
namespace node {
v8::MaybeLocal<v8::Value> InternalMakeCallback(
    v8::Isolate* isolate,
    v8::Local<v8::Object> recv,
    const v8::Local<v8::Function> callback,
    int argc,
    v8::Local<v8::Value> argv[],
    async_context asyncContext,
    v8::Local<v8::Value> context_frame);
}  // namespace node
#endif
