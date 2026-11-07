// Actual portable streaming owner; N-API acquisition is an explicit test boundary.
#include "../../signature-operations.h"
#include "../crypto-errors/napi-error.h"
#include <node_api.h>
using namespace kandelo::crypto;
struct Pending {};
static void Check(napi_status s) { if (s != napi_ok) throw Pending{}; }
static bool Undefined(napi_env e, napi_value v) { napi_valuetype t; Check(napi_typeof(e, v, &t)); return t == napi_undefined || t == napi_null; }
static std::string Text(napi_env e, napi_value v) {
  size_t n; Check(napi_get_value_string_utf8(e, v, nullptr, 0, &n));
  std::string s(n + 1, '\0'); Check(napi_get_value_string_utf8(e, v, s.data(), s.size(), &n)); s.resize(n); return s;
}
struct Span { const unsigned char* data; size_t length; };
static Span View(napi_env e, napi_value v) {
  bool yes; void* data; size_t length; Check(napi_is_typedarray(e, v, &yes));
  if (yes) {
    napi_typedarray_type type; napi_value buffer; size_t offset;
    Check(napi_get_typedarray_info(e, v, &type, &length, &data, &buffer, &offset));
    size_t width = 1;
    switch (type) {
      case napi_int16_array: case napi_uint16_array: case napi_float16_array: width = 2; break;
      case napi_int32_array: case napi_uint32_array: case napi_float32_array: width = 4; break;
      case napi_float64_array: case napi_bigint64_array: case napi_biguint64_array: width = 8; break;
      default: break;
    }
    return {static_cast<unsigned char*>(data), length * width};
  }
  Check(napi_is_dataview(e, v, &yes));
  if (yes) { napi_value buffer; size_t offset; Check(napi_get_dataview_info(e, v, &length, &data, &buffer, &offset)); }
  else Check(napi_get_arraybuffer_info(e, v, &data, &length));
  return {static_cast<unsigned char*>(data), length};
}
static Bytes Copy(Span s) { Bytes b; b.value.resize(s.length); for (size_t i = 0; i < s.length; i++) b.value[i] = __atomic_load_n(s.data + i, __ATOMIC_RELAXED); return b; }
static void Finalize(napi_env, void* state, void*) { delete static_cast<SignatureState*>(state); }
static napi_value Operation(napi_env env, napi_callback_info info) {
  napi_value result, error; Check(napi_get_undefined(env, &result)); Check(napi_get_undefined(env, &error));
  try {
    ncrypto::ClearErrorOnReturn clear;
    size_t count = 12; napi_value a[12]; for (auto& v : a) Check(napi_get_undefined(env, &v));
    Check(napi_get_cb_info(env, info, &count, a, nullptr, nullptr));
    const auto op = Text(env, a[0]);
    if (op == "new") {
      auto state = std::make_unique<SignatureState>(); Check(napi_create_object(env, &result));
      Check(napi_wrap(env, result, state.get(), Finalize, nullptr, nullptr)); state.release();
    } else {
      void* pointer; Check(napi_unwrap(env, a[1], &pointer)); auto* state = static_cast<SignatureState*>(pointer);
      if (op == "init") state->Init(Text(env, a[2]).c_str());
      else if (op == "update") { auto input = Copy(View(env, a[2])); state->Update(input.value.data(), input.value.size()); }
      else {
        const bool verify = op == "verify";
        int32_t format = 1, type = 1;
        if (!Undefined(env, a[3])) Check(napi_get_value_int32(env, a[3], &format));
        if (!Undefined(env, a[4])) Check(napi_get_value_int32(env, a[4], &type));
        auto bytes = Copy(View(env, a[2]));
        const bool hasPassword = !Undefined(env, a[5]); Bytes password = hasPassword ? Copy(View(env, a[5])) : Bytes{};
        auto key = KeyMaterial::Parse(!verify, bytes, KeyMaterial::Configuration(format, type, hasPassword ? &password : nullptr));
        SignatureState::CheckKey(key->asymmetric);
        const size_t offset = verify ? 8 : 7;
        int32_t padding = key->asymmetric.getDefaultSignPadding(), encoding;
        if (!Undefined(env, a[offset])) Check(napi_get_value_int32(env, a[offset], &padding));
        std::optional<int> salt;
        if (!Undefined(env, a[offset + 1])) { int32_t v; Check(napi_get_value_int32(env, a[offset + 1], &v)); salt = v; }
        Check(napi_get_value_int32(env, a[offset + 2], &encoding));
        if (verify) {
          auto signature = Copy(View(env, a[7])); static const unsigned char empty = 0;
          const bool value = state->Verify(key->asymmetric, signature.value.empty() ? &empty : signature.value.data(), signature.value.size(), padding, salt, encoding == 1);
          Check(napi_get_boolean(env, value, &result));
        } else {
          const auto signature = state->Sign(key->asymmetric, padding, salt, encoding == 1);
          Check(napi_create_buffer_copy(env, signature.size(), signature.data(), nullptr, &result));
        }
      }
    }
  } catch (const Error& failure) { error = kandelo::crypto::test::MakeError(env, failure); if (!error) return nullptr; }
  catch (const Pending&) { return nullptr; }
  catch (const std::exception& failure) { napi_throw_error(env, nullptr, failure.what()); return nullptr; }
  napi_value packet; Check(napi_create_object(env, &packet));
  Check(napi_set_named_property(env, packet, "value", result)); Check(napi_set_named_property(env, packet, "error", error)); return packet;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn; Check(napi_create_function(env, "operation", NAPI_AUTO_LENGTH, Operation, nullptr, &fn));
  Check(napi_set_named_property(env, exports, "operation", fn)); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
