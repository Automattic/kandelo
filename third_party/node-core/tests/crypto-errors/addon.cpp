// Tiny real queue and worker handoff control; not a guest engine substitute.
#include "napi-error.h"
#include <openssl/pemerr.h>
#include <openssl/evperr.h>
#include <cassert>
#include <thread>
using namespace kandelo::crypto;
napi_value Operation(napi_env env,napi_callback_info info) {
  size_t count=1;napi_value input;int32_t mode=0;
  napi_get_cb_info(env,info,&count,&input,nullptr,nullptr);
  napi_get_value_int32(env,input,&mode);
  ERR_clear_error();
  CryptoErrorStore captured;
  if(mode==3)captured.SetNodeErrorCode("ERR_CRYPTO_INVALID_STATE");
  if(mode==1||mode==2) {
    ERR_raise(ERR_LIB_EVP,EVP_R_BAD_DECRYPT);
    const auto mainNumber=ERR_peek_error();
    std::thread worker([&]{
      assert(ERR_peek_error()==0);
      ERR_raise(ERR_LIB_PEM,PEM_R_NO_START_LINE);
      ERR_raise(ERR_LIB_EVP,EVP_R_BAD_DECRYPT);
      captured.Capture();assert(ERR_peek_error()==0);
    });worker.join();
    assert(ERR_peek_error()==mainNumber);ERR_clear_error();
  }
  auto error=Error::FromCaptured(std::move(captured),mode==2?std::optional<std::string>("worker failed"):std::nullopt);
  return test::MakeError(env,error);
}
napi_value Init(napi_env env,napi_value exports) {
  napi_value fn;napi_create_function(env,"operation",NAPI_AUTO_LENGTH,Operation,nullptr,&fn);
  napi_set_named_property(env,exports,"operation",fn);return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
