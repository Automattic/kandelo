/* Native compression-handle embedding for the pinned Node codec contexts.
 * Algorithms and their license are in kandelo-node-codec-contexts.h, generated
 * from unchanged Node excerpts. This file is included in the SM shell after its
 * JS namespace declarations. Source candidate only: not compiled or validated.
 */
#include <cmath>
#include <cstring>

namespace {
namespace codec = kandelo::codecs;

// Slots retain JS values through the collector. Never cache a typed-array data
// pointer across a call that can run JS, detach a buffer, or collect the heap.
enum CodecSlot {
  CodecNativeState, CodecWriteState, CodecWriteCallback,
  CodecLastInput, CodecLastOutput, CodecContextFrame, CodecSlots
};

struct KandeloCodecContextDelete {
  void operator()(codec::CodecContext* context) const { js_delete(context); }
};
template <typename T>
using KandeloCodecPtr = std::unique_ptr<T, KandeloCodecContextDelete>;

struct KandeloCodecState : codec::CompressionStreamMemoryOwner {
  KandeloCodecPtr<codec::CodecContext> context;
  int mode;
  bool initialized = false;
  bool initStarted = false;
  bool closed = false;
  bool writing = false;
  bool pendingClose = false;
  size_t reportedBytes = 0;
  size_t inputOffset = 0, outputOffset = 0;
  uint32_t inputRemaining = 0, outputRemaining = 0;
  // Actual original allocations, independent of current view metadata. The
  // remaining input/output survive to params(); write state survives to close.
  JS::KandeloBacking::SpanRef inputBacking, outputBacking, writeBacking;
  js::shell::KandeloNativeAsyncState* asyncLifetime = nullptr;
  double asyncId = -1, triggerId = -1;

  explicit KandeloCodecState(int mode) : mode(mode) {}
  ~KandeloCodecState() {
    MOZ_RELEASE_ASSERT(!writing);
    Close();
    MOZ_RELEASE_ASSERT(LiveCodecBytes() == 0);
    if (asyncLifetime) {
      asyncLifetime->Finalized(asyncId);
      asyncLifetime->Release();
    }
  }

  void Close() {
    if (closed) return;
    MOZ_RELEASE_ASSERT(!writing);
    pendingClose = false;
    closed = true;
    if (initStarted) context->Close();
    inputBacking.reset(); outputBacking.reset(); writeBacking.reset();
  }

