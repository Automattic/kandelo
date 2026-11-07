#ifndef KANDELO_NODE_X509_OPERATIONS_H
#define KANDELO_NODE_X509_OPERATIONS_H
#include "kandelo-node-digest-operations.h"
#include "native-retained-memory.h"
#include <ncrypto.h>
#include <openssl/buffer.h>
#include <openssl/pkcs12.h>
#include <openssl/x509v3.h>
#include <climits>
#include <limits>
#include <string_view>
namespace kandelo::crypto {
struct X509Error : Error {
  X509Error(const char* message, const char* code) : Error(message) { SetNodeCode(code); }
};
// Pinned Node26.13.0 crypto_pkcs12.cc parser policy, shared by public crypto
// and the distinct TLS-pfx caller. The helper owns every OpenSSL result; its
// callers decide whether key-only/cert-only bundles satisfy their API.
struct PKCS12Contents {
  ncrypto::EVPKeyPointer key;
  ncrypto::X509Pointer cert;
  ncrypto::StackOfX509 ca;
};
enum class PKCS12ParseError { NOT_RECOGNIZED, UNSUPPORTED_ALGORITHM, FAILED };
using PKCS12ParseResult = ncrypto::Result<PKCS12Contents, PKCS12ParseError>;
inline ncrypto::BIOPointer LoadPKCS12BIO(const unsigned char* bytes, size_t length) {
  auto bio = ncrypto::BIOPointer::NewSecMem();
  if (!bio || length > INT_MAX) return {};
  const char empty = 0;
  const int written = ncrypto::BIOPointer::Write(&bio,
      std::string_view(length ? reinterpret_cast<const char*>(bytes) : &empty, length));
  if (written < 0 || size_t(written) != length) return {};
  return bio;
}
inline PKCS12ParseResult ParsePKCS12Bundle(const ncrypto::BIOPointer& bio, const char* pass) {
  using PKCS12Pointer = ncrypto::DeleteFnPtr<PKCS12, PKCS12_free>;
  ncrypto::ClearErrorOnReturn clear;
  if (!bio) return PKCS12ParseResult(PKCS12ParseError::FAILED, ERR_get_error());
  PKCS12* raw = nullptr;
  if (!d2i_PKCS12_bio(bio.get(), &raw) || !raw)
    return PKCS12ParseResult(PKCS12ParseError::NOT_RECOGNIZED, ERR_get_error());
  PKCS12Pointer p12(raw);
  EVP_PKEY* key = nullptr;X509* cert = nullptr;STACK_OF(X509)* ca = nullptr;
  const int status = PKCS12_parse(p12.get(), pass, &key, &cert, &ca);
  // OpenSSL clears failed key/cert outputs, but a partially built CA stack
  // still belongs to the caller. Adopt all non-null outputs on either result.
  PKCS12Contents contents;contents.key.reset(key);contents.cert.reset(cert);contents.ca.reset(ca);
  if (!status) {
    const unsigned long error = ERR_get_error();
#ifdef OPENSSL_IS_BORINGSSL
    if (ERR_GET_LIB(error) == ERR_LIB_PKCS8 && ERR_GET_REASON(error) == PKCS8_R_BAD_PKCS12_DATA)
      return PKCS12ParseResult(PKCS12ParseError::NOT_RECOGNIZED, error);
#endif
#if OPENSSL_VERSION_MAJOR >= 3
    if (ERR_GET_REASON(error) == ERR_R_UNSUPPORTED)
      return PKCS12ParseResult(PKCS12ParseError::UNSUPPORTED_ALGORITHM, error);
#endif
    return PKCS12ParseResult(PKCS12ParseError::FAILED, error);
  }
  return PKCS12ParseResult(std::move(contents));
}
inline PKCS12Contents ParseCryptoPKCS12(const ncrypto::BIOPointer& bio, const char* pass) {
  if (!bio) throw X509Error("Unable to read PKCS#12 data", "ERR_CRYPTO_OPERATION_FAILED");
  auto parsed = ParsePKCS12Bundle(bio, pass);
  if (parsed) return std::move(parsed.value);
  if (parsed.error == PKCS12ParseError::NOT_RECOGNIZED)
    throw X509Error("Input is not a valid PKCS#12 structure", "ERR_CRYPTO_OPERATION_FAILED");
  if (parsed.error == PKCS12ParseError::UNSUPPORTED_ALGORITHM)
    throw X509Error("PKCS#12 bundle uses an unsupported algorithm; it may require the OpenSSL legacy provider", "ERR_CRYPTO_UNSUPPORTED_OPERATION");
  const unsigned long error = parsed.openssl_error.value_or(0);
  if (error) { char message[256];ERR_error_string_n(error,message,sizeof(message));throw Error(message,error); }
  throw Error("Unable to parse PKCS#12 data");
}
// The parser owns an actual ncrypto/OpenSSL certificate after this call. No
// caller bytes, JS roots, context or guessed certificate metadata are retained.
class X509Material {
  ncrypto::X509Pointer certificate_;
  kandelo::memory::Allocation material_{sizeof(X509Material)};
  kandelo::memory::Claim claim_;
  static std::optional<std::string> Text(ncrypto::BIOPointer bio) {
    if (!bio) return std::nullopt;
    BUF_MEM* mem = bio;
    if (!mem) return std::nullopt;
    return mem->length ? std::string(mem->data, mem->length) : std::string{};
  }
 public:
  X509Material(ncrypto::X509Pointer certificate, const kandelo::memory::AccountHandle& account)
      : certificate_(std::move(certificate)), claim_(material_.Handle(), account) {}
  static std::shared_ptr<X509Material> Parse(const unsigned char* bytes, size_t length,
      const kandelo::memory::AccountHandle& account) {
    // Pinned ArrayBufferViewContents::Read substitutes real stack storage
    // when an empty/detached view has a null data pointer. BIO treats a null
    // pointer as invalid even at length zero; preserve the actual empty span.
    unsigned char empty = 0;
    if (!bytes && length == 0) bytes = &empty;
    auto parsed = ncrypto::X509Pointer::Parse({bytes, length});
    if (!parsed.value) {
      const auto number = static_cast<unsigned long>(parsed.error.value_or(0));
      if (number) { char text[256]; ERR_error_string_n(number, text, sizeof(text)); throw Error(text, number); }
      throw Error("Failed to parse X509 certificate");
    }
    // A separate new requests exactly sizeof(X509Material); the shared_ptr
    // control block and OpenSSL-internal allocations are not accounted here.
    return std::shared_ptr<X509Material>(new X509Material(std::move(parsed.value), account));
  }
  const kandelo::memory::RecordHandle& Record() const noexcept { return material_.Handle(); }
  ncrypto::X509View View() const { return certificate_.view(); }
  std::optional<std::string> String(std::string_view field) const {
    const auto cert = View();
    if (field == "subject") return Text(cert.getSubject());
    if (field == "issuer") return Text(cert.getIssuer());
    if (field == "subjectAltName") {
      bool present = false; auto bio = cert.getSubjectAltName(&present);
      if (!bio && present) throw X509Error("Failed to format subject alternative name", "ERR_CRYPTO_OPERATION_FAILED");
      return Text(std::move(bio));
    }
    if (field == "infoAccess") return Text(cert.getInfoAccess());
    if (field == "validFrom") return Text(cert.getValidFrom());
    if (field == "validTo") return Text(cert.getValidTo());
    if (field == "pem") return Text(cert.toPEM());
    if (field == "fingerprint") return cert.getFingerprint(ncrypto::Digest::SHA1);
    if (field == "fingerprint256") return cert.getFingerprint(ncrypto::Digest::SHA256);
    if (field == "fingerprint512") return cert.getFingerprint(ncrypto::Digest::SHA512);
    if (field == "signatureAlgorithm") { auto value=cert.getSignatureAlgorithm(); return value ? std::optional<std::string>(*value) : std::nullopt; }
    if (field == "signatureAlgorithmOid") return cert.getSignatureAlgorithmOID();
    if (field == "serialNumber") {
      auto serial=cert.getSerialNumber(); if (!serial) return std::nullopt;
      std::string text(serial.get<char>());
      for(char& c:text) if(c>='a'&&c<='z') c=char(c-('a'-'A'));
      return text;
    }
    throw X509Error("X509 certificate method is not implemented", "ERR_METHOD_NOT_IMPLEMENTED");
  }
  double Date(bool from) const {
    const auto value = from ? View().getValidFromTime() : View().getValidToTime();
    return value ? double(*value) * 1000. : std::numeric_limits<double>::quiet_NaN();
  }
  bool CA() const { return View().isCA(); }
  std::optional<std::vector<std::string>> KeyUsage() const {
    std::vector<std::string> values;
    if (!View().enumUsages([&](const char* text) { values.emplace_back(text); })) return std::nullopt;
    return values;
  }
  std::optional<std::vector<unsigned char>> Raw() const {
    auto bio=View().toDER(); if(!bio)return std::nullopt;BUF_MEM* mem=bio;
    if(!mem)return std::nullopt;
    const auto* data=reinterpret_cast<const unsigned char*>(mem->data);
    return mem->length ? std::vector<unsigned char>(data,data+mem->length) : std::vector<unsigned char>{};
  }
  ncrypto::EVPKeyPointer PublicKey() const {
    auto key=View().getPublicKey();
    if(!key.value){const auto number=static_cast<unsigned long>(key.error.value_or(0));if(number){char text[256];ERR_error_string_n(number,text,sizeof(text));throw Error(text,number);}throw Error("Failed to obtain certificate public key");}
    return std::move(key.value);
  }
};
} // namespace kandelo::crypto
#endif
