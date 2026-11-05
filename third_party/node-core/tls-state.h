// Read-only TLS metadata from the actual live OpenSSL connection.
#ifndef KANDELO_NODE_TLS_STATE_H
#define KANDELO_NODE_TLS_STATE_H
#include <cstdint>
#include <openssl/ssl.h>
#include <vector>
namespace kandelo::tls {
// When the caller allows verification errors, finish verification exactly as
// Node's VerifyCallback does, retaining the last actual error. The default
// rejecting context keeps OpenSSL's aborting callback.
inline int ContinueVerification(int, X509_STORE_CTX*) { return 1; }

// Node's ncrypto SSLPointer::verifyPeerCertificate distinguishes a missing
// certificate from successful verification, including resumed/PSK sessions.
inline long
VerifyPeer(SSL* ssl)
{
  X509* cert = SSL_get1_peer_certificate(ssl);
  if (cert) {
    X509_free(cert);
    return SSL_get_verify_result(ssl);
  }
  const SSL_CIPHER* cipher = SSL_get_current_cipher(ssl);
  const SSL_SESSION* session = SSL_get_session(ssl);
  if ((cipher && SSL_CIPHER_get_auth_nid(cipher) == NID_auth_psk) ||
      (session && SSL_SESSION_get_protocol_version(session) == TLS1_3_VERSION &&
       SSL_session_reused(ssl)))
    return X509_V_OK;
  return X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT;
}
// Use a real byte for the size query, as the target does: some OpenSSL
// implementations propagate the destination to memcpy even for zero bytes.
inline std::vector<uint8_t>
Finished(SSL* ssl, bool peer)
{
  unsigned char dummy[1];
  size_t size = peer ? SSL_get_peer_finished(ssl, dummy, sizeof dummy)
                     : SSL_get_finished(ssl, dummy, sizeof dummy);
  std::vector<uint8_t> bytes(size);
  if (size) {
    if (peer)
      SSL_get_peer_finished(ssl, bytes.data(), bytes.size());
    else
      SSL_get_finished(ssl, bytes.data(), bytes.size());
  }
  return bytes;
}
// NODE_TLS_VERIFY_ERROR_CODE
}
#endif
