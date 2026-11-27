#ifndef KANDELO_ENGINE_PROCESS_H
#define KANDELO_ENGINE_PROCESS_H
#include <cstdint>
struct JSContext;
namespace v8::bridge {
void RegisterProcessContext();
void RegisterNativeBufferOwnerFactory();
void InitializeNativeContextMetadata(JSContext*);
void RetireProcessContext();
bool ExposedGcEnabled();
bool ImmutableArrayBuffersEnabled();
JSContext* NewProcessContext();
void DestroyProcessContext(JSContext*);
}
#endif