  void Report(JSObject* owner) {
    // Codec callbacks account actual live allocated blocks, including their
    // aligned size prefix. Handle/context sizeof and vector/string capacity
    // accounting and heap snapshot visitation remain separate review work.
    const size_t bytes = LiveCodecBytes();
    if (bytes > reportedBytes) {
      JS::AddAssociatedMemory(owner, bytes - reportedBytes, JS::MemoryUse::Embedding2);
    } else if (bytes < reportedBytes) {
      JS::RemoveAssociatedMemory(owner, reportedBytes - bytes, JS::MemoryUse::Embedding2);
    }
    reportedBytes = bytes;
  }
};

struct KandeloCodecStateDelete {
  void operator()(KandeloCodecState* state) const { js_delete(state); }
};

static bool KandeloCodecFail(JSContext* cx, const char* code, const char* message) {
  JS_ReportErrorASCII(cx, "%s", message);
  RootedValue exception(cx);
  if (!JS_GetPendingException(cx, &exception) || !exception.isObject()) return false;
  JS_ClearPendingException(cx);
  RootedObject object(cx, &exception.toObject());
  RootedString codeString(cx, JS_NewStringCopyZ(cx, code));
  if (!codeString || !JS_DefineProperty(cx, object, "code", codeString, JSPROP_ENUMERATE)) return false;
  JS_SetPendingException(cx, exception);
  return false;
}

template <bool (*Callback)(JSContext*, unsigned, Value*)>
static bool KandeloCodecGuard(JSContext* cx, unsigned argc, Value* vp) {
  // No exception from native vector/string allocations may unwind through
  // SpiderMonkey's JS call frames. Native worker exceptions are handled by
  // the work owner separately, then reported on this same JS thread.
  try {
    return Callback(cx, argc, vp);
  } catch (const std::bad_alloc&) {
    JS_ReportOutOfMemory(cx);
    return false;
  } catch (...) {
    return KandeloCodecFail(cx, "ERR_OPERATION_FAILED", "Native compression operation threw a C++ exception");
  }
}

static void KandeloCodecFinalize(JS::GCContext* gcx, JSObject* object) {
  const Value slot = JS::GetReservedSlot(object, CodecNativeState);
  if (slot.isUndefined()) return;  // Allocation failed before ownership commit.
  auto* state = static_cast<KandeloCodecState*>(slot.toPrivate());
  if (state->reportedBytes) {
    JS::RemoveAssociatedMemory(object, state->reportedBytes, JS::MemoryUse::Embedding2);
  }
  js_delete(state);
}

static const JSClassOps KandeloCodecClassOps = {
    nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
    KandeloCodecFinalize, nullptr, nullptr, nullptr};
static const JSClass KandeloCodecClass = {
    "KandeloNodeCompressionHandle",
    JSCLASS_HAS_RESERVED_SLOTS(CodecSlots) | JSCLASS_FOREGROUND_FINALIZE,
    &KandeloCodecClassOps};

static KandeloCodecState* KandeloCodecThis(JSContext* cx, const CallArgs& args,
                                          bool requireInit = true) {
  if (!args.thisv().isObject() || JS::GetClass(&args.thisv().toObject()) != &KandeloCodecClass) {
    KandeloCodecFail(cx, "ERR_INVALID_THIS", "Invalid compression handle receiver");
    return nullptr;
  }
  const Value slot = JS::GetReservedSlot(&args.thisv().toObject(), CodecNativeState);
  if (slot.isUndefined()) {
    KandeloCodecFail(cx, "ERR_INVALID_THIS", "Uninitialized native compression owner");
    return nullptr;
  }
  auto* state = static_cast<KandeloCodecState*>(slot.toPrivate());
  if (requireInit && (!state->initialized || state->closed || state->writing || state->pendingClose)) {
    KandeloCodecFail(cx, "ERR_INVALID_STATE", "Compression handle is not idle and initialized");
    return nullptr;
  }
  return state;
}

// Private ABI arguments have already passed the public pinned validators.
// Still validate primitives and bounds here: unchecked private calls must never
// turn an out-of-range index into a native memory access or fatal assertion.
static bool KandeloCodecInteger(JSContext* cx, HandleValue value,
                                int64_t low, int64_t high, int64_t* result) {
  if (!value.isNumber()) return KandeloCodecFail(cx, "ERR_INVALID_ARG_TYPE", "Expected a numeric compression argument");
  const double number = value.toNumber();
  if (!std::isfinite(number) || std::floor(number) != number || number < low || number > high) {
    return KandeloCodecFail(cx, "ERR_OUT_OF_RANGE", "Compression argument is outside its integer range");
  }
  *result = static_cast<int64_t>(number);
  return true;
}

template <bool isSigned>
static bool KandeloCodecConvertedInteger(JSContext* cx, HandleValue value,
                                         int64_t low, int64_t high,
                                         int64_t* result) {
  // Public range validation precedes the native binding. Node then performs
  // Int32/Uint32 conversion, including truncation of in-range fractions and
  // undefined params values. Do not narrow that contract to integers here.
  // Restrict private callers to primitives so conversion cannot reenter JS
  // and close/reset this handle while a native state pointer is borrowed.
  if (!value.isNumber() && !value.isBoolean() && !value.isUndefined()) {
    return KandeloCodecFail(cx, "ERR_INVALID_ARG_TYPE", "Expected a primitive numeric compression argument");
  }
  int64_t converted;
  if constexpr (isSigned) {
    int32_t number;
    if (!JS::ToInt32(cx, value, &number)) return false;
    converted = number;
  } else {
    uint32_t number;
    if (!JS::ToUint32(cx, value, &number)) return false;
    converted = number;
  }
  if (converted < low || converted > high) {
    return KandeloCodecFail(cx, "ERR_OUT_OF_RANGE", "Converted compression argument is out of range");
  }
  *result = converted;
  return true;
}

static bool KandeloCodecView(JSContext* cx, HandleValue value, MutableHandleObject result) {
  if (!value.isObject() || !JS_IsArrayBufferViewObject(&value.toObject())) {
    return KandeloCodecFail(cx, "ERR_INVALID_ARG_TYPE", "Compression buffer must be an ArrayBufferView");
  }
  result.set(&value.toObject());
  // Initial detached/OOB views have the intrinsic empty span used by the
  // pinned Buffer::Data/Length contract. Per-operation bounds decide validity;
  // there is no blanket detached/shared/resizable-kind rejection here.
  return true;
}

static JS::KandeloBacking::SpanRef KandeloCodecStateBacking(
    JSContext* cx, HandleObject view, bool zlib) {
  auto span = JS::KandeloBacking::Acquire(cx, view);
  if (!span) return {};
  if (span->Length() < 2 * sizeof(uint32_t)) {
    KandeloCodecFail(cx, "ERR_INVALID_STATE", "Compression write state has no initial span");
    return {};
  }
  // Pinned Zlib::Init uses ArrayBuffer::Data(), not Buffer::Data(view).
  // Brotli/Zstd intentionally retain the actual view's byte offset instead.
  if (zlib && span->Offset())
    return span->Store()->Capture(0, 2 * sizeof(uint32_t), JS::KandeloBacking::ResolveAccount(cx));
  return span;
}
static void KandeloCodecWriteResult(KandeloCodecState* state,
                                    uint32_t remainingIn, uint32_t remainingOut) {
  MOZ_RELEASE_ASSERT(state->writeBacking && state->writeBacking->Length() >= 2 * sizeof(uint32_t));
  auto* result = reinterpret_cast<uint32_t*>(state->writeBacking->Data());
  if (state->writeBacking->Shared()) {
    __atomic_store_n(result, remainingOut, __ATOMIC_RELAXED);
    __atomic_store_n(result + 1, remainingIn, __ATOMIC_RELAXED);
  } else { result[0] = remainingOut; result[1] = remainingIn; }
}

static bool KandeloCodecDictionary(JSContext* cx, HandleValue value, std::vector<uint8_t>* result) {
  if (value.isUndefined()) return true;
  RootedObject view(cx);
  if (!KandeloCodecView(cx, value, &view)) return false;
  const size_t length = JS_GetArrayBufferViewByteLength(view);
  JS::AutoCheckCannotGC nogc;
  bool shared;
  const auto* bytes = static_cast<const uint8_t*>(JS_GetArrayBufferViewData(view, &shared, nogc));
  if (length) {
    result->resize(length);
    if (shared) {
      for (size_t i = 0; i < length; ++i)
        (*result)[i] = __atomic_load_n(bytes + i, __ATOMIC_RELAXED);
    } else std::memcpy(result->data(), bytes, length);
  }
  return true;
}

static bool KandeloCodecCall(JSContext* cx, HandleObject owner,
                             HandleValue callback, const JS::HandleValueArray& arguments,
                             MutableHandleValue result) {
  // The actual handle owns one ID/trigger and the frame captured at creation.
  // This callback scope does not allocate a replacement AsyncResource/Promise.
  RootedValue frame(cx, JS::GetReservedSlot(owner, CodecContextFrame));
  KandeloNativeCallbackScope scope(cx, owner, frame);
  if (!scope.Enter()) return scope.Stopped();
  if (!JS_CallFunctionValue(cx, owner, callback, arguments, result)) return false;
  return scope.Close();
}

static bool KandeloCodecError(JSContext* cx, HandleObject owner, const codec::CompressionError& error) {
  if (!error.IsError()) return true;
  // Copy strings before invoking JS: onerror may close/reset the context that
  // owns the original string storage. The callback receives Node's three args.
  JS::RootedValueArray<3> arguments(cx);
  RootedString message(cx, JS_NewStringCopyZ(cx, error.message));
  RootedString code(cx, JS_NewStringCopyZ(cx, error.code));
  if (!message || !code) return false;
  arguments[0].setString(message);
  arguments[1].setInt32(error.err);
  arguments[2].setString(code);
  RootedValue callback(cx), ignored(cx);
  if (!JS_GetProperty(cx, owner, "onerror", &callback)) return false;
  if (!callback.isObject() || !JS::IsCallable(&callback.toObject())) {
    // Node AsyncWrap::MakeCallback(name) leaves a nonfunction alone. Public
    // Brotli/Zstd init runs before ZlibBase installs onerror; Init must still
    // throw ERR_ZLIB_INITIALIZATION_FAILED, rather than mask the codec error.
    return true;
  }
  return KandeloCodecCall(cx, owner, callback, arguments, &ignored);
}

static bool KandeloCodecInit(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = KandeloCodecThis(cx, args, false);
  if (!state) return false;
  if (state->closed || state->initStarted) return KandeloCodecFail(cx, "ERR_INVALID_STATE", "Compression handle cannot be initialized twice");
  RootedObject owner(cx, &args.thisv().toObject());
  const bool zlib = state->mode <= codec::UNZIP;
  const bool brotli = state->mode == codec::BROTLI_ENCODE || state->mode == codec::BROTLI_DECODE;
  const unsigned stateIndex = zlib ? 4 : brotli ? 1 : 2;
  const unsigned callbackIndex = stateIndex + 1;
  const unsigned dictionaryIndex = callbackIndex + 1;
  const unsigned minimum = zlib ? 7 : brotli ? 3 : 4;
  const unsigned maximum = zlib ? 8 : brotli ? 4 : 6;
  if (argc < minimum || argc > maximum) return KandeloCodecFail(cx, "ERR_INVALID_ARG_VALUE", "Invalid compression init arity");
  RootedValue writeStateValue(cx, args[stateIndex]);
  RootedObject writeState(cx);
  if (!KandeloCodecView(cx, writeStateValue, &writeState)) return false;
  if (!JS_IsUint32Array(writeState) || JS_GetTypedArrayLength(writeState) < 2) {
    return KandeloCodecFail(cx, "ERR_INVALID_ARG_TYPE", "Compression write state must be Uint32Array with two elements");
  }
  if (!args[callbackIndex].isObject() || !JS::IsCallable(&args[callbackIndex].toObject())) {
    return KandeloCodecFail(cx, "ERR_INVALID_ARG_TYPE", "Compression write callback must be callable");
  }
  std::vector<uint8_t> dictionary;
  if (!KandeloCodecDictionary(cx, args.get(dictionaryIndex), &dictionary)) return false;
  bool rejectGarbage = false;
  if (argc > dictionaryIndex + 1) {
    if (!args[dictionaryIndex + 1].isBoolean()) return KandeloCodecFail(cx, "ERR_INVALID_ARG_TYPE", "rejectGarbageAfterEnd must be boolean");
    rejectGarbage = args[dictionaryIndex + 1].toBoolean();
  }
  codec::CompressionError error;
  int64_t windowBits = 0, level = 0, memLevel = 0, strategy = 0;
  uint64_t pledge = ZSTD_CONTENTSIZE_UNKNOWN;
  std::vector<uint32_t> params;
  if (zlib) {
    const int low = state->mode == codec::INFLATE || state->mode == codec::GUNZIP || state->mode == codec::UNZIP ? 0 : 8;
    if (!KandeloCodecConvertedInteger<false>(cx, args[0], low, 15, &windowBits) ||
        !KandeloCodecConvertedInteger<true>(cx, args[1], -1, 9, &level) ||
        !KandeloCodecConvertedInteger<false>(cx, args[2], 1, 9, &memLevel) ||
        !KandeloCodecConvertedInteger<false>(cx, args[3], Z_DEFAULT_STRATEGY, Z_FIXED, &strategy)) return false;
    if (windowBits > 0 && windowBits < 8) return KandeloCodecFail(cx, "ERR_OUT_OF_RANGE", "Invalid zlib windowBits");
  } else {
    RootedObject paramView(cx);
    if (!KandeloCodecView(cx, args[0], &paramView)) return false;
    if (!JS_IsUint32Array(paramView)) return KandeloCodecFail(cx, "ERR_INVALID_ARG_TYPE", "Compression parameters must be Uint32Array");
    const size_t count = JS_GetTypedArrayLength(paramView);
    {
      JS::AutoCheckCannotGC nogc;
      bool shared;
      const auto* data = JS_GetUint32ArrayData(paramView, &shared, nogc);
      if (count) {
        params.resize(count);
        for (size_t i = 0; i < count; ++i)
          params[i] = shared ? __atomic_load_n(data + i, __ATOMIC_RELAXED) : data[i];
      }
    }
    if (!brotli && !args[1].isUndefined()) {
      int64_t value;
      if (!KandeloCodecInteger(cx, args[1], 0, 9007199254740991LL, &value)) return false;
      pledge = static_cast<uint64_t>(value);
    }
  }
  auto writeBacking = KandeloCodecStateBacking(cx, writeState, zlib);
  if (!writeBacking) return false;
  state->writeBacking = std::move(writeBacking);
  // Native InitStream stores a pointer, not a JS identity root. Public stream
  // state retains its own original write-state object as in the pinned JS.
  JS::SetReservedSlot(owner, CodecWriteCallback, args[callbackIndex]);
  state->initStarted = true;  // Failed partial init is still owned and closed.
  if (zlib) {
    static_cast<codec::ZlibContext*>(state->context.get())->Init(
        level, windowBits, memLevel, strategy, rejectGarbage, std::move(dictionary));
  } else if (brotli) {
    if (state->mode == codec::BROTLI_ENCODE) error = static_cast<codec::BrotliEncoderContext*>(state->context.get())->Init(std::move(dictionary));
    else error = static_cast<codec::BrotliDecoderContext*>(state->context.get())->Init(std::move(dictionary));
  } else {
    const char* bytes = dictionary.empty() ? "" : reinterpret_cast<const char*>(dictionary.data());
    const std::string_view dict(bytes, dictionary.size());
    if (state->mode == codec::ZSTD_COMPRESS) error = static_cast<codec::ZstdCompressContext*>(state->context.get())->Init(pledge, dict, rejectGarbage);
    else error = static_cast<codec::ZstdDecompressContext*>(state->context.get())->Init(pledge, dict, rejectGarbage);
  }
  for (size_t i = 0; !error.IsError() && i < params.size(); ++i) {
    if (params[i] == UINT32_MAX) continue;
    if (i > INT32_MAX) { error = {"Setting parameter failed", "ERR_ZLIB_INITIALIZATION_FAILED", -1}; break; }
    if (state->mode == codec::BROTLI_ENCODE) error = static_cast<codec::BrotliEncoderContext*>(state->context.get())->SetParams(i, params[i]);
    else if (state->mode == codec::BROTLI_DECODE) error = static_cast<codec::BrotliDecoderContext*>(state->context.get())->SetParams(i, params[i]);
    else if (state->mode == codec::ZSTD_COMPRESS) error = static_cast<codec::ZstdCompressContext*>(state->context.get())->SetParameter(i, static_cast<int32_t>(params[i]));
    else error = static_cast<codec::ZstdDecompressContext*>(state->context.get())->SetParameter(i, static_cast<int32_t>(params[i]));
  }
  state->Report(owner);
  if (error.IsError()) {
    if (!KandeloCodecError(cx, owner, error)) return false;
    return KandeloCodecFail(cx, "ERR_ZLIB_INITIALIZATION_FAILED", "Initialization failed");
  }
  state->initialized = true;
  args.rval().setUndefined();
  return true;
}

static void KandeloCodecClearClosedSlots(JSObject* owner) {
  JS::SetReservedSlot(owner, CodecWriteState, UndefinedValue());
  JS::SetReservedSlot(owner, CodecWriteCallback, UndefinedValue());
  JS::SetReservedSlot(owner, CodecLastInput, UndefinedValue());
  JS::SetReservedSlot(owner, CodecLastOutput, UndefinedValue());
}

// Owned by the native queue until completion/cancellation on the JS thread.
// Only Run() touches the codec on a worker, with real stable backing storage.
struct KandeloCodecWork final : js::shell::KandeloNativeWork {
  JS::PersistentRootedObject owner;
  KandeloCodecState* state;
  JS::KandeloBacking::SpanRef inputBacking, outputBacking;
  size_t inputOffset, outputOffset;
  uint32_t inputLength, outputLength, remainingIn = 0, remainingOut = 0;
  codec::CompressionError error;
  char emptyInput = 0, emptyOutput = 0;

