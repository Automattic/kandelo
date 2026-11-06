/* Read the actual Node/libuv loop cache without advancing it. Test-only owner. */
#include <node_api.h>
#include <uv.h>
static napi_value CachedNow(napi_env env, napi_callback_info info) {
  (void)info;
  uv_loop_t* loop;
  napi_value result;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok ||
      napi_create_bigint_uint64(env, uv_now(loop), &result) != napi_ok) return NULL;
  return result;
}
static napi_value UpdateNow(napi_env env, napi_callback_info info) {
  uv_loop_t* loop;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok) return NULL;
  uv_update_time(loop);
  return CachedNow(env, info);
}
static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    { "cachedNow", NULL, CachedNow, NULL, NULL, NULL, napi_default, NULL },
    { "updateNow", NULL, UpdateNow, NULL, NULL, NULL, napi_default, NULL },
  };
  if (napi_define_properties(env, exports, 2, methods) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(stat_watcher_clock, Init)
