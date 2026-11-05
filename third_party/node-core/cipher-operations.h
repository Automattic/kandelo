// Node's pinned CipherBase state policy over actual ncrypto/OpenSSL contexts.
#ifndef KANDELO_NODE_CIPHER_OPERATIONS_H
#define KANDELO_NODE_CIPHER_OPERATIONS_H
#include <array>
#include <climits>
#include <cstring>
#include <ncrypto.h>
#include <string>
#include <vector>
#include "kandelo-node-key-operations.h"
namespace kandelo::crypto {
struct CipherState {
  static constexpr unsigned NoTagLength = unsigned(-1);
  enum class TagState { Unknown, SetByUser, Computed };
  ncrypto::CipherCtxPointer context;
  const bool encrypt;
  TagState tagState = TagState::Unknown;
  unsigned tagLength = NoTagLength, sivComponents = 0;
  std::array<unsigned char, ncrypto::Cipher::MAX_AUTH_TAG_LENGTH> tag{};
  bool pendingAuthFailure = false, oneShotUpdated = false;
  int maxMessage = INT_MAX;
  explicit CipherState(bool encrypt) : encrypt(encrypt) {}
  [[noreturn]] static void Code(const char* code, const std::string& message) {
    KeyError error(message.c_str(), code);
    // Node's explicit argument/state errors do not expose the provider queue.
    error.stack.clear(); throw error;
  }
  static void Length(size_t size, const char* message) {
    if (size > INT_MAX) Code("ERR_OUT_OF_RANGE", message);
  }
  bool Authenticated() const { return ncrypto::Cipher::FromCtx(context).isSupportedAuthenticatedMode(); }
  void Init(const std::string& name, const unsigned char* key, size_t keyLength,
            const unsigned char* iv, size_t ivLength, unsigned requestedTag,
            const char* cts, const char* xts) {
    ncrypto::MarkPopErrorOnReturn mark;
    Length(keyLength, "key is too big"); Length(ivLength, "iv is too big");
    const auto cipher = ncrypto::Cipher::FromName(name.c_str());
    if (!cipher) Code("ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
    const int expectedIV = cipher.getIvLength();
    if ((!ivLength && expectedIV != 0) ||
        (!cipher.isSupportedAuthenticatedMode() && ivLength && int(ivLength) != expectedIV) ||
        (cipher.isChaCha20Poly1305() && ivLength > 12) ||
        (cipher.isSivMode() && ivLength) ||
        (cipher.isGcmSivMode() && (!ivLength || int(ivLength) != expectedIV)))
      Code("ERR_CRYPTO_INVALID_IV", "Invalid initialization vector");
    context = ncrypto::CipherCtxPointer::New();
    if (!context) Code("ERR_CRYPTO_OPERATION_FAILED", "Failed to allocate cipher context");
    if (cipher.isWrapMode()) context.setAllowWrap();
    if (!context.init(cipher, encrypt)) Fail("Failed to initialize cipher");
    if (cts && !context.setCtsMode(cts)) {
      context.reset(); Code("ERR_CRYPTO_UNSUPPORTED_OPERATION", name + " does not support the ctsMode option");
    }
    if (xts && !context.setXtsStandard(xts)) {
      context.reset(); Code("ERR_CRYPTO_UNSUPPORTED_OPERATION", name + " does not support the xtsStandard option");
    }
    if (cipher.isSupportedAuthenticatedMode()) {
      const bool siv = context.isSivMode() || context.isGcmSivMode();
      if (!siv && !context.setIvLength(ivLength))
        Code("ERR_CRYPTO_INVALID_IV", "Invalid initialization vector");
      if (context.isCcmMode()) {
        if (!encrypt && ncrypto::isFipsEnabled())
          Code("ERR_CRYPTO_UNSUPPORTED_OPERATION", "CCM decryption not supported in FIPS mode");
        if (ivLength == 12) maxMessage = 16777215;
        if (ivLength == 13) maxMessage = 65535;
      }
      unsigned length = requestedTag;
      if (length == NoTagLength) {
        if (context.isGcmMode() || siv || context.isChaCha20Poly1305()) length = 16;
        else Code("ERR_CRYPTO_INVALID_AUTH_TAG", "authTagLength required for " + name);
      } else if (siv ? length != 16 : context.isGcmMode() ?
          !ncrypto::Cipher::IsValidGCMTagLength(length) : !context.setAeadTagLength(length)) {
        Code("ERR_CRYPTO_INVALID_AUTH_TAG", "Invalid authentication tag length: " + std::to_string(length));
      }
      tagLength = length;
    }
    if (!context.setKeyLength(keyLength)) {
      context.reset(); Code("ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length");
    }
    if (!context.init(ncrypto::Cipher(), encrypt, key, iv)) Fail("Failed to initialize cipher");
  }
  bool Padding(bool padding) {
    ncrypto::MarkPopErrorOnReturn mark;
    return context && context.setPadding(padding);
  }
  bool SetTag(const unsigned char* bytes, size_t length) {
    ncrypto::MarkPopErrorOnReturn mark;
    if (!context || !Authenticated() || encrypt || tagState != TagState::Unknown ||
        ((context.isSivMode() || context.isGcmSivMode()) && oneShotUpdated)) return false;
    Length(length, "buffer is too big");
    if (length != tagLength)
      Code("ERR_CRYPTO_INVALID_AUTH_TAG", "Invalid authentication tag length: " + std::to_string(length));
    if (!context.setAeadTag({reinterpret_cast<const char*>(bytes), length})) return false;
    tagState = TagState::SetByUser; return true;
  }
  void CheckCCM(size_t length) {
    if (length > size_t(maxMessage)) Code("ERR_CRYPTO_INVALID_MESSAGELEN", "Invalid message length");
  }
  bool AAD(const unsigned char* bytes, size_t length, int plaintextLength) {
    ncrypto::MarkPopErrorOnReturn mark;
    Length(length, "buffer is too big");
    // EVP gives nullptr a control meaning. Empty user data is still data,
    // including an empty SIV associated-data component.
    static const unsigned char empty = 0;
    if (!length && !bytes) bytes = &empty;
    if (!context || !Authenticated()) return false;
    const bool siv = context.isSivMode();
    if (((siv || context.isGcmSivMode()) && oneShotUpdated) || (siv && sivComponents >= 126)) return false;
    int output;
    if (context.isCcmMode()) {
      if (plaintextLength < 0)
        Code("ERR_MISSING_ARGS", "options.plaintextLength required for CCM mode with AAD");
      CheckCCM(size_t(plaintextLength));
      if (!context.update({nullptr, size_t(plaintextLength)}, nullptr, &output)) return false;
    }
    const bool ok = context.update({bytes, length}, nullptr, &output);
    if (ok && siv) sivComponents++;
    return ok;
  }
  std::vector<unsigned char> Update(const unsigned char* bytes, size_t length) {
    ncrypto::MarkPopErrorOnReturn mark;
    Length(length, "data is too long");
    // Preserve zero-length user input rather than sending EVP a null-input
    // control operation. In particular, SIV must process the empty message.
    static const unsigned char empty = 0;
    if (!length && !bytes) bytes = &empty;
    if (!context) Fail("Trying to add data in unsupported state");
    const bool ccmDecipher = !encrypt && context.isCcmMode();
    if (context.isCcmMode()) CheckCCM(length);
    const bool siv = context.isSivMode() || context.isGcmSivMode();
    const bool cts = context.isCtsMode(), xts = context.isXtsMode(), wrap = context.isWrapMode();
    if ((ccmDecipher || siv || cts || xts || wrap) && oneShotUpdated)
      Fail("Trying to add data in unsupported state");
    const int block = context.getBlockSize();
    if (block <= 0 || length > size_t(INT_MAX - block)) Fail("Trying to add data in unsupported state");
    int size = int(length) + block;
    if (encrypt && wrap && !context.update({bytes, length}, nullptr, &size))
      Fail("Trying to add data in unsupported state");
    if (size < 0) Fail("Trying to add data in unsupported state");
    std::vector<unsigned char> output(size);
    const bool ok = context.update({bytes, length}, output.data(), &size);
    if (ccmDecipher || siv || ((cts || xts || wrap) && ok)) oneShotUpdated = true;
    const bool pending = !ok && !encrypt && (context.isCcmMode() || siv);
    if (pending) size = 0;
    if (size < 0 || size_t(size) > output.size()) Fail("Invalid cipher output size");
    output.resize(size);
    if (pending) pendingAuthFailure = true;
    else if (!ok) Fail("Trying to add data in unsupported state");
    return output;
  }
  std::vector<unsigned char> Final() {
    ncrypto::MarkPopErrorOnReturn mark;
    if (!context) Code("ERR_CRYPTO_INVALID_STATE", "Invalid state");
    const bool authenticated = Authenticated();
    const char* failure = authenticated ? "Unsupported state or unable to authenticate data" : "Unsupported state";
    const bool oneShot = context.isSivMode() || context.isGcmSivMode() ||
        context.isCtsMode() || context.isXtsMode() || context.isWrapMode();
    if (oneShot && !oneShotUpdated) { context.reset(); Fail(failure); }
    std::vector<unsigned char> output(context.getBlockSize());
    bool ok;
    if (!encrypt && context.isCcmMode()) {
      ok = tagState == TagState::SetByUser && oneShotUpdated && !pendingAuthFailure;
      output.clear();
    } else {
      int size = int(output.size());
      ok = context.update({}, output.data(), &size, true);
      if (size < 0 || size_t(size) > output.size()) { context.reset(); Fail("Invalid cipher output size"); }
      output.resize(size);
      if (ok && encrypt && authenticated) {
        ok = context.getAeadTag(tagLength, tag.data());
        if (ok) tagState = TagState::Computed;
      }
    }
    context.reset();
    if (!ok) Fail(failure);
    return output;
  }
};
}  // namespace kandelo::crypto
#endif
