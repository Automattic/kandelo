#include "../../../third_party/node-core/random-operations.h"
#include <iostream>
#include <openssl/randerr.h>
#include <future>
#include <stdexcept>
int main() {
  try {
    ERR_raise(ERR_LIB_RAND, RAND_R_ARGUMENT_OUT_OF_RANGE);
    try { kandelo::crypto::Fail("missing error"); }
    catch (const kandelo::crypto::Error& error) {
      if(error.code!="ERR_OSSL_RAND_ARGUMENT_OUT_OF_RANGE" || error.library.empty() || error.reason.empty())
        throw std::runtime_error("Random error mapping lost actual metadata");
    }
    if(ERR_peek_error()!=0)throw std::runtime_error("Error queue was not consumed");
    kandelo::crypto::SecureBytes regular(128);
    if (regular.secure()) throw std::runtime_error("Unexpected preexisting secure heap");
    for (size_t i=0;i<regular.size();++i) if (regular.data()[i]) throw std::runtime_error("Allocation not zeroed");
    auto run=[] { kandelo::crypto::Bytes bytes;bytes.value.resize(128);kandelo::crypto::FillRandom(bytes.value.data(),bytes.value.size());return bytes; };
    std::promise<void> start; auto ready=start.get_future().share();
    std::vector<std::future<void>> workers;
    for(int worker=0;worker<8;++worker) workers.push_back(std::async(std::launch::async,[ready] {
      ready.wait();
      for(int i=0;i<64;++i){
        unsigned char bytes[32]; kandelo::crypto::FillRandom(bytes,sizeof(bytes));
        ERR_raise(ERR_LIB_RAND,RAND_R_ARGUMENT_OUT_OF_RANGE);
        std::this_thread::yield();
        const auto number=ERR_get_error();
        if(ERR_GET_LIB(number)!=ERR_LIB_RAND || ERR_GET_REASON(number)!=RAND_R_ARGUMENT_OUT_OF_RANGE || ERR_peek_error()!=0)
          throw std::runtime_error("Thread-local OpenSSL errors leaked");
      }
    }));
    start.set_value();for(auto& worker:workers)worker.get();
    auto pending=std::async(std::launch::async,run);auto first=run();auto second=pending.get();
    if (first.value==second.value) throw std::runtime_error("Repeated random output");
    if (!CRYPTO_secure_malloc_init(16384,16)) throw std::runtime_error("Secure heap initialization failed");
    { kandelo::crypto::SecureBytes secure(128);if(!secure.secure()||CRYPTO_secure_used()<128)throw std::runtime_error("Secure provenance lost");kandelo::crypto::FillRandom(secure.data(),secure.size()); }
    if(CRYPTO_secure_used()!=0 || !CRYPTO_secure_malloc_done())throw std::runtime_error("Secure ownership not retired");
    std::cout << "{\"version\":\"" << OpenSSL_version(OPENSSL_VERSION) << "\",\"randomBytes\":256,\"worker\":true,\"concurrentJobs\":512,\"threadLocalErrors\":512,\"zeroedFallback\":true,\"secureProvenance\":true,\"retired\":true}\n";
  }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