  KandeloCodecWork(JSContext* cx, JSObject* object, KandeloCodecState* state,
                   size_t inOffset, uint32_t inLength,
                   size_t outOffset, uint32_t outLength)
      : owner(cx, object), state(state),
        inputOffset(inOffset), outputOffset(outOffset),
        inputLength(inLength), outputLength(outLength) {}

  ~KandeloCodecWork() override {
    ReleaseSpans();
  }

  void ReleaseSpans() { inputBacking.reset(); outputBacking.reset(); }

  void Run() override {
    state->context->DoThreadPoolWork();
    error = state->context->GetErrorInfo();
    state->context->GetAfterWriteOffsets(&remainingIn, &remainingOut);
    MOZ_RELEASE_ASSERT(remainingIn <= inputLength && remainingOut <= outputLength);
    state->context->SetBuffers(nullptr, 0, nullptr, 0);
  }

  void FinishClose(JSObject* object) {
    // A callback can immediately enqueue another write. Its context and owners
    // belong to the new job and must survive this old completion's cleanup.
    if (state->pendingClose && !state->writing) {
      state->Close();
      state->Report(object);
      KandeloCodecClearClosedSlots(object);
    }
  }

  bool Complete(JSContext* cx) override {
    RootedObject object(cx, owner);
    JSAutoRealm realm(cx, object);
    state->writing = false;
    state->context->SetBuffers(nullptr, 0, nullptr, 0);
    if (failure != Failure::None) {
      ReleaseSpans();
      state->pendingClose = true;
      FinishClose(object);
      if (failure == Failure::OutOfMemory) { JS_ReportOutOfMemory(cx); return false; }
      return KandeloCodecFail(cx, "ERR_OPERATION_FAILED", "Native compression work threw a C++ exception");
    }
    state->inputOffset = inputOffset + inputLength - remainingIn;
    state->inputRemaining = remainingIn;
    state->outputOffset = outputOffset + outputLength - remainingOut;
    state->outputRemaining = remainingOut;
    state->Report(object);
    auto close = mozilla::MakeScopeExit([&] { FinishClose(object); });
    if (error.IsError()) {
      ReleaseSpans();
      return KandeloCodecError(cx, object, error);
    }
    KandeloCodecWriteResult(state, remainingIn, remainingOut);
    // The native operation has completed. Release its leases before user JS
    // can transfer/resize storage or enqueue another write. Other operations
    // sharing an allocation retain their own actual span owners.
    ReleaseSpans();
    RootedValue callback(cx, JS::GetReservedSlot(object, CodecWriteCallback)), ignored(cx);
    return KandeloCodecCall(cx, object, callback, JS::HandleValueArray::empty(), &ignored);
  }

