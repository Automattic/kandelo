#ifndef KANDELO_NODE_BUILD_CONFIG_INL_H
#define KANDELO_NODE_BUILD_CONFIG_INL_H

#include "mozilla/JSONWriter.h"
#include "mozilla/Span.h"

#include <cstdint>
#include <cstring>
#include <new>
#include <openssl/crypto.h>
#include <openssl/opensslv.h>
#include <string>

#include "builtin-source-registry.h"
#include "node-version.h"
#include "js/CharacterEncoding.h"
#include "js/RootingAPI.h"
#include "js/String.h"
#include "shell/node-upstream/build-profile.h"
#include "shell/node-upstream/node-build-settings.generated.h"

namespace kandelo::node {
namespace build_configuration {
class Buffer final : public mozilla::JSONWriteFunc {
 public:
  JSContext* context;
  std::string text;
  bool ok = true;
  explicit Buffer(JSContext* cx) : context(cx) {}
  void Write(const mozilla::Span<const char>& bytes) override {
    if (!ok) return;
    try {
      text.append(bytes.data(), bytes.size());
    } catch (const std::bad_alloc&) {
      JS_ReportOutOfMemory(context);
      ok = false;
    }
  }
};
inline mozilla::Span<const char> Text(const char* text) {
  return mozilla::Span<const char>(text, std::strlen(text));
}
}  // namespace build_configuration

// Native data getter: metadata comes from this binary and its actual recipe,
// independently of user globals/prototypes and without executing JavaScript.
inline bool NativeBuildConfiguration(JSContext* cx, JS::HandleObject,
                                     JS::HandleId, JS::HandleValue,
                                     JS::MutableHandleValue result) {
  using namespace build_configuration;
  if (HAVE_AMARO && !FindBuiltinSource("internal/deps/amaro/dist/index")) {
    JS_ReportErrorASCII(cx, "Build profile requires the actual Amaro source");
    return false;
  }
  Buffer buffer(cx);
  mozilla::JSONWriter writer(buffer, mozilla::JSONWriter::SingleLineStyle);
  writer.Start();
  writer.StartObjectProperty("variables");
#if defined(__wasm32__)
  writer.StringProperty("target_arch", "wasm32");
#elif defined(__wasm64__)
  writer.StringProperty("target_arch", "wasm64");
#else
#error Native Node build metadata requires the actual WebAssembly target
#endif
#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
  writer.StringProperty("node_byteorder", "little");
#elif __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
  writer.StringProperty("node_byteorder", "big");
#else
#error Unknown target byte order
#endif
  writer.IntProperty("kandelo_pointer_bits", sizeof(void*) * 8);
  writer.StringProperty("kandelo_javascript_engine", "spidermonkey");
  writer.StringProperty("kandelo_engine_version", Text(JS_GetImplementationVersion()));
  writer.StringProperty("kandelo_node_source_version", NODE_VERSION_STRING);
  writer.BoolProperty("node_use_amaro", HAVE_AMARO);
  writer.BoolProperty("node_use_ffi", HAVE_FFI);
  writer.BoolProperty("node_use_sqlite", HAVE_SQLITE);
  writer.BoolProperty("node_use_dtls", HAVE_DTLS);
  writer.BoolProperty("node_use_quic", KANDELO_NODE_QUIC_BINDING);
  writer.BoolProperty("node_use_openssl", HAVE_OPENSSL);
  writer.BoolProperty("node_use_v8_platform", NODE_USE_V8_PLATFORM);
  writer.BoolProperty("node_use_bundled_v8", false);
  writer.BoolProperty("node_use_node_snapshot", KANDELO_NODE_SNAPSHOT_BUILDER);
  writer.BoolProperty("node_use_node_code_cache", KANDELO_NODE_CODE_CACHE);
  writer.IntProperty("openssl_version", OpenSSL_version_num());
#ifdef OPENSSL_IS_BORINGSSL
  writer.BoolProperty("openssl_is_boringssl", true);
#else
  writer.BoolProperty("openssl_is_boringssl", false);
#endif
  // The recipe explicitly links these resolver archives, not shared libraries.
  writer.BoolProperty("node_shared_openssl", false);
  writer.BoolProperty("node_shared_libuv", false);
  writer.BoolProperty("node_shared_zlib", false);
  writer.BoolProperty("node_shared_zstd", false);
  writer.BoolProperty("node_shared_simdutf", false);
  writer.BoolProperty("node_shared_nbytes", false);
#if defined(DEBUG) && DEBUG
  writer.BoolProperty("debug_node", true);
#else
  writer.BoolProperty("debug_node", false);
#endif
  writer.StartArrayProperty("node_library_files");
  for (size_t index = 0; index < BuiltinSourceCount(); ++index) {
    auto source = BuiltinSourceAt(index);
    MOZ_RELEASE_ASSERT(source);
    if (std::strncmp(source->sourcePath, "lib/", 4) == 0)
      writer.StringElement(Text(source->sourcePath));
  }
  writer.EndArray();
  writer.EndObject();
  writer.StartObjectProperty("target_defaults");
#if defined(DEBUG) && DEBUG
  writer.StringProperty("default_configuration", "Debug");
#else
  writer.StringProperty("default_configuration", "Release");
#endif
  writer.StartArrayProperty("cflags");
  for (const char* flag : build_settings::kCFLAGS) writer.StringElement(Text(flag));
  writer.EndArray();
  writer.StartArrayProperty("cflags_cc");
  for (const char* flag : build_settings::kCXXFLAGS) writer.StringElement(Text(flag));
  writer.EndArray();
  writer.StartArrayProperty("ldflags");
  for (const char* flag : build_settings::kLDFLAGS) writer.StringElement(Text(flag));
  writer.EndArray();
  writer.EndObject();
  writer.StartObjectProperty("kandelo_build");
  writer.StringProperty("configuration_format", "Kandelo SpiderMonkey recipe inputs, not GYP addon settings");
  writer.StringProperty("path_projection", "Build paths normalized to logical source/dependency roots");
  writer.StartArrayProperty("mozconfig");
  for (const char* line : build_settings::kMozconfig) writer.StringElement(Text(line));
  writer.EndArray();
  writer.EndObject();
  writer.End();
  if (!buffer.ok) return false;
  JS::RootedString text(cx, JS_NewStringCopyUTF8N(
      cx, JS::UTF8Chars(buffer.text.data(), buffer.text.size())));
  if (!text) return false;
  result.setString(text);
  return true;
}
}  // namespace kandelo::node
#endif
