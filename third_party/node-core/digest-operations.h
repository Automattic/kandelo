// Actual OpenSSL digest/comparison ownership; no fixed advertised algorithm set.
#ifndef KANDELO_NODE_DIGEST_OPERATIONS_H
#define KANDELO_NODE_DIGEST_OPERATIONS_H
#include "crypto-errors.h"
#include <algorithm>
#include <cstdint>
#include <exception>
#include <memory>
#include <ncrypto.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
namespace kandelo::crypto {
inline const char* OpenSSLVersion() {
  // Report the linked backend, independent of the advertised Node API target.
  return OpenSSL_version(OPENSSL_VERSION_STRING);
}
struct Bytes {
  std::vector<unsigned char> value;
  Bytes() = default;
  Bytes(Bytes&&) = default;
  Bytes(const Bytes&) = delete;
  ~Bytes() { if (!value.empty()) OPENSSL_cleanse(value.data(), value.size()); }
};
[[noreturn]] inline void Fail(const char* fallback) {
  const unsigned long number = ERR_get_error();
  char message[128];
  if (number) { ERR_error_string_n(number, message, sizeof(message)); throw Error(message, number); }
  throw Error(fallback);
}
using DigestOwner = std::unique_ptr<EVP_MD, decltype(&EVP_MD_free)>;
using ContextOwner = std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)>;
inline DigestOwner Fetch(const char* name) {
  // Legacy alias names (including RSA-SHA*) resolve through the canonical
  // provider name; NULL is not an advertised or usable digest.
  const EVP_MD* legacy = EVP_get_digestbyname(name);
  const char* canonical = legacy ? EVP_MD_get0_name(legacy) : name;
  if (legacy == EVP_md_null() || !canonical) return {nullptr, EVP_MD_free};
  DigestOwner md(EVP_MD_fetch(nullptr, canonical, nullptr), EVP_MD_free);
  if (md && EVP_MD_is_a(md.get(), "NULL")) md.reset();
  // Fetch is an availability query, like ncrypto::Digest::Fetch. Its failed
  // lookup must not contaminate the next operation's error queue.
  ERR_clear_error(); return md;
}
inline Bytes Digest(const std::string& algorithm, const Bytes& input,
                    std::optional<uint32_t> requested, bool digestOptions) {
  ERR_clear_error();
  auto md = Fetch(algorithm.c_str());
  if (!md) throw Error("Digest method " + algorithm + " is not supported");
  const int size = EVP_MD_get_size(md.get());
  const bool xof = (EVP_MD_get_flags(md.get()) & EVP_MD_FLAG_XOF) != 0;
  size_t length = size > 0 ? size_t(size) : 0;
  if (!xof && requested && *requested != length)
    throw Error("Output length " + std::to_string(*requested) + " is invalid for " + algorithm + ", which does not support XOF");
  if (xof && requested) length = *requested;
  else if (xof && !length) {
    if (EVP_MD_is_a(md.get(), "SHAKE128")) length = 16;
    else if (EVP_MD_is_a(md.get(), "SHAKE256")) length = 32;
  }
  // The selected OpenSSL 3.x has no cSHAKE customization interface.
  // Pinned Node rejects these options on pre-4 too.
  if (digestOptions) throw Error("Digest options are not supported");
  Bytes output;
  if (length == 0) return output;
  output.value.resize(length);
  ContextOwner ctx(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  if (!ctx || EVP_DigestInit_ex(ctx.get(), md.get(), nullptr) != 1 ||
      EVP_DigestUpdate(ctx.get(), input.value.data(), input.value.size()) != 1)
    Fail("Digest update failed");
  if (xof) {
    if (EVP_DigestFinalXOF(ctx.get(), output.value.data(), length) != 1) Fail("Digest final failed");
  } else {
    unsigned int written = 0;
    if (EVP_DigestFinal_ex(ctx.get(), output.value.data(), &written) != 1) Fail("Digest final failed");
    if (written != length) throw Error("Digest backend returned an inconsistent length");
  }
  return output;
}
inline bool Equal(const Bytes& a, const Bytes& b) {
  if (a.value.size() != b.value.size()) throw std::length_error("Input buffers must have the same byte length");
  return CRYPTO_memcmp(a.value.data(), b.value.data(), a.value.size()) == 0;
}
struct Names {
  std::vector<std::string> values;
  std::exception_ptr failure;
  void Add(const char* name, bool normalize = false) noexcept {
    if (!name || failure) return;
    try {
      std::string value(name);
      if (normalize) {
        bool dotted = value.find('.') != std::string::npos &&
            std::all_of(value.begin(), value.end(), [](unsigned char c) { return (c >= '0' && c <= '9') || c == '.'; });
        if (dotted) return;
        for (char& c : value) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
      }
      if (Fetch(value.c_str())) values.push_back(std::move(value));
    } catch (...) { failure = std::current_exception(); }
  }
};
inline std::vector<std::string> DigestNames() {
  Names names;
  EVP_MD_do_all_sorted([](const EVP_MD*, const char* from, const char*, void* data) {
    static_cast<Names*>(data)->Add(from);
  }, &names);
  EVP_MD_do_all_provided(nullptr, [](EVP_MD* md, void* data) {
    EVP_MD_names_do_all(md, [](const char* name, void* data) { static_cast<Names*>(data)->Add(name, true); }, data);
  }, &names);
  if (names.failure) std::rethrow_exception(names.failure);
  return names.values;
}
// Names are immediate provider-query results, not native alias/cache IDs.
// The public JS owner below owns the actual FIPS-generation cache. No
// pointer from OpenSSL enumeration or fetched method survives this call.
struct MacNamesResult {
  std::vector<std::string> names;
  std::exception_ptr failure;
  void Add(const char* name) noexcept {
    if (!name || failure) return;
    try {
      std::string normalized(name);
      const bool dotted = normalized.find('.') != std::string::npos &&
          std::all_of(normalized.begin(), normalized.end(), [](unsigned char c) {
            return (c >= '0' && c <= '9') || c == '.';
          });
      if (dotted) return;
      std::transform(normalized.begin(), normalized.end(), normalized.begin(),
                     [](unsigned char c) { return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c; });
      names.push_back(std::move(normalized));
    } catch (...) { failure = std::current_exception(); }
  }
};
inline std::vector<std::string> MacNames() {
  MacNamesResult result;
#if OPENSSL_WITH_EVP_MAC
  ncrypto::MarkPopErrorOnReturn mark;
  EVP_MAC_do_all_provided(nullptr, [](EVP_MAC* enumerated, void* opaque) {
    auto* result = static_cast<MacNamesResult*>(opaque);
    if (result->failure) return;
    const char* name = EVP_MAC_get0_name(enumerated);
    if (!name) return;
    // Fetch through current default properties. Enumeration alone can include
    // an implementation that this process is not permitted to use.
    ncrypto::EVPMacPointer fetched;
    {
      // Match the target per-fetch scope too, so failed lookups cannot pile
      // up and evict an existing marked caller error during enumeration.
      ncrypto::MarkPopErrorOnReturn fetch_mark;
      fetched = ncrypto::EVPMacPointer::Fetch(name);
    }
    if (!fetched) return;
    EVP_MAC_names_do_all(fetched.get(), [](const char* alias, void* opaque) {
      static_cast<MacNamesResult*>(opaque)->Add(alias);
    }, result);
  }, &result);
#endif
  if (result.failure) std::rethrow_exception(result.failure);
  std::sort(result.names.begin(), result.names.end());
  result.names.erase(std::unique(result.names.begin(), result.names.end()), result.names.end());
  return result.names;
}
}  // namespace kandelo::crypto
#endif
