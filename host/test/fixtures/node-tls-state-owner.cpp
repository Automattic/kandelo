#include "kandelo-node-tls-state.h"
#include <openssl/err.h>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

static void Check(bool ok, const char* message) {
  if (!ok) { ERR_print_errors_fp(stderr); throw std::runtime_error(message); }
}
static std::string Hex(const std::vector<uint8_t>& bytes) {
  std::string out; const char* digits="0123456789abcdef";
  for(auto b:bytes) { out+=digits[b>>4]; out+=digits[b&15]; } return out;
}
int main(int argc,char** argv) {
  try {
    Check(argc==4,"arguments");
    using Context=std::unique_ptr<SSL_CTX,decltype(&SSL_CTX_free)>;
    using Connection=std::unique_ptr<SSL,decltype(&SSL_free)>;
    Context server(SSL_CTX_new(TLS_server_method()),SSL_CTX_free), client(SSL_CTX_new(TLS_client_method()),SSL_CTX_free);
    Check(bool(server)&&bool(client),"contexts");
    const int version=std::string(argv[2])=="TLSv1.2"?TLS1_2_VERSION:TLS1_3_VERSION;
    for(SSL_CTX* ctx:{server.get(),client.get()}) {
      Check(SSL_CTX_set_min_proto_version(ctx,version)&&SSL_CTX_set_max_proto_version(ctx,version),"versions");
      Check(SSL_CTX_set_cipher_list(ctx,"ECDHE-RSA-AES128-GCM-SHA256"),"cipher list");
      Check(SSL_CTX_set_ciphersuites(ctx,"TLS_AES_128_GCM_SHA256"),"cipher suites");
    }
    const std::string root=argv[1];
    Check(SSL_CTX_use_certificate_chain_file(server.get(),(root+"/agent1-cert.pem").c_str())==1,"certificate");
    Check(SSL_CTX_use_PrivateKey_file(server.get(),(root+"/agent1-key.pem").c_str(),SSL_FILETYPE_PEM)==1,"key");
    if(std::string(argv[3])=="trusted") Check(SSL_CTX_load_verify_locations(client.get(),(root+"/ca1-cert.pem").c_str(),nullptr)==1,"trust");
    // Match the current client transport's allowed-error mode. Verification
    // still runs; its result, rather than this policy, controls metadata.
    SSL_CTX_set_verify(client.get(),SSL_VERIFY_NONE,kandelo::tls::ContinueVerification);
    Connection a(SSL_new(client.get()),SSL_free),b(SSL_new(server.get()),SSL_free);
    Check(bool(a)&&bool(b),"connections");
    Check(kandelo::tls::VerifyPeer(a.get())==X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT,"no peer is not authorized");
    Check(kandelo::tls::Finished(a.get(),false).empty(),"no Finished before handshake");
    Check(SSL_set1_host(a.get(),"agent1")==1,"identity");
    BIO* first;BIO* second;Check(BIO_new_bio_pair(&first,0,&second,0)==1,"BIO pair");
    SSL_set_bio(a.get(),first,first);SSL_set_bio(b.get(),second,second);
    SSL_set_connect_state(a.get());SSL_set_accept_state(b.get());
    for(int i=0;i<10000&&(!SSL_is_init_finished(a.get())||!SSL_is_init_finished(b.get()));i++) {
      for(SSL* ssl:{a.get(),b.get()}) {
        if(SSL_is_init_finished(ssl))continue;
        int result=SSL_do_handshake(ssl);
        if(result!=1) { int error=SSL_get_error(ssl,result);Check(error==SSL_ERROR_WANT_READ||error==SSL_ERROR_WANT_WRITE,"handshake"); }
      }
    }
    Check(SSL_is_init_finished(a.get())&&SSL_is_init_finished(b.get()),"handshake did not finish");
    const auto local=kandelo::tls::Finished(a.get(),false),peer=kandelo::tls::Finished(a.get(),true);
    Check(local==kandelo::tls::Finished(b.get(),true),"client Finished bytes");
    Check(peer==kandelo::tls::Finished(b.get(),false),"server Finished bytes");
    auto changed=local;Check(!changed.empty(),"empty Finished");changed[0]^=255;
    Check(local==kandelo::tls::Finished(a.get(),false),"caller mutation changed live SSL");
    const auto* cipher=SSL_get_current_cipher(a.get());Check(cipher!=nullptr,"cipher");
    long verify=kandelo::tls::VerifyPeer(a.get());
    std::cout<<SSL_get_version(a.get())<<'\n'<<SSL_CIPHER_get_name(cipher)<<'\n'<<SSL_CIPHER_standard_name(cipher)<<'\n'<<SSL_CIPHER_get_version(cipher)<<'\n'<<(SSL_session_reused(a.get())?"true":"false")<<'\n'<<(verify==X509_V_OK?"OK":kandelo::tls::VerificationErrorCode(int32_t(verify)))<<'\n'<<Hex(local)<<'\n'<<Hex(peer)<<'\n';
    return 0;
  } catch(const std::exception& error) { std::cerr<<error.what()<<'\n';return 1; }
}
