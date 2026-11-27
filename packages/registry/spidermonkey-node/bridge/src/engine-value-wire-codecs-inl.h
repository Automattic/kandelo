#ifndef KANDELO_ENGINE_VALUE_WIRE_CODECS_INL_H
#define KANDELO_ENGINE_VALUE_WIRE_CODECS_INL_H
#include "engine-wire-codec.h"
#include "v8-source-api/v8-value-serializer-version.h"

#pragma push_macro("DCHECK")
#pragma push_macro("DCHECK_GT")
#pragma push_macro("DCHECK_LE")
#pragma push_macro("DCHECK_EQ")
#pragma push_macro("V8_LIKELY")
#pragma push_macro("V8_UNLIKELY")
#pragma push_macro("EXPORT_TEMPLATE_DEFINE")
#pragma push_macro("USE")
#undef DCHECK
#undef DCHECK_GT
#undef DCHECK_LE
#undef DCHECK_EQ
#undef V8_LIKELY
#undef V8_UNLIKELY
#undef EXPORT_TEMPLATE_DEFINE
#undef USE
#ifdef DEBUG
#define DCHECK(condition) do { if(!(condition)) v8::Crash("Wire codec invariant"); } while(0)
#define DCHECK_GT(a,b) DCHECK((a)>(b))
#define DCHECK_LE(a,b) DCHECK((a)<=(b))
#define DCHECK_EQ(a,b) DCHECK((a)==(b))
#else
#define DCHECK(...) ((void)0)
#define DCHECK_GT(...) ((void)0)
#define DCHECK_LE(...) ((void)0)
#define DCHECK_EQ(...) ((void)0)
#endif
#define V8_LIKELY(condition) __builtin_expect(bool(condition),true)
#define V8_UNLIKELY(condition) __builtin_expect(bool(condition),false)
#define EXPORT_TEMPLATE_DEFINE(...)
#define USE(value) ((void)(value))
#include "v8-source-api/value-serializer-wire.cc"
#pragma pop_macro("USE")
#pragma pop_macro("EXPORT_TEMPLATE_DEFINE")
#pragma pop_macro("V8_UNLIKELY")
#pragma pop_macro("V8_LIKELY")
#pragma pop_macro("DCHECK_EQ")
#pragma pop_macro("DCHECK_LE")
#pragma pop_macro("DCHECK_GT")
#pragma pop_macro("DCHECK")
#endif
