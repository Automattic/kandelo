// Real histogram JSAPI owners; included after native-work/callback and before
// native-ports in the private shell embedding. No JS executes on pool threads.
#include "histogram-binding.h"
#include "js/BigInt.h"
#include "js/GlobalObject.h"
#include "js/MapAndSet.h"
#include <map>
namespace {
using kandelo::histogram::Histogram;
using kandelo::histogram::HistogramBindingState;
using kandelo::histogram::HistogramBindingError;
using kandelo::histogram::HistogramBindingRange;
using kandelo::histogram::HistogramBindingResult;
static void KandeloHistogramFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);
  if (!slot.isUndefined()) {
    auto* state = static_cast<HistogramBindingState*>(slot.toPrivate());
    JS::RemoveAssociatedMemory(object, size_t(JS::GetReservedSlot(object, 1).toDouble()), JS::MemoryUse::Embedding3);
    delete state;
  }
}
static const JSClassOps KandeloHistogramClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloHistogramFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloHistogramClass = {"Histogram",
  JSCLASS_HAS_RESERVED_SLOTS(2) | JSCLASS_FOREGROUND_FINALIZE, &KandeloHistogramClassOps};
static const JSClass KandeloHistogramWindowClass = {"SlidingWindowHistogram",
  JSCLASS_HAS_RESERVED_SLOTS(2) | JSCLASS_FOREGROUND_FINALIZE, &KandeloHistogramClassOps};
