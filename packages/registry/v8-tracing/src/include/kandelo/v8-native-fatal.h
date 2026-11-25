#ifndef KANDELO_V8_NATIVE_FATAL_H
#define KANDELO_V8_NATIVE_FATAL_H

// A resident native entry to the original logger and guest abort path. It
// neither needs a JavaScript realm nor calls into the JavaScript engine.
#ifdef __cplusplus
extern "C" [[noreturn]] void kandelo_v8_graceful_fatal(const char* reason);
#else
_Noreturn void kandelo_v8_graceful_fatal(const char* reason);
#endif

#endif
