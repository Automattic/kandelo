#include <node_api.h>
#include "tls-owner.h"
#include <array>

static napi_value Check(napi_env env, napi_callback_info) {
  using namespace kandelo;
  std::array<bool, 9> facts;
  tls::Owner owner(1, tls::OwnedContext(SSL_CTX_new(TLS_method())), tls::OwnedSSL{});
  socket::Owner parent(2);
  facts[0] = owner.State() == tls::Owner::Phase::Preparing && owner.Ssl() == nullptr;
  facts[1] = !owner.AttachParent(parent);
  facts[2] = owner.InitializeSsl() && owner.Ssl() != nullptr;
  auto* original = owner.Ssl();
  facts[3] = !owner.InitializeSsl() && owner.Ssl() == original;
  facts[4] = owner.AttachParent(parent);
  facts[5] = !owner.InitializeSsl() && owner.Ssl() == original;
  owner.Close(false);
  facts[6] = owner.Ssl() == nullptr && owner.State() == tls::Owner::Phase::Closed;
  facts[7] = !owner.InitializeSsl();
  tls::Owner empty(3, tls::OwnedContext{}, tls::OwnedSSL{});
  facts[8] = !empty.InitializeSsl() && empty.Ssl() == nullptr;
  napi_value array;
  napi_create_array_with_length(env, facts.size(), &array);
  for (size_t i = 0; i < facts.size(); ++i) {
    napi_value value;
    napi_get_boolean(env, facts[i], &value);
    napi_set_element(env, array, i, value);
  }
  return array;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_value check;
  napi_create_function(env, "check", NAPI_AUTO_LENGTH, Check, nullptr, &check);
  napi_set_named_property(env, exports, "check", check);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