  void Cancel(JSContext* cx) override {
    state->writing = false;
    state->context->SetBuffers(nullptr, 0, nullptr, 0);
    state->pendingClose = true;
    FinishClose(owner);
  }
};

template <bool async>
static bool KandeloCodecWriteCommon(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = KandeloCodecThis(cx, args);
  if (!state) return false;
  if (argc != 7) return KandeloCodecFail(cx, "ERR_INVALID_ARG_VALUE", "Invalid compression write arity");
  int64_t flush, inOffset = 0, inLength = 0, outOffset, outLength;
  // Convert before buffer-range checks, as Node does. Public chunkSize and
  // flush options can be fractional; bounds still apply to the actual span.
  if (!KandeloCodecConvertedInteger<false>(cx, args[0], 0, UINT32_MAX, &flush)) return false;
  const int flushMax = state->mode <= codec::UNZIP ? Z_BLOCK :
      state->mode <= codec::BROTLI_ENCODE ? BROTLI_OPERATION_EMIT_METADATA : ZSTD_e_end;
  if (flush > flushMax) return KandeloCodecFail(cx, "ERR_OUT_OF_RANGE", "Invalid compression flush operation");
  RootedObject owner(cx, &args.thisv().toObject()), input(cx), output(cx);
  JS::KandeloBacking::SpanRef inputBacking;
  if (!args[1].isNull()) {
    if (!KandeloCodecView(cx, args[1], &input) ||
        !KandeloCodecConvertedInteger<false>(cx, args[2], 0, UINT32_MAX, &inOffset) ||
        !KandeloCodecConvertedInteger<false>(cx, args[3], 0, UINT32_MAX, &inLength)) return false;
    const size_t length = JS_GetArrayBufferViewByteLength(input);
    if (size_t(inOffset) > length || size_t(inLength) > length - size_t(inOffset)) {
      return KandeloCodecFail(cx, "ERR_OUT_OF_RANGE", "Input buffer is out of bounds");
    }
    inputBacking = JS::KandeloBacking::Acquire(cx, input);
    if (!inputBacking) return false;
  }
  if (!KandeloCodecView(cx, args[4], &output) ||
      !KandeloCodecConvertedInteger<false>(cx, args[5], 0, UINT32_MAX, &outOffset) ||
      !KandeloCodecConvertedInteger<false>(cx, args[6], 0, UINT32_MAX, &outLength)) return false;
  const size_t length = JS_GetArrayBufferViewByteLength(output);
  if (size_t(outOffset) > length || size_t(outLength) > length - size_t(outOffset)) {
    return KandeloCodecFail(cx, "ERR_OUT_OF_RANGE", "Output buffer is out of bounds");
  }
  auto outputBacking = JS::KandeloBacking::Acquire(cx, output);
  if (!outputBacking) return false;
  if (!state->writeBacking) return KandeloCodecFail(cx, "ERR_INVALID_STATE", "Missing compression write state owner");
  if constexpr (async) {
    auto* queue = js::shell::KandeloGetNativeWorkQueue(cx);
    if (!queue) return false;
    auto* work = js_new<KandeloCodecWork>(cx, owner.get(), state,
                                         inOffset, inLength, outOffset, outLength);
    if (!work) { JS_ReportOutOfMemory(cx); return false; }
    // Every failure path releases the roots and every lease already acquired.
    auto destroy = mozilla::MakeScopeExit([&] { if (work) js_delete(work); });
    work->inputBacking = inputBacking;
    work->outputBacking = outputBacking;
    const auto* in = work->inputBacking ? work->inputBacking->Data() : nullptr;
    auto* out = work->outputBacking->Data();
    state->context->SetBuffers(in ? reinterpret_cast<const char*>(in) + inOffset : &work->emptyInput, inLength,
                               out ? reinterpret_cast<char*>(out) + outOffset : &work->emptyOutput, outLength);
    state->context->SetFlush(flush);
    state->writing = true;
    if (!queue->Submit(work)) {
      state->writing = false;
      state->context->SetBuffers(nullptr, 0, nullptr, 0);
      return KandeloCodecFail(cx, "ERR_INVALID_STATE", "Native work queue is shutting down");
    }
    // Submit succeeded. Commit the remaining-span state only now; a failed
    // handoff leaves the prior params() state paired with its original owners.
    state->inputBacking = std::move(inputBacking);
    state->outputBacking = std::move(outputBacking);
    state->inputOffset = inOffset; state->inputRemaining = inLength;
    state->outputOffset = outOffset; state->outputRemaining = outLength;
    work = nullptr;  // Queue owns the actual native operation and its JS root.
    args.rval().setUndefined();
    return true;
  }
  // Preserve native allocation/initial span to params(), without adding JS
  // input/output roots that the native handle itself does not own.
  state->inputBacking = std::move(inputBacking);
  state->outputBacking = std::move(outputBacking);
  state->inputOffset = inOffset; state->inputRemaining = inLength;
  state->outputOffset = outOffset; state->outputRemaining = outLength;
  state->writing = true;
  auto cleanup = mozilla::MakeScopeExit([&] {
    state->context->SetBuffers(nullptr, 0, nullptr, 0);
    state->writing = false;
    state->Report(owner);
  });
  codec::CompressionError error;
  {
    JS::AutoCheckCannotGC nogc;
    const auto* in = state->inputBacking ? reinterpret_cast<const char*>(state->inputBacking->Data()) : nullptr;
    auto* out = reinterpret_cast<char*>(state->outputBacking->Data());
    // Node's zero-length Buffer supplies an address. The codecs can perform
    // pointer subtraction even for empty spans, so supply real byte addresses.
    char emptyOutput = 0;
    state->context->SetBuffers(in ? in + inOffset : "", inLength,
                               out ? out + outOffset : &emptyOutput, outLength);
    state->context->SetFlush(flush);
    state->context->DoThreadPoolWork();  // writeSync only; never an async shim.
    error = state->context->GetErrorInfo();
    uint32_t remainingIn, remainingOut;
    state->context->GetAfterWriteOffsets(&remainingIn, &remainingOut);
    MOZ_RELEASE_ASSERT(remainingIn <= inLength && remainingOut <= outLength);
    state->inputRemaining = remainingIn;
    state->outputRemaining = remainingOut;
    state->inputOffset = inOffset + inLength - remainingIn;
    state->outputOffset = outOffset + outLength - remainingOut;
    if (!error.IsError()) {
      KandeloCodecWriteResult(state, remainingIn, remainingOut);
    }
    // No unowned pointer into GC storage survives the operation.
    state->context->SetBuffers(nullptr, 0, nullptr, 0);
  }
  state->writing = false;
  state->Report(owner);
  cleanup.release();  // Never clear a reentrant callback's new write buffers.
  args.rval().setUndefined();
  return KandeloCodecError(cx, owner, error);
}

static bool KandeloCodecClose(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = KandeloCodecThis(cx, args, false);
  if (!state) return false;
  args.rval().setUndefined();
  if (state->writing) {
    state->pendingClose = true;
    return true;
  }
  state->Close();
  state->Report(&args.thisv().toObject());
  KandeloCodecClearClosedSlots(&args.thisv().toObject());
  return true;
}

static bool KandeloCodecReset(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = KandeloCodecThis(cx, args, false);
  if (!state) return false;
  if (state->writing) {
    JS_ReportErrorASCII(cx, "Cannot reset zlib stream while a write is in progress");
    return false;
  }
  if (!state->initialized || state->closed || state->pendingClose) {
    return KandeloCodecFail(cx, "ERR_INVALID_STATE", "Compression handle is not idle and initialized");
  }
  RootedObject owner(cx, &args.thisv().toObject());
  const codec::CompressionError error = state->context->ResetStream();
  if (!error.IsError()) {
    state->inputOffset = state->inputRemaining = 0;
    state->outputOffset = state->outputRemaining = 0;
    state->inputBacking.reset(); state->outputBacking.reset();
  }
  state->Report(owner);
  args.rval().setUndefined();
  return KandeloCodecError(cx, owner, error);
}

static bool KandeloCodecParams(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = KandeloCodecThis(cx, args);
  if (!state) return false;
  args.rval().setUndefined();
  // Node's Brotli/Zstd Params methods are currently genuine no-ops.
  if (state->mode > codec::UNZIP) return true;
  if (argc != 2) return KandeloCodecFail(cx, "ERR_INVALID_ARG_VALUE", "Invalid compression params arity");
  int64_t level, strategy;
  if (!KandeloCodecConvertedInteger<true>(cx, args[0], -1, 9, &level) ||
      !KandeloCodecConvertedInteger<true>(cx, args[1], Z_DEFAULT_STRATEGY, Z_FIXED, &strategy)) return false;
  RootedObject owner(cx, &args.thisv().toObject());
  // Params continues the original native pointers, not whatever storage the
  // old JS views currently name after a transfer, resize, replacement or GC.
  const auto& input = state->inputBacking;
  const auto& output = state->outputBacking;
  MOZ_RELEASE_ASSERT(!input || (state->inputOffset <= input->Length() &&
      state->inputRemaining <= input->Length() - state->inputOffset));
  MOZ_RELEASE_ASSERT(!output || (state->outputOffset <= output->Length() &&
      state->outputRemaining <= output->Length() - state->outputOffset));
  codec::CompressionError error;
  auto clearBuffers = mozilla::MakeScopeExit([&] {
    state->context->SetBuffers(nullptr, 0, nullptr, 0);
  });
  {
    JS::AutoCheckCannotGC nogc;
    char emptyOutput = 0;
    const auto* in = input ? reinterpret_cast<const char*>(input->Data()) : nullptr;
    auto* out = output ? reinterpret_cast<char*>(output->Data()) : nullptr;
    state->context->SetBuffers(in ? in + state->inputOffset : "", state->inputRemaining,
                               out ? out + state->outputOffset : &emptyOutput, state->outputRemaining);
    error = static_cast<codec::ZlibContext*>(state->context.get())->SetParams(level, strategy);
    uint32_t remainingIn, remainingOut;
    state->context->GetAfterWriteOffsets(&remainingIn, &remainingOut);
    state->inputOffset += state->inputRemaining - remainingIn;
    state->outputOffset += state->outputRemaining - remainingOut;
    state->inputRemaining = remainingIn;
    state->outputRemaining = remainingOut;
    state->context->SetBuffers(nullptr, 0, nullptr, 0);
  }
  clearBuffers.release();
  state->Report(owner);
  return KandeloCodecError(cx, owner, error);
}

static bool KandeloCodecGetAsyncId(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = KandeloCodecThis(cx, args, false);
  if (!state) return false;
  args.rval().setNumber(state->asyncId);
  return true;
}

static bool KandeloCodecGetProviderType(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!KandeloCodecThis(cx, args, false)) return false;
  args.rval().setInt32(static_cast<int>(codec::AsyncProvider::Provider_ZLIB));
  return true;
}

