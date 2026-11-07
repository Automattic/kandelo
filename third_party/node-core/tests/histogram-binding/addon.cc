#include "histogram-owner-inl.h"
// Host-only N-API transport control. This exercises the same portable binding
// dispatch and real native owners; it does not validate SpiderMonkey JSAPI.
#include <node_api.h>
#include "histogram-binding.h"
#include <cstring>
using namespace kandelo::histogram;
namespace memory = kandelo::memory;
namespace {
struct Env {
  napi_ref prototype = nullptr, setPrototype = nullptr, mapSet = nullptr;
  memory::AccountHandle memoryAccount = std::make_shared<memory::Account>();
  memory::CreditBalance credit;
};
const napi_type_tag tag = {UINT64_C(0x2d85893376456198), UINT64_C(0xa98921dbee12aee2)};
void Check(napi_status status) { if (status != napi_ok) throw std::runtime_error("N-API control failure"); }
napi_value Undefined(napi_env env) { napi_value v; Check(napi_get_undefined(env, &v)); return v; }
napi_value String(napi_env env, const char* text) { napi_value v; Check(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &v)); return v; }
napi_value Number(napi_env env, double n) { napi_value v; Check(napi_create_double(env, n, &v)); return v; }
std::string Text(napi_env env, napi_value value) {
  size_t length; Check(napi_get_value_string_utf8(env, value, nullptr, 0, &length));
  std::vector<char> bytes(length + 1); Check(napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length));
  return std::string(bytes.data(), length);
}
double Double(napi_env env, napi_value v) { double n; Check(napi_get_value_double(env, v, &n)); return n; }
int64_t Integer(napi_env env, napi_value v, const char* message) {
  napi_valuetype type; Check(napi_typeof(env, v, &type)); int64_t n;
  if (type == napi_bigint) { bool lossless; Check(napi_get_value_bigint_int64(env, v, &n, &lossless)); if (!lossless) HistogramBindingRange(message); return n; }
  double value = Double(env, v);
  if (std::isnan(value)) return 0;
  if (value >= double(INT64_MAX)) return INT64_MAX;
  if (value <= double(INT64_MIN)) return INT64_MIN;
  return int64_t(value);
}
bool Bool(napi_env env, napi_value value) { bool v; Check(napi_get_value_bool(env, value, &v)); return v; }
void Set(napi_env env, napi_value object, const char* key, napi_value value) { Check(napi_set_named_property(env, object, key, value)); }
napi_value Object(napi_env env) { napi_value value; Check(napi_create_object(env, &value)); return value; }
napi_value Get(napi_env env, napi_ref reference) { napi_value value; Check(napi_get_reference_value(env, reference, &value)); return value; }
void Prototype(napi_env env, Env* state, napi_value object, napi_value proto) {
  napi_value args[] = {object, proto}, ignored;
  Check(napi_call_function(env, Undefined(env), Get(env, state->setPrototype), 2, args, &ignored));
}
void SyncNativeMemory(napi_env env, Env* state) {
  int64_t ignored;
  state->credit.Flush(state->memoryAccount->Desired(),
      [&](size_t bytes) { Check(napi_adjust_external_memory(env, int64_t(bytes), &ignored)); },
      [&](size_t bytes) { Check(napi_adjust_external_memory(env, -int64_t(bytes), &ignored)); });
}
struct WrappedOwner {
  std::unique_ptr<HistogramBindingState> owner;
  size_t associated;
};
void Finalize(napi_env env, void* data, void*) {
  auto* wrapped = static_cast<WrappedOwner*>(data); int64_t ignored;
  napi_adjust_external_memory(env, -int64_t(wrapped->associated), &ignored); delete wrapped;
}
napi_value Own(napi_env env, Env* state, std::unique_ptr<HistogramBindingState> owner, napi_value proto = nullptr) {
  napi_value object = Object(env);
  Prototype(env, state, object, proto ? proto : Get(env, state->prototype));
  Check(napi_type_tag_object(env, object, &tag));
  owner->ClaimMemory(state->memoryAccount);
  auto wrapped = std::make_unique<WrappedOwner>(); wrapped->associated = sizeof(WrappedOwner) + owner->MaterialBytes();
  wrapped->owner = std::move(owner);
  int64_t ignored; Check(napi_adjust_external_memory(env, int64_t(wrapped->associated), &ignored));
  napi_status status = napi_wrap(env, object, wrapped.get(), Finalize, nullptr, nullptr);
  if (status != napi_ok) { napi_adjust_external_memory(env, -int64_t(wrapped->associated), &ignored); Check(status); }
  wrapped.release(); SyncNativeMemory(env, state); return object;
}
HistogramBindingState* Owner(napi_env env, napi_value value) {
  bool matches; Check(napi_check_object_type_tag(env, value, &tag, &matches));
  if (!matches) throw std::runtime_error("Invalid native histogram receiver");
  void* owner; Check(napi_unwrap(env, value, &owner)); return static_cast<WrappedOwner*>(owner)->owner.get();
}
napi_value Big(napi_env env, int64_t n) { napi_value value; Check(napi_create_bigint_int64(env, n, &value)); return value; }
napi_value Big(napi_env env, uint64_t n) { napi_value value; Check(napi_create_bigint_uint64(env, n, &value)); return value; }
napi_value Doubles(napi_env env, const std::vector<double>& values, bool typed = false) {
  napi_value result;
  if (typed) {
    napi_value buffer; void* data;
    Check(napi_create_arraybuffer(env, values.size() * sizeof(double), &data, &buffer));
    if (!values.empty()) memcpy(data, values.data(), values.size() * sizeof(double));
    Check(napi_create_typedarray(env, napi_float64_array, values.size(), buffer, 0, &result));
  } else {
    Check(napi_create_array_with_length(env, values.size(), &result));
    for (size_t i = 0; i < values.size(); ++i) {
      const auto key = std::to_string(i);
      napi_property_descriptor own = {key.c_str(), nullptr, nullptr, nullptr, nullptr,
          Number(env, values[i]), napi_default_jsproperty, nullptr};
      Check(napi_define_properties(env, result, 1, &own));
    }
  }
  return result;
}
std::vector<double> ReadDoubles(napi_env env, napi_value value) {
  napi_typedarray_type type; size_t length, offset; void* data; napi_value buffer;
  Check(napi_get_typedarray_info(env, value, &type, &length, &data, &buffer, &offset));
  if (type != napi_float64_array) throw std::runtime_error("Expected Float64Array");
  return std::vector<double>(static_cast<double*>(data), static_cast<double*>(data) + length);
}
napi_value Packet(napi_env env, napi_value value) { auto p = Object(env); Set(env, p, "value", value); return p; }
napi_value Error(napi_env env, const HistogramBindingError& error) {
  auto p = Object(env), e = Object(env);
  Set(env, e, "code", String(env, error.code)); Set(env, e, "name", String(env, error.name));
  Set(env, e, "message", String(env, error.message)); Set(env, p, "error", e); return p;
}
napi_value Result(napi_env env, Env* state, const HistogramBindingResult& result, napi_value map) {
  if (std::holds_alternative<std::monostate>(result)) return Undefined(env);
  if (auto* n = std::get_if<double>(&result)) return Number(env, *n);
  if (auto* n = std::get_if<HistogramBindingInteger>(&result)) return n->big ? Big(env, n->value) : Number(env, double(n->value));
  if (auto* n = std::get_if<HistogramBindingUnsigned>(&result)) return n->big ? Big(env, n->value) : Number(env, double(n->value));
  if (auto* a = std::get_if<HistogramBindingNumbers>(&result)) return Doubles(env, a->values);
  if (auto* a = std::get_if<HistogramBindingEntries>(&result)) {
    for (auto [key, count] : a->values) {
      napi_value args[] = {Number(env, key), a->big ? Big(env, count) : Number(env, double(count))}, ignored;
      Check(napi_call_function(env, map, Get(env, state->mapSet), 2, args, &ignored));
    }
    return Undefined(env);
  }
  if (auto* bytes = std::get_if<std::vector<uint8_t>>(&result)) {
    napi_value buffer, array; void* data;
    Check(napi_create_arraybuffer(env, bytes->size(), &data, &buffer));
    if (!bytes->empty()) memcpy(data, bytes->data(), bytes->size());
    Check(napi_create_typedarray(env, napi_uint8_array, bytes->size(), buffer, 0, &array)); return array;
  }
  auto owner = std::make_unique<HistogramBindingState>(); owner->histogram = std::get<std::shared_ptr<Histogram>>(result);
  if (!owner->histogram) throw std::bad_alloc(); return Own(env, state, std::move(owner));
}
struct Work {
  Env* state;
  napi_env env = nullptr;
  std::unique_ptr<HistogramQrdeWork> work;
  std::vector<double> probabilities;
  uint32_t mode;
  napi_async_work task = nullptr;
  napi_ref callback = nullptr;
  bool failed = false;
  memory::Allocation retained;
  std::unique_ptr<memory::Claim> claim;
  void AccountMemory() { retained.Resize(sizeof(*this) + (claim ? sizeof(memory::Claim) : 0) + probabilities.capacity() * sizeof(double)); }
  ~Work() {
    if (callback) napi_delete_reference(env, callback);
    if (task) napi_delete_async_work(env, task);
  }
};
void Execute(napi_env, void* data) {
  auto* w = static_cast<Work*>(data);
  try { w->work->Run(); } catch (...) { w->failed = true; }
  w->AccountMemory();
}
void Complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Work> w(static_cast<Work*>(data));
  try {
    SyncNativeMemory(env, w->state);
    napi_value packet;
    if (status != napi_ok || w->failed) packet = Error(env, HistogramBindingError("ERR_OPERATION_FAILED", "Error", "QRDE job failed"));
    else {
      auto value = Object(env); napi_value null; Check(napi_get_null(env, &null)); Prototype(env, w->state, value, null);
      const auto& r = w->work->result(); const auto& s = w->work->snapshot();
      Set(env, value, "probabilities", Doubles(env, w->probabilities, true));
      Set(env, value, "quantiles", Doubles(env, r.quantiles, true)); Set(env, value, "densities", Doubles(env, r.densities, true));
      Set(env, value, "count", Big(env, s.total_count)); Set(env, value, "bucketCount", Number(env, s.buckets.size()));
      Set(env, value, "corrections", Number(env, r.corrections)); Set(env, value, "dequantize", String(env, w->mode == 0 ? "none" : w->mode == 1 ? "hdr" : "all"));
      packet = Packet(env, value);
    }
    napi_value ignored; Check(napi_call_function(env, Undefined(env), Get(env, w->callback), 1, &packet, &ignored));
  } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); }
  auto* state = w->state; w.reset();
  try { SyncNativeMemory(env, state); } catch (...) { napi_throw_error(env, nullptr, "N-API memory projection failed"); }
}
napi_value Dispatch(napi_env env, napi_callback_info info) {
  napi_value args[10]; size_t argc = 10; void* data;
  Check(napi_get_cb_info(env, info, &argc, args, nullptr, &data)); auto* state = static_cast<Env*>(data);
  for (size_t i = argc; i < 10; ++i) args[i] = Undefined(env);
  try {
    SyncNativeMemory(env, state);
    std::string name = Text(env, args[0]);
    if (name == "configure") { if (state->prototype) Check(napi_delete_reference(env, state->prototype)); Check(napi_create_reference(env, args[1], 1, &state->prototype)); return Packet(env, Undefined(env)); }
    if (name == "create" || name == "createWindow") {
      Histogram::Options options{Integer(env, args[2], "options.lowest is out of range"), Integer(env, args[3], "options.highest is out of range"), int(Integer(env, args[4], "options.figures is out of range"))};
      std::unique_ptr<HistogramBindingState> owner;
      if (name == "create") { options.half_life = Double(env, args[5]); options.threshold = Integer(env, args[6], "options.threshold is out of range"); owner = HistogramBindingCreate(options); }
      else { uint64_t rotate; bool lossless; Check(napi_get_value_bigint_uint64(env, args[7], &rotate, &lossless)); if (!lossless) HistogramBindingRange("rotation interval is out of range"); owner = HistogramBindingWindow(options, Integer(env, args[5], "options.chunks is out of range"), Bool(env, args[6]), rotate); }
      return Packet(env, Own(env, state, std::move(owner), args[1]));
    }
    if (name == "import") {
      napi_typedarray_type type; size_t length, offset; void* bytes; napi_value buffer;
      Check(napi_get_typedarray_info(env, args[2], &type, &length, &bytes, &buffer, &offset));
      auto owner = std::make_unique<HistogramBindingState>(); owner->histogram = HistogramBindingImport(static_cast<uint8_t*>(bytes), length);
      return Packet(env, Own(env, state, std::move(owner)));
    }
    auto* owner = Owner(env, args[1]);
    if (name == "qrde") {
      auto w = std::make_unique<Work>(); w->state = state; w->env = env; w->probabilities = ReadDoubles(env, args[2]); w->mode = uint32_t(Double(env, args[3]));
      w->work = std::make_unique<HistogramQrdeWork>(owner->histogram, w->probabilities, QrdeDequantization(w->mode), Bool(env, args[4]));
      w->AccountMemory();
      w->claim = std::make_unique<memory::Claim>(w->retained.Handle(), state->memoryAccount);
      w->AccountMemory();
      Check(napi_create_reference(env, args[5], 1, &w->callback));
      Check(napi_create_async_work(env, nullptr, String(env, "histogram.qrde.control"), Execute, Complete, w.get(), &w->task));
      Check(napi_queue_async_work(env, w->task)); w.release(); SyncNativeMemory(env, state); return Packet(env, Undefined(env));
    }
    double number = 0, confidence = .95; napi_valuetype type;
    Check(napi_typeof(env, args[2], &type)); if (type == napi_number) number = Double(env, args[2]);
    Check(napi_typeof(env, args[3], &type)); if (type == napi_number) confidence = Double(env, args[3]);
    int64_t integer = 0, interval = 0;
    if (name == "record" || name == "recordCorrected" || name == "cdf" || name == "countAt" || name == "linearBuckets" || name == "logBuckets") integer = Integer(env, args[2], "value is out of range");
    if ((name == "record" || name == "recordCorrected") && integer < 0) HistogramBindingRange("value is out of range");
    if (name == "recordCorrected") { interval = Integer(env, args[3], "expected_interval is out of range"); if (interval <= 0) HistogramBindingRange("expected_interval is out of range"); }
    if (name == "logBuckets") number = Double(env, args[3]);
    const Histogram* other = nullptr;
    if (name == "add" || name == "subtract" || name == "diff" || name == "ksTest" || name == "cohensD" || name == "cliffsD" || name == "welchTest" || name == "mannWhitneyTest") { other = Owner(env, args[2])->histogram.get(); if (name == "welchTest") number = Double(env, args[3]); }
    napi_value map = nullptr; std::vector<double> ps;
    if (name == "percentiles" || name == "percentilesBigInt" || name == "percentilesAt") map = args[2];
    if (name == "percentilesAt") ps = ReadDoubles(env, args[3]);
    if (name == "linearBuckets") map = args[3]; if (name == "logBuckets") map = args[4];
    auto result = HistogramBindingDispatch(name, *owner, number, integer, interval, other, ps, confidence);
    SyncNativeMemory(env, state);
    return Packet(env, Result(env, state, result, map));
  } catch (const HistogramBindingError& error) { return Error(env, error); }
  catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
void EnvFinalize(napi_env env, void* data, void*) {
  auto* state = static_cast<Env*>(data);
  state->memoryAccount->Detach();
  int64_t ignored;
  state->credit.Flush(0, [](size_t) { std::abort(); },
      [&](size_t bytes) { napi_adjust_external_memory(env, -int64_t(bytes), &ignored); });
  for (auto ref : {state->prototype, state->setPrototype, state->mapSet}) if (ref) napi_delete_reference(env, ref);
  delete state;
}
napi_value Init(napi_env env, napi_value exports) {
  auto* state = new Env(); napi_value global, object, map, proto, function;
  Check(napi_get_global(env, &global)); Check(napi_get_named_property(env, global, "Object", &object));
  Check(napi_get_named_property(env, object, "setPrototypeOf", &function)); Check(napi_create_reference(env, function, 1, &state->setPrototype));
  Check(napi_get_named_property(env, global, "Map", &map)); Check(napi_get_named_property(env, map, "prototype", &proto));
  Check(napi_get_named_property(env, proto, "set", &function)); Check(napi_create_reference(env, function, 1, &state->mapSet));
  Check(napi_set_instance_data(env, state, EnvFinalize, nullptr));
  Check(napi_create_function(env, "histogramOperation", NAPI_AUTO_LENGTH, Dispatch, state, &function));
  Set(env, exports, "histogramOperation", function); return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
