#ifndef KANDELO_NODE_TRACE_UTF8_NATIVE_H
#define KANDELO_NODE_TRACE_UTF8_NATIVE_H
#include <vector>
#include <optional>
#include <span>
#include <cstdint>
#include "js/TypeDecls.h"
namespace kandelo::node {
// Includes the terminating NUL. The complete upstream encoder preserves WTF-8.
bool EncodeTraceString(JSContext*, JS::HandleString, std::vector<char>*);
uint32_t DecodeNativeUtf8(const uint8_t*,size_t,size_t*);
std::vector<char> EncodeNativeTwoByteString(std::span<const char16_t>);
struct Utf8WriteResult{size_t bytes,characters;};
std::optional<Utf8WriteResult> EncodeNativeStringUtf8(JSContext*,JS::HandleString,std::span<char>,bool,bool);
}
#endif
