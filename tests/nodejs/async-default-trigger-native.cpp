// Focused actual native numeric owner via NAPI. SpiderMonkey accessors,
// promise metadata/realms and context lifetime still require engine integration.
#include <node_api.h>
#include "async-default-trigger.h"
#include <cstdlib>
struct State { kandelo::async::DefaultTrigger trigger; };
static State* Get(napi_env env) {
  void* state = nullptr; if (napi_get_instance_data(env, &state) != napi_ok) std::abort();
  return static_cast<State*>(state);
}
static napi_value Op(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; void* tag;
  if (napi_get_cb_info(env, info, &count, args, nullptr, &tag) != napi_ok) std::abort();
  double input;
  if (count != 1 || napi_get_value_double(env, args[0], &input) != napi_ok) {
    napi_throw_type_error(env, nullptr, "default trigger requires number"); return nullptr;
  }
  auto& state = Get(env)->trigger; double output;
  if (tag) {
    if (!state.Swap(input, &output)) { napi_throw_range_error(env, nullptr, "default trigger requires safe ID or -1"); return nullptr; }
  } else output = state.Resolve(input);
  napi_value result; if (napi_create_double(env, output, &result) != napi_ok) std::abort(); return result;
}
static napi_value Init(napi_env env, napi_value exports) {
  auto* state = new State;
  if (napi_set_instance_data(env, state, [](napi_env, void* data, void*) { delete static_cast<State*>(data); }, nullptr) != napi_ok) std::abort();
  napi_property_descriptor methods[] = {
    {"resolve",nullptr,Op,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"swap",nullptr,Op,nullptr,nullptr,nullptr,napi_default,reinterpret_cast<void*>(1)}
  };
  if (napi_define_properties(env, exports, 2, methods) != napi_ok) std::abort();
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
