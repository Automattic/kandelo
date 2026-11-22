#ifndef KANDELO_ENGINE_MAYBE_API_H
#define KANDELO_ENGINE_MAYBE_API_H
// Whole upstream value/optional transport. Only the fatal boundary is native;
// no V8 heap/layout implementation or separate collector is included.
namespace v8 { [[noreturn]] void Crash(const char*); }
#include "v8-source-api/v8-maybe.h"
namespace v8::api_internal {
inline void FromJustIsNothing(){Crash("Maybe value is Nothing");}
}
#endif
