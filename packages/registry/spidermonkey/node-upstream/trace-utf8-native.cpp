#include "shell/node-upstream/trace-utf8-native.h"

#include "jsapi.h"
#include "js/String.h"
#include "shell/node-upstream/trace-unicode-native-api.h"
#define V8_INTL_SUPPORT 1
#define v8 kandelo_trace_unicode_api
#include "shell/node-upstream/trace-builtins-upstream/src/strings/unicode-inl.h"
#undef v8

namespace kandelo::node {
bool EncodeTraceString(JSContext* cx, JS::HandleString string, std::vector<char>* output) {
  auto characters=JS_CopyStringCharsZ(cx,string);
  if (!characters) return false;
  size_t length=JS_GetStringLength(string);
  output->resize(length*3+1);
  auto result=unibrow::Utf8::Encode<uint16_t>(
      {reinterpret_cast<const uint16_t*>(characters.get()),length},
      output->data(),output->size(),true,false);
  MOZ_RELEASE_ASSERT(result.characters_processed==length);
  output->resize(result.bytes_written);
  return true;
}
}
