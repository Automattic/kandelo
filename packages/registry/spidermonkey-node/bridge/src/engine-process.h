#ifndef KANDELO_ENGINE_PROCESS_H
#define KANDELO_ENGINE_PROCESS_H
#include <cstdint>
struct JSContext;
namespace v8::bridge {
void RegisterProcessContext();
void RetireProcessContext();
bool ExposedGcEnabled();
JSContext* NewProcessContext();
void DestroyProcessContext(JSContext*);
}
#endif