// Rooted prototypes belong to the owning context, and are retired before that
// context is destroyed. Serialized messages contain native material only.
struct KandeloHistogramRealm {
  JS::PersistentRootedObject global;
  JS::PersistentRootedObject prototype;
  KandeloHistogramRealm(JSContext* cx, JSObject* prototype)
      : global(cx, JS::CurrentGlobalOrNull(cx)), prototype(cx, prototype) {}
};
static thread_local std::map<JSContext*, std::vector<std::unique_ptr<KandeloHistogramRealm>>> kandeloHistogramRealms;
static void KandeloShutdownHistograms(JSContext* cx) { kandeloHistogramRealms.erase(cx); }
static JSObject* KandeloHistogramPrototype(JSContext* cx) {
  auto found = kandeloHistogramRealms.find(cx);
  if (found != kandeloHistogramRealms.end()) {
    JSObject* global = JS::CurrentGlobalOrNull(cx);
    for (const auto& realm : found->second)
      if (realm->global == global) return realm->prototype;
  }
  JS_ReportErrorASCII(cx, "Histogram binding is not configured in this realm"); return nullptr;
}
static HistogramBindingState* KandeloHistogramState(JSContext* cx, HandleValue value,
                                                    MutableHandleObject object) {
  if (!value.isObject()) { JS_ReportErrorASCII(cx, "Invalid native histogram receiver"); return nullptr; }
  object.set(js::CheckedUnwrapDynamic(&value.toObject(), cx));
  if (!object || (JS::GetClass(object) != &KandeloHistogramClass &&
                 JS::GetClass(object) != &KandeloHistogramWindowClass)) {
    JS_ReportErrorASCII(cx, "Invalid native histogram receiver"); return nullptr;
  }
  const auto slot = JS::GetReservedSlot(object, 0);
  if (slot.isUndefined()) { JS_ReportErrorASCII(cx, "Uninitialized native histogram"); return nullptr; }
  return static_cast<HistogramBindingState*>(slot.toPrivate());
}
static void KandeloHistogramAccount(HandleObject object, HistogramBindingState* owner) {
  size_t previous = size_t(JS::GetReservedSlot(object, 1).toDouble());
  size_t actual = owner->MaterialBytes();
  if (actual > previous) JS::AddAssociatedMemory(object, actual - previous, JS::MemoryUse::Embedding3);
  else if (previous > actual) JS::RemoveAssociatedMemory(object, previous - actual, JS::MemoryUse::Embedding3);
  JS::SetReservedSlot(object, 1, DoubleValue(double(actual)));
}
static bool KandeloHistogramOwn(JSContext* cx, std::unique_ptr<HistogramBindingState> owner,
    HandleObject prototype, MutableHandleValue output) {
  RootedObject object(cx, JS_NewObjectWithGivenProto(cx,
      owner->window ? &KandeloHistogramWindowClass : &KandeloHistogramClass, prototype));
  if (!object) return false;
  auto account = KandeloNativeMemoryOwner(cx);
  if (!account) { JS_ReportErrorASCII(cx, "Histogram binding has no registered native memory environment"); return false; }
  owner->ClaimMemory(account);
  size_t bytes = owner->MaterialBytes();
  JS::SetReservedSlot(object, 1, DoubleValue(double(bytes)));
  JS::AddAssociatedMemory(object, bytes, JS::MemoryUse::Embedding3);
  JS::SetReservedSlot(object, 0, PrivateValue(owner.release()));
  output.setObject(*object); KandeloFlushNativeMemory(cx); return true;
}
static bool KandeloHistogramOwnShared(JSContext* cx, std::shared_ptr<Histogram> histogram,
                                      MutableHandleValue output) {
  if (!histogram) { JS_ReportOutOfMemory(cx); return false; }
  auto owner = std::make_unique<HistogramBindingState>(); owner->histogram = std::move(histogram);
  RootedObject prototype(cx, KandeloHistogramPrototype(cx));
  return prototype && KandeloHistogramOwn(cx, std::move(owner), prototype, output);
}
static bool KandeloHistogramString(JSContext* cx, HandleObject object, const char* key, const char* value) {
  RootedString text(cx, JS_NewStringCopyZ(cx, value));
  return text && JS_DefineProperty(cx, object, key, text, JSPROP_ENUMERATE);
}
static bool KandeloHistogramError(JSContext* cx, const char* code, const char* name,
                                  const char* message, MutableHandleValue output) {
  RootedObject error(cx, JS_NewPlainObject(cx));
  RootedObject packet(cx, JS_NewPlainObject(cx));
  if (!error || !packet || (code && !KandeloHistogramString(cx, error, "code", code)) ||
      !KandeloHistogramString(cx, error, "name", name) ||
      !KandeloHistogramString(cx, error, "message", message) ||
      !JS_DefineProperty(cx, packet, "error", error, JSPROP_ENUMERATE)) return false;
  output.setObject(*packet); return true;
}
static bool KandeloHistogramPacket(JSContext* cx, HandleValue value, MutableHandleValue output) {
  RootedObject packet(cx, JS_NewPlainObject(cx));
  if (!packet || !JS_DefineProperty(cx, packet, "value", value, JSPROP_ENUMERATE)) return false;
  output.setObject(*packet); return true;
}
static int64_t KandeloHistogramInteger(HandleValue value, const char* message) {
  int64_t integer;
  if (value.isBigInt()) {
    if (!JS::BigIntFits(value.toBigInt(), &integer)) HistogramBindingRange(message);
    return integer;
  }
  if (!value.isNumber()) throw HistogramBindingError("ERR_INVALID_ARG_TYPE", "TypeError", message);
  // V8's Number -> IntegerValue path truncates finite fractions and saturates
  // the int64 bounds. Never invoke undefined C++ float-to-int overflow.
  double number = value.toNumber();
  if (std::isnan(number)) return 0;
  if (number >= double(INT64_MAX)) return INT64_MAX;
  if (number <= double(INT64_MIN)) return INT64_MIN;
  return int64_t(number);
}
static bool KandeloHistogramBig(JSContext* cx, int64_t integer, MutableHandleValue value) {
  auto* big = JS::NumberToBigInt(cx, integer); if (!big) return false;
  value.setBigInt(big); return true;
}
static bool KandeloHistogramBig(JSContext* cx, uint64_t integer, MutableHandleValue value) {
  auto* big = JS::NumberToBigInt(cx, integer); if (!big) return false;
  value.setBigInt(big); return true;
}
static bool KandeloHistogramNumbers(JSContext* cx, const std::vector<double>& numbers,
                                    MutableHandleValue output, bool typed = false) {
  RootedObject result(cx, typed ? JS_NewFloat64Array(cx, numbers.size()) : JS::NewArrayObject(cx, numbers.size()));
  if (!result) return false;
  for (size_t i = 0; i < numbers.size(); ++i) {
    RootedValue number(cx, DoubleValue(numbers[i]));
    // Native Array::Set in the pinned owner creates own dense elements.
    // Define rather than [[Set]] so inherited setters cannot intercept them.
    if (typed ? !JS_SetElement(cx, result, i, number)
              : !JS_DefineElement(cx, result, i, number, JSPROP_ENUMERATE)) return false;
  }
  output.setObject(*result); return true;
}
static bool KandeloHistogramCopyDoubles(JSContext* cx, HandleValue value, std::vector<double>* values) {
  if (!value.isObject() || !JS_IsFloat64Array(&value.toObject())) {
    JS_ReportErrorASCII(cx, "Histogram requires Float64Array storage"); return false;
  }
  RootedObject view(cx, &value.toObject());
  size_t length = JS_GetTypedArrayLength(view);
  values->resize(length);
  bool shared;
  {
    JS::AutoCheckCannotGC nogc;
    const double* data = JS_GetFloat64ArrayData(view, &shared, nogc);
    if (length && !data) return false;
    if (!shared) for (size_t i = 0; i < length; ++i) (*values)[i] = data[i];
  }
  // Public construction provides private fixed Float64Array storage. Reject a
  // direct shared native-call argument instead of racing nonatomic doubles.
  if (shared) {
    JS_ReportErrorASCII(cx, "Histogram probability storage must be private"); return false;
  }
  return true;
}
static bool KandeloHistogramResult(JSContext* cx, const HistogramBindingResult& result,
                                    HandleObject map, MutableHandleValue output) {
  using namespace kandelo::histogram;
  if (std::holds_alternative<std::monostate>(result)) { output.setUndefined(); return true; }
  if (auto* n = std::get_if<double>(&result)) { output.setNumber(*n); return true; }
  if (auto* n = std::get_if<HistogramBindingInteger>(&result)) {
    if (n->big) return KandeloHistogramBig(cx, n->value, output);
    output.setNumber(double(n->value)); return true;
  }
  if (auto* n = std::get_if<HistogramBindingUnsigned>(&result)) {
    if (n->big) return KandeloHistogramBig(cx, n->value, output);
    output.setNumber(double(n->value)); return true;
  }
  if (auto* numbers = std::get_if<HistogramBindingNumbers>(&result))
    return KandeloHistogramNumbers(cx, numbers->values, output);
  if (auto* entries = std::get_if<HistogramBindingEntries>(&result)) {
    for (const auto& [key, integer] : entries->values) {
      RootedValue k(cx, DoubleValue(key)), v(cx, DoubleValue(double(integer)));
      if (entries->big && !KandeloHistogramBig(cx, integer, &v)) return false;
      if (!JS::MapSet(cx, map, k, v)) return false;
    }
    output.setUndefined(); return true;
  }
  if (auto* bytes = std::get_if<std::vector<uint8_t>>(&result)) {
    RootedObject view(cx, JS_NewUint8Array(cx, bytes->size())); if (!view) return false;
    JS::AutoCheckCannotGC nogc; bool shared;
    auto* data = JS_GetUint8ArrayData(view, &shared, nogc);
    if (!bytes->empty()) memcpy(data, bytes->data(), bytes->size());
    output.setObject(*view); return true;
  }
  return KandeloHistogramOwnShared(cx, std::get<std::shared_ptr<Histogram>>(result), output);
}

