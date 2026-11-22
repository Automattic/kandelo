#include "shell/node-upstream/trace-utf8-native.h"

#include "jsapi.h"
#include "js/String.h"
#include "shell/node-upstream/trace-unicode-native-api.h"
#define V8_INTL_SUPPORT 1
#define v8 kandelo_trace_unicode_api
#include "shell/node-upstream/trace-builtins-upstream/src/strings/unicode-inl.h"
#define KANDELO_NATIVE_UTF8_SCALAR 1
#include "shell/node-upstream/unicode-decoder-upstream/deps/v8/src/strings/unicode.cc"
#undef KANDELO_NATIVE_UTF8_SCALAR
#undef v8

namespace kandelo::node {
uint32_t DecodeNativeUtf8(const uint8_t* bytes,size_t length,size_t* cursor){
  return unibrow::Utf8::CalculateValue(bytes,length,cursor);
}
std::vector<char> EncodeNativeTwoByteString(std::span<const char16_t> characters){
  std::vector<char> output(characters.size()*3+1);
  auto result=unibrow::Utf8::Encode<char16_t>({characters.data(),characters.size()},
      output.data(),output.size(),true,false);
  MOZ_RELEASE_ASSERT(result.characters_processed==characters.size());
  output.resize(result.bytes_written);return output;
}

std::optional<Utf8WriteResult> EncodeNativeStringUtf8(JSContext* cx,JS::HandleString string,
    std::span<char> output,bool terminate,bool replaceInvalid){
  auto characters=JS_CopyStringCharsZ(cx,string);if(!characters)return {};
  auto result=unibrow::Utf8::Encode<char16_t>({characters.get(),JS_GetStringLength(string)},
      output.data(),output.size(),terminate,replaceInvalid);
  return Utf8WriteResult{result.bytes_written,result.characters_processed};
}

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
