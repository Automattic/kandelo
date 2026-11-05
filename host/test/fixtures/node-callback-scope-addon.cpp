// Native-reference fixture: actual libuv timer plus Node-API MakeCallback.
// This is not a guest addon loader or a replacement guest async provider.
#include <node_api.h>
#include <uv.h>
#include <cassert>

struct Request {
  napi_env env;
  uv_timer_t timer;
  napi_ref resource, callback, done;
  napi_async_context context;
};
static bool Check(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  napi_throw_error(env, nullptr, "Native callback-scope control operation failed");
  return false;
}
static napi_value Run(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], result;
  if (!Check(env, napi_get_cb_info(env, info, &count, args, nullptr, nullptr))) return nullptr;
  assert(count == 2);
  napi_value name;
  if (!Check(env, napi_create_string_utf8(env, "KandeloCallbackScopeControl", NAPI_AUTO_LENGTH, &name))) return nullptr;
  napi_async_context context;
  if (!Check(env, napi_async_init(env, args[0], name, &context))) return nullptr;
  const auto status = napi_make_callback(env, context, args[0], args[1], 0, nullptr, &result);
  napi_value exception = nullptr;
  if (status == napi_pending_exception) assert(napi_get_and_clear_last_exception(env, &exception) == napi_ok);
  assert(napi_async_destroy(env, context) == napi_ok);
  napi_value retired;
  assert(napi_get_boolean(env, true, &retired) == napi_ok);
  assert(napi_set_named_property(env, args[0], "retired", retired) == napi_ok);
  if (exception) { assert(napi_throw(env, exception) == napi_ok); return nullptr; }
  if (!Check(env, status)) return nullptr;
  return result;
}
static void Timer(uv_timer_t* timer) {
  auto* request = static_cast<Request*>(timer->data);
  napi_env env = request->env;
  napi_handle_scope handles;
  assert(napi_open_handle_scope(env, &handles) == napi_ok);
  napi_value resource, callback, done, result, retired;
  assert(napi_get_reference_value(env, request->resource, &resource) == napi_ok);
  assert(napi_get_reference_value(env, request->callback, &callback) == napi_ok);
  assert(napi_get_reference_value(env, request->done, &done) == napi_ok);
  // No surrounding Node timer callback scope: this is a genuine outermost
  // native MakeCallback, so its tick/microtask checkpoint occurs here.
  assert(napi_make_callback(env, request->context, resource, callback, 0, nullptr, &result) == napi_ok);
  assert(napi_async_destroy(env, request->context) == napi_ok);
  assert(napi_get_boolean(env, true, &retired) == napi_ok);
  assert(napi_set_named_property(env, resource, "retired", retired) == napi_ok);
  // Test bookkeeping after the actual callback scope and resource retirement.
  assert(napi_call_function(env, resource, done, 0, nullptr, &result) == napi_ok);
  assert(napi_delete_reference(env, request->resource) == napi_ok);
  assert(napi_delete_reference(env, request->callback) == napi_ok);
  assert(napi_delete_reference(env, request->done) == napi_ok);
  assert(napi_close_handle_scope(env, handles) == napi_ok);
  uv_close(reinterpret_cast<uv_handle_t*>(timer), [](uv_handle_t* handle) {
    delete static_cast<Request*>(handle->data);
  });
}
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3], name, result;
  if (!Check(env, napi_get_cb_info(env, info, &count, args, nullptr, nullptr))) return nullptr;
  assert(count == 3);
  auto* request = new Request{};
  request->env = env;
  assert(napi_create_reference(env, args[0], 1, &request->resource) == napi_ok);
  assert(napi_create_reference(env, args[1], 1, &request->callback) == napi_ok);
  assert(napi_create_reference(env, args[2], 1, &request->done) == napi_ok);
  assert(napi_create_string_utf8(env, "KandeloCallbackScopeControl", NAPI_AUTO_LENGTH, &name) == napi_ok);
  assert(napi_async_init(env, args[0], name, &request->context) == napi_ok);
  uv_loop_t* loop;
  assert(napi_get_uv_event_loop(env, &loop) == napi_ok);
  assert(uv_timer_init(loop, &request->timer) == 0);
  request->timer.data = request;
  assert(uv_timer_start(&request->timer, Timer, 0, 0) == 0);
  assert(napi_get_undefined(env, &result) == napi_ok);
  return result;
}
NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"run", nullptr, Run, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  assert(napi_define_properties(env, exports, 2, methods) == napi_ok);
  return exports;
}
