#include "shell/node-upstream/process-versions.h"

#include "mozilla/intl/ICU4CLibrary.h"
#include "mozilla/intl/String.h"
#include "mozilla/intl/TimeZone.h"

#include <cstring>
#include <nbytes.h>
#include <openssl/crypto.h>
#include <simdutf.h>
#include <unicode/ulocdata.h>
#include <unicode/uversion.h>
#include <uv.h>
#include <zstd.h>

#include "jsapi.h"
#include "node-version.h"

#include "js/PropertyAndElement.h"
#include "js/RootingAPI.h"
#include "js/String.h"
#include "shell/node-upstream/process-versions-deps/zlib.h"

namespace kandelo::node {
namespace {
constexpr unsigned kAttributes = JSPROP_ENUMERATE | JSPROP_READONLY;
bool Field(JSContext* cx, JS::HandleObject object, const char* key,
           const char* value, size_t length) {
  if (!value || !length) {
    JS_ReportErrorASCII(cx, "Actual native version metadata unavailable: %s", key);
    return false;
  }
  JS::RootedString string(cx, JS_NewStringCopyN(cx, value, length));
  return string && JS_DefineProperty(cx, object, key, string, kAttributes);
}
bool Field(JSContext* cx, JS::HandleObject object, const char* key,
           const char* value) {
  return Field(cx, object, key, value, value ? std::strlen(value) : 0);
}
}  // namespace

bool ReadNativeProcessVersions(JSContext* cx, NativeVersionRows* rows) {
  rows->clear();
  auto field = [&](const char* key, const char* value, size_t length) {
    if (!value || !length) {
      JS_ReportErrorASCII(cx, "Actual native version metadata unavailable: %s", key);
      return false;
    }
    rows->emplace_back(key, std::string(value, length));
    return true;
  };
  auto text = [&](const char* key, const char* value) {
    return field(key, value, value ? std::strlen(value) : 0);
  };
  // These are actual binary dependencies. Source admission alone does not
  // enable Amaro, Node-API, a V8 addon ABI, or libraries absent from this build.
  // Keep the source's node-first / sorted remainder shape and property flags.
  if (!text("node", NODE_VERSION_STRING)) return false;

  UErrorCode status = U_ZERO_ERROR;
  UVersionInfo cldr;
  ulocdata_getCLDRVersion(cldr, &status);
  if (U_FAILURE(status)) {
    JS_ReportErrorASCII(cx, "Actual ICU CLDR metadata unavailable: %s", u_errorName(status));
    return false;
  }
  char cldrText[U_MAX_VERSION_STRING_LENGTH];
  u_versionToString(cldr, cldrText);
  auto icu = mozilla::intl::ICU4CLibrary::GetVersion();
  auto unicode = mozilla::intl::String::GetUnicodeVersion();
  auto timezone = mozilla::intl::TimeZone::GetTZDataVersion();
  if (timezone.isErr()) {
    JS_ReportErrorASCII(cx, "Actual engine timezone metadata unavailable");
    return false;
  }
  auto tz = timezone.unwrap();
  return text("cldr", cldrText) &&
      field("icu", icu.Elements(), icu.Length()) &&
      text("nbytes", NBYTES_VERSION) &&
      text("openssl", OpenSSL_version(OPENSSL_VERSION_STRING)) &&
      text("simdutf", SIMDUTF_VERSION) &&
      text("spidermonkey", JS_GetImplementationVersion()) &&
      field("tz", tz.Elements(), tz.Length()) &&
      field("unicode", unicode.Elements(), unicode.Length()) &&
      text("uv", uv_version_string()) && text("zlib", zlibVersion()) &&
      text("zstd", ZSTD_versionString());
}

bool InitializeProcessVersions(JSContext* cx, JS::HandleObject process) {
  NativeVersionRows rows;
  if (!ReadNativeProcessVersions(cx, &rows)) return false;
  JS::RootedObject versions(cx, JS_NewPlainObject(cx));
  if (!versions) return false;
  for (const auto& row : rows) {
    if (!Field(cx, versions, row.first.c_str(), row.second.data(), row.second.size())) return false;
  }
  if (!Field(cx, process, "version", NODE_VERSION) ||
      !JS_DefineProperty(cx, process, "versions", versions, kAttributes)) return false;
  return true;
}
}  // namespace kandelo::node
