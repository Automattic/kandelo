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

bool InitializeProcessVersions(JSContext* cx, JS::HandleObject process) {
  JS::RootedObject versions(cx, JS_NewPlainObject(cx));
  if (!versions) return false;

  // These are actual binary dependencies. Source admission alone does not
  // enable Amaro, Node-API, a V8 addon ABI, or libraries absent from this build.
  // Keep the source's node-first / sorted remainder shape and property flags.
  if (!Field(cx, versions, "node", NODE_VERSION_STRING)) return false;

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
  if (!Field(cx, versions, "cldr", cldrText) ||
      !Field(cx, versions, "icu", icu.Elements(), icu.Length()) ||
      !Field(cx, versions, "nbytes", NBYTES_VERSION) ||
      !Field(cx, versions, "openssl", OpenSSL_version(OPENSSL_VERSION_STRING)) ||
      !Field(cx, versions, "simdutf", SIMDUTF_VERSION) ||
      !Field(cx, versions, "spidermonkey", JS_GetImplementationVersion()) ||
      !Field(cx, versions, "tz", tz.Elements(), tz.Length()) ||
      !Field(cx, versions, "unicode", unicode.Elements(), unicode.Length()) ||
      !Field(cx, versions, "uv", uv_version_string()) ||
      !Field(cx, versions, "zlib", zlibVersion()) ||
      !Field(cx, versions, "zstd", ZSTD_versionString()) ||
      !Field(cx, process, "version", NODE_VERSION) ||
      !JS_DefineProperty(cx, process, "versions", versions, kAttributes)) return false;
  return true;
}
}  // namespace kandelo::node