static bool KandeloCodecGetContextFrame(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!KandeloCodecThis(cx, args, false)) return false;
  args.rval().set(JS::GetReservedSlot(&args.thisv().toObject(), CodecContextFrame));
  return JS_WrapValue(cx, args.rval());
}

static bool KandeloCodecResourceInfo(JSContext* cx, HandleObject resource, MutableHandleValue result) {
  const Value slot = JS::GetReservedSlot(resource, CodecNativeState);
  if (slot.isUndefined()) return KandeloCodecFail(cx, "ERR_INVALID_STATE", "Native resource ownership is not initialized");
  auto* state = static_cast<KandeloCodecState*>(slot.toPrivate());
  if (state->asyncId < 0) return KandeloCodecFail(cx, "ERR_INVALID_STATE", "Native async identity is not initialized");
  JS::RootedValueArray<4> entries(cx);
  entries[0].setNumber(state->asyncId);
  entries[1].setNumber(state->triggerId);
  entries[2].set(JS::GetReservedSlot(resource, CodecContextFrame));
  RootedString name(cx, JS_NewStringCopyZ(cx, "ZLIB"));
  if (!name) return false;
  entries[3].setString(name);
  for (size_t i = 0; i < 4; ++i) if (!JS_WrapValue(cx, entries[i])) return false;
  RootedObject array(cx, JS::NewArrayObject(cx, entries));
  if (!array) return false;
  result.setObject(*array);
  return true;
}