struct KandeloHistogramQrdeWork final : js::shell::KandeloNativeWork {
  Histogram::RecordedSnapshotSource source;
  std::shared_ptr<Histogram> cacheTarget;
  std::shared_ptr<const Histogram::RecordedSnapshot> snapshot;
  kandelo::histogram::QrdeResult qrdeResult;
  std::vector<double> probabilities;
  uint32_t mode;
  JS::PersistentRootedObject callback;
  kandelo::memory::Allocation retained;
  std::unique_ptr<kandelo::memory::Claim> claim;
  KandeloHistogramQrdeWork(JSContext* cx, HandleObject callback,
      std::shared_ptr<Histogram> histogram, std::vector<double> probabilities,
      uint32_t mode, bool cache)
      : source(histogram->GetRecordedSnapshotSource(cache)),
        cacheTarget(cache && !source.cache_hit ? histogram : nullptr),
        probabilities(std::move(probabilities)), mode(mode), callback(cx, callback) {
    if (!source.histogram && !source.snapshot) throw std::bad_alloc();
    retained.Resize(MaterialBytes());
    claim = std::make_unique<kandelo::memory::Claim>(retained.Handle(), KandeloNativeMemoryOwner(cx));
    retained.Resize(MaterialBytes()); KandeloFlushNativeMemory(cx);
  }
  size_t MaterialBytes() const {
    size_t bytes = sizeof(*this) + (claim ? sizeof(kandelo::memory::Claim) : 0) + probabilities.capacity() * sizeof(double) +
        qrdeResult.quantiles.capacity() * sizeof(double) + qrdeResult.densities.capacity() * sizeof(double);
    return bytes;
  }
  void Run() override {
    auto account = mozilla::MakeScopeExit([&] { retained.Resize(MaterialBytes()); });
    if (source.snapshot) snapshot = std::move(source.snapshot);
    else {
      snapshot = std::make_shared<const Histogram::RecordedSnapshot>(
          Histogram::BuildRecordedSnapshot(source.histogram.get()));
      source.histogram.reset(); source.capturedHdrRetained.Resize(0);
    }
    if (cacheTarget) {
      cacheTarget->CacheRecordedSnapshot(source.generation, snapshot); cacheTarget.reset();
    }
    qrdeResult = kandelo::histogram::CalculateHistogramQrde(*snapshot, probabilities,
        kandelo::histogram::QrdeDequantization(mode));
  }
  bool Complete(JSContext* cx) override {
    RootedObject environment(cx, KandeloNativeMemoryEnvironment(cx)), deliver(cx, callback);
    if (!environment) { JS_ReportErrorASCII(cx, "QRDE completion has no live environment"); return false; }
    JSAutoRealm realm(cx, environment);
    KandeloFlushNativeMemory(cx);
    // Pinned AfterThreadPoolWork creates the actual zero-ID execution resource
    // now, in env->context(), rather than rooting a submitter/VM realm object.
    RootedObject owner(cx, JS_NewPlainObject(cx)); if (!owner) return false;
    KandeloNativeInternalCallbackScope scope(cx, owner);
    if (!scope.Enter()) return scope.Stopped();
    // Worker allocations change only native ledger counters. GC API calls
    // occur here on the owner thread and at real embedding checkpoints.
    retained.Resize(MaterialBytes()); KandeloFlushNativeMemory(cx);
    RootedValue packet(cx), value(cx);
    if (failure != Failure::None) {
      if (!KandeloHistogramError(cx, failure == Failure::Cancelled ? nullptr : "ERR_MEMORY_ALLOCATION_FAILED",
          "Error", failure == Failure::Cancelled ? "QRDE job was canceled" : "QRDE job failed", &packet)) return false;
    } else {
      RootedObject result(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
      if (!result) return false;
      const auto& data = qrdeResult;
      const std::pair<const char*, const std::vector<double>*> arrays[] = {
          {"probabilities", &probabilities}, {"quantiles", &data.quantiles},
          {"densities", &data.densities}};
      for (auto item : arrays) {
        if (!KandeloHistogramNumbers(cx, *item.second, &value, true) ||
            !JS_DefineProperty(cx, result, item.first, value, JSPROP_ENUMERATE)) return false;
      }
      if (!KandeloHistogramBig(cx, snapshot->total_count, &value) ||
          !JS_DefineProperty(cx, result, "count", value, JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx, result, "bucketCount", double(snapshot->buckets.size()), JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx, result, "corrections", double(data.corrections), JSPROP_ENUMERATE) ||
          !KandeloHistogramString(cx, result, "dequantize", mode == 0 ? "none" : mode == 1 ? "hdr" : "all")) return false;
      value.setObject(*result);
      if (!KandeloHistogramPacket(cx, value, &packet)) return false;
    }
    RootedValue callbackValue(cx, ObjectValue(*deliver)), ignored(cx);
    // The resolver can belong to a submitting VM compartment. Calling it from
    // the primary environment requires its real cross-compartment wrapper.
    if (!JS_WrapValue(cx, &callbackValue)) return false;
    JS::RootedValueArray<1> arguments(cx); arguments[0].set(packet);
    const bool delivered = JS_CallFunctionValue(cx, owner, callbackValue, arguments, &ignored);
    // Match resolver_.Reset() before InternalCallbackScope retires/checkpoints.
    callback.reset();
    if (!delivered) return false;
    return scope.Close();
  }
  void Cancel(JSContext*) override {
    // Queue shutdown first joins worker execution. Never settle a Promise or
    // call JS after environment teardown; releasing roots retires this job.
    callback.reset(); source.histogram.reset(); source.capturedHdrRetained.Resize(0); source.snapshot.reset();
    snapshot.reset(); cacheTarget.reset();
  }
};

static bool KandeloHistogramDispatch(JSContext* cx, const CallArgs& args, MutableHandleValue output) {
  using namespace kandelo::histogram;
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "Histogram operation name required"); return false; }
  RootedString op(cx, args[0].toString()); JS::UniqueChars encoded = JS_EncodeStringToUTF8(cx, op);
  if (!encoded) return false;
  std::string name(encoded.get());
  if (name == "configure") {
    if (!args.get(1).isObject()) return false;
    auto realm = std::make_unique<KandeloHistogramRealm>(cx, &args[1].toObject());
    auto& realms = kandeloHistogramRealms[cx];
    bool replaced = false;
    for (auto& current : realms) if (current->global == realm->global) {
      current = std::move(realm); replaced = true; break;
    }
    if (!replaced) realms.push_back(std::move(realm));
    output.setUndefined(); return true;
  }
  if (name == "create" || name == "createWindow") {
    if (!args.get(1).isObject()) return false;
    Histogram::Options options;
    options.lowest = KandeloHistogramInteger(args.get(2), "options.lowest is out of range");
    options.highest = KandeloHistogramInteger(args.get(3), "options.highest is out of range");
    options.figures = int(KandeloHistogramInteger(args.get(4), "options.figures is out of range"));
    std::unique_ptr<HistogramBindingState> owner;
    if (name == "create") {
      options.half_life = args.get(5).toNumber();
      options.threshold = KandeloHistogramInteger(args.get(6), "options.threshold is out of range");
      owner = HistogramBindingCreate(options);
    } else {
      uint64_t rotate;
      if (!args.get(7).isBigInt() || !JS::BigIntFits(args[7].toBigInt(), &rotate)) HistogramBindingRange("rotation interval is out of range");
      owner = HistogramBindingWindow(options, size_t(KandeloHistogramInteger(args.get(5), "options.chunks is out of range")), args[6].toBoolean(), rotate);
    }
    RootedObject prototype(cx, &args[1].toObject());
    return KandeloHistogramOwn(cx, std::move(owner), prototype, output);
  }
  if (name == "import") {
    if (!args.get(2).isObject() || !JS_IsUint8Array(&args[2].toObject()))
      throw HistogramBindingError("ERR_INVALID_ARG_TYPE", "TypeError", "data must be a Uint8Array");
    RootedObject view(cx, &args[2].toObject());
    size_t length = JS_GetTypedArrayLength(view); std::vector<uint8_t> bytes(length);
    {
      JS::AutoCheckCannotGC nogc; bool shared;
      const auto* data = JS_GetUint8ArrayData(view, &shared, nogc);
      if (length && !data) return false;
      for (size_t i = 0; i < length; ++i) bytes[i] = shared ? __atomic_load_n(data + i, __ATOMIC_RELAXED) : data[i];
    }
    return KandeloHistogramOwnShared(cx, HistogramBindingImport(bytes.data(), bytes.size()), output);
  }
  RootedObject object(cx);
  auto* owner = KandeloHistogramState(cx, args.get(1), &object); if (!owner) return false;
  if (name == "qrde") {
    if (!owner->histogram || !args.get(5).isObject() || !JS::IsCallable(&args[5].toObject())) return false;
    std::vector<double> ps; if (!KandeloHistogramCopyDoubles(cx, args.get(2), &ps)) return false;
    int64_t mode = KandeloHistogramInteger(args.get(3), "Invalid QRDE mode");
    if (mode < 0 || mode > 2 || ps.size() < 2 || ps.size() > 1001 || ps.front() != 0 || ps.back() != 1)
      throw HistogramBindingError("ERR_INVALID_ARG_VALUE", "TypeError", "Invalid QRDE options");
    for (size_t i = 1; i < ps.size(); ++i)
      if (!std::isfinite(ps[i]) || ps[i] <= ps[i - 1])
        throw HistogramBindingError("ERR_INVALID_ARG_VALUE", "TypeError", "Invalid QRDE probabilities");
    RootedObject callback(cx, &args[5].toObject());
    auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
    auto work = std::make_unique<KandeloHistogramQrdeWork>(cx, callback,
        owner->histogram, std::move(ps), uint32_t(mode), args[4].toBoolean());
    if (!queue->Submit(work.get())) throw HistogramBindingError("ERR_OPERATION_FAILED", "Error", "QRDE work queue is closing");
    work.release(); output.setUndefined(); return true;
  }
  double number = args.get(2).isNumber() ? args[2].toNumber() : 0;
  double confidence = args.get(3).isNumber() ? args[3].toNumber() : .95;
  int64_t integer = 0, interval = 0;
  if (name == "record" || name == "recordCorrected" || name == "countAt" || name == "cdf" || name == "linearBuckets" || name == "logBuckets")
    integer = KandeloHistogramInteger(args.get(2), "value is out of range");
  if ((name == "record" || name == "recordCorrected") && integer < 0) HistogramBindingRange("value is out of range");
  if (name == "recordCorrected") {
    interval = KandeloHistogramInteger(args.get(3), "expected_interval is out of range");
    if (interval <= 0) HistogramBindingRange("expected_interval is out of range");
  }
  if (name == "logBuckets") number = args[3].toNumber();
  const Histogram* other = nullptr; RootedObject otherObject(cx);
  if (name == "add" || name == "subtract" || name == "diff" || name == "ksTest" || name == "cohensD" || name == "cliffsD" || name == "welchTest" || name == "mannWhitneyTest") {
    auto* state = KandeloHistogramState(cx, args.get(2), &otherObject);
    if (!state || !state->histogram) return false;
    other = state->histogram.get();
    if (name == "welchTest") number = args[3].toNumber();
  }
  RootedObject map(cx); std::vector<double> ps;
  if (name == "percentiles" || name == "percentilesBigInt" || name == "percentilesAt") map = &args[2].toObject();
  if (name == "percentilesAt" && !KandeloHistogramCopyDoubles(cx, args.get(3), &ps)) return false;
  if (name == "linearBuckets") map = &args[3].toObject();
  if (name == "logBuckets") map = &args[4].toObject();
  auto result = HistogramBindingDispatch(name, *owner, number, integer, interval, other, ps, confidence);
  KandeloHistogramAccount(object, owner); KandeloFlushNativeMemory(cx);
  return KandeloHistogramResult(cx, result, map, output);
}
static bool KandeloNativeHistogramOperation(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); RootedValue value(cx);
  try {
    if (!KandeloHistogramDispatch(cx, args, &value)) return false;
    return KandeloHistogramPacket(cx, value, args.rval());
  } catch (const HistogramBindingError& error) {
    return KandeloHistogramError(cx, error.code, error.name, error.message, args.rval());
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
}  // namespace
