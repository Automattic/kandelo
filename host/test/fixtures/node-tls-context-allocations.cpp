// Focused real OpenSSL allocator faults; not production JSAPI/GC proof.
#include "kandelo-node-tls-context-trust.h"
#include <openssl/crypto.h>
#include <cstddef>
#include <cstdlib>
#include <iostream>
#include <limits>
struct alignas(std::max_align_t) Allocation { size_t size; };
static size_t live=0,bytes=0,attempts=0;
static long fault=-1;
static bool injected=false;
static void* Allocate(size_t size,const char*,int){
 if(fault>=0&&attempts++==size_t(fault)){injected=true;return nullptr;}
 if(size>std::numeric_limits<size_t>::max()-sizeof(Allocation))return nullptr;
 auto* p=static_cast<Allocation*>(std::malloc(sizeof(Allocation)+size));if(!p)return nullptr;
 p->size=size;live++;bytes+=size;return p+1;
}
static void Release(void* data,const char*,int){if(!data)return;auto* p=static_cast<Allocation*>(data)-1;live--;bytes-=p->size;std::free(p);}
static void* Reallocate(void* data,size_t size,const char* file,int line){
 if(!data)return Allocate(size,file,line);if(!size){Release(data,file,line);return nullptr;}
 if(fault>=0&&attempts++==size_t(fault)){injected=true;return nullptr;}
 if(size>std::numeric_limits<size_t>::max()-sizeof(Allocation))return nullptr;
 auto* p=static_cast<Allocation*>(data)-1;const size_t old=p->size;
 p=static_cast<Allocation*>(std::realloc(p,sizeof(Allocation)+size));if(!p)return nullptr;
 p->size=size;bytes=bytes-old+size;return p+1;
}
int main(int argc,char** argv){
 if(argc!=2||CRYPTO_set_mem_functions(Allocate,Reallocate,Release)!=1)return 2;
 if(OpenSSL_version_num()!=OPENSSL_VERSION_NUMBER)return 3;
 auto owner=kandelo::tls::NewTrustContext();if(!owner)return 4;
 SSL_CTX* claimed=owner.get();if(SSL_CTX_up_ref(claimed)!=1)return 5;
 owner.reset(); // Only the real claimed native reference keeps material alive.
 fault=std::strtol(argv[1],nullptr,10);attempts=0;
 SSL* ssl=SSL_new(claimed);fault=-1;
 const bool failed=ssl==nullptr;if(ssl)SSL_free(ssl);SSL_CTX_free(claimed);
 OPENSSL_thread_stop();OPENSSL_cleanup();
 std::cout<<"{\"faultIndex\":"<<argv[1]<<",\"faultInjected\":"<<(injected?"true":"false")<<",\"sslNewFailed\":"<<(failed?"true":"false")<<",\"liveAllocationsAfterCleanup\":"<<live<<",\"liveBytesAfterCleanup\":"<<bytes<<"}\n";
 return live||bytes?1:0;
}