static bool KandeloCreateCompressionHandle(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  int64_t mode;
  if (!KandeloCodecInteger(cx, args.get(0), codec::DEFLATE, codec::ZSTD_DECOMPRESS, &mode)) return false;
  RootedObject owner(cx);
  if (args.get(1).isObjectOrNull()) {
    RootedObject prototype(cx, args[1].toObjectOrNull());
    owner = JS_NewObjectWithGivenProto(cx, &KandeloCodecClass, prototype);
  } else if (args.get(1).isUndefined()) {
    owner = JS_NewObject(cx, &KandeloCodecClass);
  } else return KandeloCodecFail(cx, "ERR_INVALID_ARG_TYPE", "Compression prototype must be object or null");
  if (!owner) return false;
  std::unique_ptr<KandeloCodecState, KandeloCodecStateDelete> state(js_new<KandeloCodecState>(mode));
  if (!state) { JS_ReportOutOfMemory(cx); return false; }
  switch (mode) {
    case codec::BROTLI_ENCODE: {
      KandeloCodecPtr<codec::BrotliEncoderContext> context(js_new<codec::BrotliEncoderContext>());
      if (!context) { JS_ReportOutOfMemory(cx); return false; }
      context->SetMode(codec::BROTLI_ENCODE);
      state->context = std::move(context);
      break;
    }
    case codec::BROTLI_DECODE: {
      KandeloCodecPtr<codec::BrotliDecoderContext> context(js_new<codec::BrotliDecoderContext>());
      if (!context) { JS_ReportOutOfMemory(cx); return false; }
      context->SetMode(codec::BROTLI_DECODE);
      state->context = std::move(context);
      break;
    }
    case codec::ZSTD_COMPRESS: state->context.reset(js_new<codec::ZstdCompressContext>()); break;
    case codec::ZSTD_DECOMPRESS: state->context.reset(js_new<codec::ZstdDecompressContext>()); break;
    default: {
      KandeloCodecPtr<codec::ZlibContext> context(js_new<codec::ZlibContext>());
      if (!context) { JS_ReportOutOfMemory(cx); return false; }
      context->SetMode(static_cast<codec::node_zlib_mode>(mode));
      state->context = std::move(context);
    }
  }
  if (!state->context) { JS_ReportOutOfMemory(cx); return false; }
  state->context->SetAllocator(state.get());
  JS::SetReservedSlot(owner, CodecNativeState, PrivateValue(state.release()));
  static const JSFunctionSpec methods[] = {
      JS_FN("init", KandeloCodecGuard<KandeloCodecInit>, 7, 0),
      JS_FN("writeSync", KandeloCodecGuard<KandeloCodecWriteCommon<false>>, 7, 0),
      JS_FN("write", KandeloCodecGuard<KandeloCodecWriteCommon<true>>, 7, 0),
      JS_FN("close", KandeloCodecGuard<KandeloCodecClose>, 0, 0),
      JS_FN("reset", KandeloCodecGuard<KandeloCodecReset>, 0, 0),
      JS_FN("params", KandeloCodecGuard<KandeloCodecParams>, 2, 0),
      JS_FN("getAsyncId", KandeloCodecGuard<KandeloCodecGetAsyncId>, 0, 0),
      JS_FN("getProviderType", KandeloCodecGuard<KandeloCodecGetProviderType>, 0, 0),
      JS_FN("getAsyncContextFrame", KandeloCodecGuard<KandeloCodecGetContextFrame>, 0, 0),
      JS_FS_END};
  if (!JS_DefineFunctions(cx, owner, methods)) return false;
  RootedValue frame(cx); double trigger;
  if (!cx->kandeloAsyncProperty("frame", &frame) || !cx->getKandeloDefaultTriggerAsyncId(&trigger)) return false;
  auto* lifetime = js::shell::KandeloGetNativeAsyncState(cx);
  if (!lifetime) return false;
  auto* nativeState = static_cast<KandeloCodecState*>(JS::GetReservedSlot(owner, CodecNativeState).toPrivate());
  lifetime->Retain();
  nativeState->asyncLifetime = lifetime;
  nativeState->asyncId = cx->allocateKandeloAsyncId();
  nativeState->triggerId = trigger;
  JS::SetReservedSlot(owner, CodecContextFrame, frame);
  if (!cx->notifyKandeloAsyncLifecycle("native:init", owner, frame)) return false;
  args.rval().setObject(*owner);
  return true;
}

