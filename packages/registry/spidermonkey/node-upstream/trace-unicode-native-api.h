#ifndef KANDELO_NODE_TRACE_UNICODE_NATIVE_API_H
#define KANDELO_NODE_TRACE_UNICODE_NATIVE_API_H
#include "mozilla/Assertions.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <v8config.h>
#ifndef V8_INLINE
#define V8_INLINE inline
#endif
#define V8_EXPORT_PRIVATE __attribute__((visibility("hidden")))
#ifndef V8_LIKELY
#define V8_LIKELY(value) MOZ_LIKELY(value)
#endif
#define CHECK(value) MOZ_RELEASE_ASSERT(value)
#define CHECK_LE(a,b) CHECK((a)<=(b))
#define DCHECK(value) CHECK(value)
#define DCHECK_LE(a,b) CHECK_LE(a,b)
#define DCHECK_LT(a,b) CHECK((a)<(b))
#define DCHECK_GE(a,b) CHECK((a)>=(b))
#define DCHECK_EQ(a,b) CHECK((a)==(b))
#define DCHECK_NE(a,b) CHECK((a)!=(b))
#define DCHECK_NOT_NULL(a) CHECK((a)!=nullptr)
// Native pointer/extent view only. Encoding bodies remain complete originals.
namespace kandelo_trace_unicode_api::base {
template<class T> struct Vector {
  T* data; size_t count;
  T* begin() const { return data; }
  size_t size() const { return count; }
};
}
#endif