static bool KandeloNativeCreateCompressionHandle(JSContext* cx, unsigned argc, Value* vp) {
  return KandeloCodecGuard<KandeloCreateCompressionHandle>(cx, argc, vp);
}

static bool KandeloCodecCRC32(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  int64_t seed = 0;
  if (!args.get(1).isUndefined() && !KandeloCodecInteger(cx, args[1], 0, UINT32_MAX, &seed)) return false;
  uint32_t result;
  if (args.get(0).isString()) {
    RootedString string(cx, args[0].toString());
    JSLinearString* linear = JS_EnsureLinearString(cx, string);
    if (!linear) return false;
    const size_t length = JS::GetDeflatedUTF8StringLength(linear);
    UniqueChars bytes(length ? static_cast<char*>(js_malloc(length)) : nullptr);
    if (length && !bytes) { JS_ReportOutOfMemory(cx); return false; }
    // Explicit byte length preserves embedded NULs and the engine's UTF-8
    // replacement encoding. strlen would silently checksum a prefix.
    JS::AutoCheckCannotGC nogc;
    if (length) {
      const size_t written = JS::DeflateStringToUTF8Buffer(linear, mozilla::Span<char>(bytes.get(), length));
      MOZ_RELEASE_ASSERT(written == length);
    }
    const Bytef empty = 0;
    result = crc32_z(seed, length ? reinterpret_cast<const Bytef*>(bytes.get()) : &empty, length);
  } else {
    RootedObject view(cx);
    if (!KandeloCodecView(cx, args.get(0), &view)) return false;
    const size_t length = JS_GetArrayBufferViewByteLength(view);
    JS::AutoCheckCannotGC nogc;
    bool shared;
    const auto* bytes = static_cast<const Bytef*>(JS_GetArrayBufferViewData(view, &shared, nogc));
    const Bytef empty = 0;
    result = crc32_z(seed, bytes ? bytes : &empty, length);
  }
  args.rval().setNumber(result);
  return true;
}

static bool KandeloNativeCRC32(JSContext* cx, unsigned argc, Value* vp) {
  return KandeloCodecGuard<KandeloCodecCRC32>(cx, argc, vp);
}
}  // namespace
