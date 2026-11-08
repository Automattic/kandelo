#include "kandelo-node-terminal-operations.h"
#include "kandelo-node-terminal-read-owner.h"
#include "kandelo-node-terminal-write-owner.h"
#include "kandelo-node-socket-stream-state.h"
#include "js/WeakMap.h"
#include "js/Realm.h"
#include "js/Wrapper.h"
#include "js/experimental/TypedData.h"
// Defined by the existing real fd/watch owner in shell/js.cpp. These helpers
// retain the opaque lease and actual read request; no numeric fd escapes to JS.
static bool KandeloTerminalRead(JSContext*, JS::HandleObject,
    js::shell::KandeloTerminalLease*, int32_t, JS::MutableHandleValue);
static bool KandeloTerminalReadControl(JSContext*, js::shell::KandeloTerminalLease*,
    JS::HandleObject, JS::HandleValue, JS::MutableHandleValue);
static bool KandeloTerminalCancelRead(JSContext*, js::shell::KandeloTerminalLease*, bool, bool*);
static bool KandeloTerminalStartRead(JSContext*, JS::HandleObject,
    js::shell::KandeloTerminalLease*, int32_t, JS::HandleValue, JS::MutableHandleValue);
static bool KandeloTerminalRefRead(js::shell::KandeloTerminalLease*, bool);
static bool KandeloTerminalStopRead(js::shell::KandeloTerminalLease*);
static bool KandeloTerminalHasPendingRead(js::shell::KandeloTerminalLease*);
static bool KandeloTerminalStreamStart(JSContext*, JS::HandleObject,
    js::shell::KandeloTerminalLease*, JS::MutableHandleValue);
enum KandeloTerminalWriteSlot { TerminalWriteState, TerminalWriteFrame,
  TerminalWriteParent, TerminalWriteSlotCount };
namespace js::shell {
using KandeloTerminalWriteTicket = kandelo::terminal::WriteTicket<JS::KandeloBacking::SpanRef>;
struct KandeloTerminalWriteRequest {
  KandeloTerminalLease* parent;
  KandeloNativeAsyncState* lifetime;
  JSContext* cx;
  KandeloTerminalWriteRequest* previous = nullptr;
  KandeloTerminalWriteRequest* next = nullptr;
  std::unique_ptr<KandeloTerminalWriteTicket> ticket;
  std::unique_ptr<JS::PersistentRootedObject> pending;
  kandelo::memory::Allocation allocation{sizeof(KandeloTerminalWriteRequest)};
  kandelo::memory::Claims claims;
  double id = -1, trigger = -1;
  bool queued = false, retired = false, callbackActive = false;
  KandeloTerminalWriteRequest(JSContext*, KandeloTerminalLease*,
                              std::unique_ptr<KandeloTerminalWriteTicket>);
  void RefreshMemory() noexcept {
    allocation.Resize(sizeof(KandeloTerminalWriteRequest) + claims.MaterialBytes() +
        (pending ? sizeof(JS::PersistentRootedObject) : 0));
  }
  void Retire() noexcept;
  ~KandeloTerminalWriteRequest();
};
static void KandeloDiscardTerminalWrites(KandeloTerminalLease*);
static thread_local uint64_t gKandeloTerminalGeneration = 0;
struct KandeloTerminalLease {
  KandeloNativeAsyncState* state;
  JSContext* cx;
  double id = -1, trigger = -1;
  bool referenced = true, retired = false;
  bool closing = false, closed = false, closeActive = false;
  size_t requests = 0;
  kandelo::terminal::ReadOwner reads;
  kandelo::terminal::WriteOwner<JS::KandeloBacking::SpanRef> writes;
  KandeloTerminalWriteRequest* writeHead = nullptr;
  KandeloTerminalWriteRequest* writeTail = nullptr;
  std::unique_ptr<JS::PersistentRootedObject> closeRoot;
  // Real continuous read demand survives a failed after/job checkpoint.
  // Its next reservation is created only on ordinary exception-free dispatch.
  std::unique_ptr<JS::PersistentRootedObject> readRoot;
  void Retire() noexcept {
    if (!retired && id >= 0) { retired = true;state->Finalized(id); }
  }
  KandeloTerminalLease* previous = nullptr;
  KandeloTerminalLease* next;
  kandelo::terminal::BorrowedInputMode mode;
  kandelo::terminal::OutputHandle output;
  kandelo::terminal::InputHandle input;
  bool outputOwner = false, inputOwner = false, inputClosing = false;
  explicit KandeloTerminalLease(JSContext* cx, KandeloNativeAsyncState* state)
      : state(state), cx(cx), reads(++gKandeloTerminalGeneration), writes(reads.Generation()), next(state->terminalLeases) {
    state->Retain();if (next) next->previous = this;state->terminalLeases = this;
  }
  ~KandeloTerminalLease() {
    bool cancelled;inputClosing = true;reads.Close();readRoot.reset();
    (void)KandeloTerminalCancelRead(nullptr, this, false, &cancelled);
    writes.Close();KandeloDiscardTerminalWrites(this);
    input.Close();mode.Close();output.Close();Retire();closeRoot.reset();
    if (previous) previous->next = next;else state->terminalLeases = next;
    if (next) next->previous = previous;
    state->Release();
  }
};
KandeloTerminalWriteRequest::KandeloTerminalWriteRequest(JSContext* cx,
    KandeloTerminalLease* parent, std::unique_ptr<KandeloTerminalWriteTicket> material)
    : parent(parent), lifetime(parent->state), cx(cx), ticket(std::move(material)) {
  lifetime->Retain();
}
void KandeloTerminalWriteRequest::Retire() noexcept {
  if (retired) return;
  retired = true;
  if (queued) {
    parent->writes.Retire(ticket.get());
    if (previous) previous->next = next;else parent->writeHead = next;
    if (next) next->previous = previous;else parent->writeTail = previous;
    --parent->requests;queued = false;
  }
  previous = next = nullptr;
  if (pending) {
    JSObject* request = *pending;
    for (uint32_t slot : {TerminalWriteFrame,TerminalWriteParent})
      JS::SetReservedSlot(request, slot, UndefinedValue());
  }
  pending.reset();ticket.reset();claims.Clear();parent = nullptr;RefreshMemory();
  if (id >= 0) lifetime->Finalized(id);
}
KandeloTerminalWriteRequest::~KandeloTerminalWriteRequest() {
  Retire();lifetime->Release();
}
static void KandeloDiscardTerminalWrites(KandeloTerminalLease* lease) {
  while (lease->writeHead) lease->writeHead->Retire();
}
static void KandeloShutdownTerminalLeases(KandeloNativeAsyncState* state) {
  for (auto* lease = state->terminalLeases; lease; lease = lease->next) {
    lease->inputClosing = true;lease->reads.Close();lease->readRoot.reset();bool cancelled;
    (void)KandeloTerminalCancelRead(nullptr, lease, false, &cancelled);
    lease->writes.Close();KandeloDiscardTerminalWrites(lease);
    lease->input.Close();lease->mode.Close();lease->output.Close();lease->Retire();lease->closed = true;lease->closing = false;lease->closeRoot.reset();
  }
}
}  // namespace js::shell
namespace {
namespace TerminalStreamStateFields = kandelo::socket::state;
enum TerminalSlots : uint32_t { TerminalState, TerminalFrame, TerminalDispatch,
  TerminalStreamState, TerminalOnRead, TerminalCloseCallback, TerminalSlotCount };
static void KandeloTerminalFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);if (slot.isUndefined()) return;
  JS::RemoveAssociatedMemory(object, sizeof(js::shell::KandeloTerminalLease), JS::MemoryUse::Embedding3);
  js_delete(static_cast<js::shell::KandeloTerminalLease*>(slot.toPrivate()));
}
static const JSClassOps KandeloTerminalOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloTerminalFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloTerminalClass = {"BorrowedInputModeLease",
  JSCLASS_HAS_RESERVED_SLOTS(2) | JSCLASS_FOREGROUND_FINALIZE, &KandeloTerminalOps};
// A native I/O resource owns the actual captured terminal, frame and lifecycle.
// Mode-only borrowed leases deliberately retain their separate non-I/O brand.
static const JSClass KandeloTerminalIOClass = {"TTY",
  JSCLASS_HAS_RESERVED_SLOTS(TerminalSlotCount) | JSCLASS_FOREGROUND_FINALIZE, &KandeloTerminalOps};
static bool KandeloTerminalResourceInfo(JSContext* cx, HandleObject owner,
                                        MutableHandleValue result) {
  const auto slot = JS::GetReservedSlot(owner, 0);
  auto* lease = slot.isUndefined() ? nullptr : static_cast<js::shell::KandeloTerminalLease*>(slot.toPrivate());
  if (!lease || lease->cx != cx) { JS_ReportErrorASCII(cx, "Terminal resource is not live in this context");return false; }
  JS::RootedValueArray<5> fields(cx);
  fields[0].setNumber(lease->id);fields[1].setNumber(lease->trigger);
  fields[2].set(JS::GetReservedSlot(owner, 1));
  RootedString provider(cx, JS_NewStringCopyZ(cx, "TTYWRAP"));if (!provider) return false;
  fields[3].setString(provider);fields[4].setObject(*owner);
  for (size_t i = 0; i < 5; ++i) if (!JS_WrapValue(cx, fields[i])) return false;
  RootedObject packet(cx, JS::NewArrayObject(cx, fields));if (!packet) return false;
  result.setObject(*packet);return true;
}
static bool KandeloTerminalInitializeIO(JSContext* cx, HandleObject owner,
                                       js::shell::KandeloTerminalLease* lease) {
  RootedValue frame(cx);
  if (!cx->kandeloAsyncProperty("frame", &frame) ||
      !cx->getKandeloDefaultTriggerAsyncId(&lease->trigger)) return false;
  if (!JS_WrapValue(cx, &frame)) return false;
  lease->id = cx->allocateKandeloAsyncId();
  JS::SetReservedSlot(owner, 1, frame);
  return cx->notifyKandeloAsyncLifecycle("native:init", owner, frame);
}
static bool KandeloTerminalDeliverRead(JSContext* cx, HandleObject owner,
    HandleValue callback, int error, const uint8_t* bytes, size_t length) {
  JSAutoRealm realm(cx, owner);
  RootedValue frame(cx, JS::GetReservedSlot(owner, 1)), ignored(cx);
  JS::RootedValueArray<2> arguments(cx);
  arguments[0].setInt32(-error);
  if (!error) {
    RootedObject value(cx, KandeloNewUint8ArrayCopy(cx, bytes, length));if (!value) return false;
    arguments[1].setObject(*value);
  }
  KandeloNativeCallbackScope scope(cx, owner, frame);
  if (!scope.Enter()) return false;
  if (scope.Stopped()) return scope.Close();
  const bool called = scope.Call(callback, arguments, &ignored);
  return called ? scope.Close() : scope.Fail();
}
// Admission uses the calling realm's authority before entering an actual
// owner/view realm. A wrapper denial is the engine's real access error, never
// a generic type mismatch or an unchecked unwrap.
static bool KandeloTerminalCheckedObject(JSContext* cx, HandleValue input,
                                         MutableHandleObject actual) {
  actual.set(nullptr);
  if (!input.isObject()) return true;
  actual.set(js::CheckedUnwrapDynamic(&input.toObject(), cx));
  if (actual.get()) return true;
  if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);
  return false;
}
static bool KandeloTerminalPrototype(JSContext*, MutableHandleObject);
static bool KandeloTerminalConfigureWrite(JSContext*, unsigned, Value*);
static bool KandeloTerminalWriteBuffer(JSContext*, unsigned, Value*);
static bool KandeloTerminalWriteVector(JSContext*, unsigned, Value*);
static bool KandeloTerminalWriteQueueSize(JSContext*, unsigned, Value*);
static int KandeloDispatchTerminalWrite(JSContext*, js::shell::KandeloTerminalLease*);
static js::shell::KandeloTerminalLease* KandeloTerminalThis(
    JSContext* cx, const CallArgs& args, MutableHandleObject owner) {
  RootedObject actual(cx);
  if (!KandeloTerminalCheckedObject(cx, args.thisv(), &actual)) return nullptr;
  if (!actual || JS::GetClass(actual) != &KandeloTerminalIOClass ||
      JS::GetReservedSlot(actual, TerminalState).isUndefined()) {
    JS_ReportErrorASCII(cx, "TTY operation requires its actual native I/O owner");return nullptr;
  }
  auto* lease = static_cast<js::shell::KandeloTerminalLease*>(
      JS::GetReservedSlot(actual, TerminalState).toPrivate());
  if (lease->cx != cx || lease->state->detached) {
    JS_ReportErrorASCII(cx, "TTY owner belongs to a retired or different context");return nullptr;
  }
  owner.set(actual);return lease;
}
static bool KandeloTerminalConfigure(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  if (!lease->inputOwner || lease->inputClosing || lease->input.Descriptor() < 0) {
    JS_ReportErrorASCII(cx, "TTY input is closed or unavailable");return false;
  }
  if (KandeloTerminalHasPendingRead(lease)) {
    JS_ReportErrorASCII(cx, "TTY read configuration requires an idle native owner");return false;
  }
  if (!args.get(0).isObject() || !JS::IsCallable(&args[0].toObject())) {
    JS_ReportErrorASCII(cx, "TTY read dispatcher must be callable");return false;
  }
  RootedObject view(cx);
  if (!KandeloTerminalCheckedObject(cx, args.get(1), &view)) return false;
  if (!view || !JS_IsInt32Array(view)) {
    JS_ReportErrorASCII(cx, "TTY read requires its actual pinned stream state");return false;
  }
  bool invalid;
  {
    JSAutoRealm realm(cx, view);JS::AutoCheckCannotGC nogc;bool shared;
    const auto* data = JS_GetInt32ArrayData(view, &shared, nogc);
    invalid = shared || !data || JS_GetTypedArrayLength(view) < TerminalStreamStateFields::kNumStreamBaseStateFields;
  }
  if (invalid) { JS_ReportErrorASCII(cx, "TTY stream state is detached or shared");return false; }
  JSAutoRealm realm(cx, owner);
  RootedValue callback(cx, args[0]), state(cx, args[1]);
  if (!JS_WrapValue(cx, &callback) || !JS_WrapValue(cx, &state)) return false;
  if (lease->inputClosing) { JS_ReportErrorASCII(cx, "TTY closed during read admission");return false; }
  JS::SetReservedSlot(owner, TerminalDispatch, callback);
  JS::SetReservedSlot(owner, TerminalStreamState, state);
  args.rval().setUndefined();return true;
}
static bool KandeloTerminalOnReadGet(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  if (!KandeloTerminalThis(cx, args, &owner)) return false;
  RootedValue value(cx, JS::GetReservedSlot(owner, TerminalOnRead));
  if (!JS_WrapValue(cx, &value)) return false;args.rval().set(value);return true;
}
static bool KandeloTerminalOnReadSet(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  if (!KandeloTerminalThis(cx, args, &owner)) return false;
  // Same actual internal function invariant as pinned StreamBase's setter.
  MOZ_RELEASE_ASSERT(args.get(0).isObject() && JS::IsCallable(&args[0].toObject()));
  JSAutoRealm realm(cx, owner);RootedValue callback(cx, args[0]);
  if (!JS_WrapValue(cx, &callback)) return false;
  JS::SetReservedSlot(owner, TerminalOnRead, callback);args.rval().setUndefined();return true;
}
static bool KandeloTerminalReadStart(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  if (!lease->inputOwner) { args.rval().setInt32(-EBADF);return true; }
  return KandeloTerminalStreamStart(cx, owner, lease, args.rval());
}
static bool KandeloTerminalReadStop(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  if (!lease->inputOwner) { args.rval().setInt32(-EBADF);return true; }
  (void)KandeloTerminalStopRead(lease);args.rval().setInt32(0);return true;
}
static bool KandeloTerminalRef(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  if (!lease->closed) lease->referenced = true;
  (void)KandeloTerminalRefRead(lease, lease->referenced);args.rval().setUndefined();return true;
}
static bool KandeloTerminalUnref(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  if (!lease->closed) lease->referenced = false;(void)KandeloTerminalRefRead(lease, false);
  args.rval().setUndefined();return true;
}
static bool KandeloTerminalHasRef(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  args.rval().setBoolean(!lease->closed && lease->referenced);return true;
}
static bool KandeloTerminalAsyncId(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  args.rval().setNumber(lease->id);return true;
}
static bool KandeloTerminalFd(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  args.rval().setInt32(lease->closed ? -EINVAL :
      lease->inputOwner ? lease->input.Descriptor() : lease->output.Descriptor());return true;
}
static bool KandeloTerminalBeginClose(JSContext* cx, HandleObject owner,
    js::shell::KandeloTerminalLease* lease, HandleValue callback = UndefinedHandleValue) {
  if (lease->closing || lease->closed) return true;
  JSAutoRealm realm(cx, owner);RootedValue wrapped(cx, callback);
  if (!JS_WrapValue(cx, &wrapped)) return false;
  if (lease->closing || lease->closed) return true;
  {
    try { lease->closeRoot = std::make_unique<PersistentRootedObject>(cx, owner); }
    catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx);return false; }
    lease->closing = true;lease->inputClosing = true;lease->reads.Close();lease->readRoot.reset();
  }
  if (lease->closed) return true;
  if (wrapped.isObject() && JS::IsCallable(&wrapped.toObject()) &&
      JS::GetReservedSlot(owner, TerminalCloseCallback).isUndefined())
    JS::SetReservedSlot(owner, TerminalCloseCallback, wrapped);
  bool cancelled;
  // Release only the captured extra descriptors before any rejected-Promise
  // hook can reenter. The borrowed public fd remains untouched at teardown.
  lease->writes.Close();
  lease->input.Close();lease->mode.Close();lease->output.Close();
  return KandeloTerminalCancelRead(cx, lease, true, &cancelled);
}
static bool KandeloTerminalClose(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  args.rval().setUndefined();return KandeloTerminalBeginClose(cx, owner, lease, args.get(0));
}
static void KandeloTerminalWriteFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, TerminalWriteState);
  if (!slot.isUndefined()) delete static_cast<js::shell::KandeloTerminalWriteRequest*>(slot.toPrivate());
}
static const JSClassOps KandeloTerminalWriteOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloTerminalWriteFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloTerminalWriteClass = {"WriteWrap",
  JSCLASS_HAS_RESERVED_SLOTS(TerminalWriteSlotCount) | JSCLASS_FOREGROUND_FINALIZE,
  &KandeloTerminalWriteOps};
static bool KandeloTerminalWriteResourceInfo(JSContext* cx, HandleObject request,
                                            MutableHandleValue result) {
  const auto slot = JS::GetReservedSlot(request, TerminalWriteState);
  auto* state = slot.isUndefined() ? nullptr : static_cast<js::shell::KandeloTerminalWriteRequest*>(slot.toPrivate());
  if (!state || state->cx != cx || state->lifetime->detached) {
    JS_ReportErrorASCII(cx, "TTY write resource belongs to another or retired context");return false;
  }
  JS::RootedValueArray<5> fields(cx);
  fields[0].setNumber(state->id);fields[1].setNumber(state->trigger);
  fields[2].set(JS::GetReservedSlot(request, TerminalWriteFrame));
  RootedString provider(cx, JS_NewStringCopyZ(cx, "WRITEWRAP"));if (!provider) return false;
  fields[3].setString(provider);fields[4].setObject(*request);
  for (size_t i = 0; i < 5; i++) if (!JS_WrapValue(cx, fields[i])) return false;
  RootedObject packet(cx, JS::NewArrayObject(cx, fields));if (!packet) return false;
  result.setObject(*packet);return true;
}
// All fallible security/realm work precedes native publication. The actual
// unshared Int32Array stays rooted; no pointer crosses an allocation or JS call.
static bool KandeloTerminalWriteStateView(JSContext* cx, HandleValue value,
                                         MutableHandleObject view) {
  if (!KandeloTerminalCheckedObject(cx, value, view)) return false;
  if (!view || !JS_IsInt32Array(view)) {
    JS_ReportErrorASCII(cx, "TTY write requires its actual stream state");return false;
  }
  bool invalid;
  {
    JSAutoRealm realm(cx, view);JS::AutoCheckCannotGC nogc;bool shared;
    const auto* data = JS_GetInt32ArrayData(view, &shared, nogc);
    invalid = shared || !data || JS_GetTypedArrayLength(view) < TerminalStreamStateFields::kNumStreamBaseStateFields;
  }
  if (invalid) { JS_ReportErrorASCII(cx, "TTY stream state is detached or shared");return false; }
  return true;
}
static void KandeloTerminalWriteResult(JSContext* cx, HandleObject view,
    uint64_t bytes, int error, bool async, HandleObject request, MutableHandleValue result) {
  {
    JSAutoRealm realm(cx, view);JS::AutoCheckCannotGC nogc;bool shared;
    int32_t* data = JS_GetInt32ArrayData(view, &shared, nogc);
    // Revalidated after init hooks, then only native queue/syscalls occur.
    MOZ_RELEASE_ASSERT(!shared && data && JS_GetTypedArrayLength(view) >= TerminalStreamStateFields::kNumStreamBaseStateFields);
    data[TerminalStreamStateFields::kBytesWritten] = int32_t(uint32_t(bytes));
    data[TerminalStreamStateFields::kLastWriteWasAsync] = async ? 1 : 0;
    data[TerminalStreamStateFields::kLastWriteErr] = -error;
  }
  if (request) result.setObject(*request);else result.setInt32(-error);
}
static bool KandeloTerminalConfigureWrite(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx), view(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  if (!lease->outputOwner || lease->closing || lease->closed) {
    JS_ReportErrorASCII(cx, "TTY write configuration requires its live output owner");return false;
  }
  if (!KandeloTerminalWriteStateView(cx, args.get(0), &view)) return false;
  RootedValue prior(cx, JS::GetReservedSlot(owner, TerminalStreamState));
  if (!prior.isUndefined()) {
    RootedObject original(cx);
    if (!KandeloTerminalCheckedObject(cx, prior, &original)) return false;
    if (original != view) {
      JS_ReportErrorASCII(cx, "TTY output stream state is already bound");return false;
    }
  }
  JSAutoRealm realm(cx, owner);RootedValue state(cx, ObjectValue(*view));
  if (!JS_WrapValue(cx, &state)) return false;
  if (lease->closing || lease->closed) {
    JS_ReportErrorASCII(cx, "TTY closed during write configuration");return false;
  }
  JS::SetReservedSlot(owner, TerminalStreamState, state);args.rval().setUndefined();return true;
}
static JS::KandeloBacking::SpanRef KandeloTerminalWriteSpan(JSContext* cx, HandleValue value) {
  RootedObject view(cx);
  if (!KandeloTerminalCheckedObject(cx, value, &view)) return {};
  if (!view || !JS_IsUint8Array(view)) {
    JS_ReportErrorASCII(cx, "TTY write requires an actual Uint8Array");return {};
  }
  JSAutoRealm realm(cx, view);
  return JS::KandeloBacking::Acquire(cx, view);
}
static bool KandeloTerminalSubmitWrite(JSContext* cx, HandleObject parent,
    js::shell::KandeloTerminalLease* lease, HandleObject resultGlobal,
    std::vector<JS::KandeloBacking::SpanRef> spans, MutableHandleValue result) {
  using Request = js::shell::KandeloTerminalWriteRequest;
  using Ticket = js::shell::KandeloTerminalWriteTicket;
  if (!lease->outputOwner) {
    JS_ReportErrorASCII(cx, "TTY write requires its actual output owner; input-kind writes remain unimplemented");return false;
  }
  if (lease->closing || lease->closed || lease->output.Descriptor() < 0) {
    result.setInt32(-EBADF);return true;
  }
  RootedValue streamState(cx, JS::GetReservedSlot(parent, TerminalStreamState));
  RootedObject view(cx), none(cx);
  if (!KandeloTerminalWriteStateView(cx, streamState, &view)) return false;
  auto material = std::make_unique<Ticket>(lease->writes.Generation(), std::move(spans));
  const uint64_t bytes = material->material.totalBytes;
  if (lease->closing || lease->closed) {
    KandeloTerminalWriteResult(cx, view, bytes, EBADF, false, none, result);return true;
  }
  // A full initial try-write never creates WRITEWRAP. Original spans were
  // captured first; any partial prefix remains progress over those same bytes.
  if (!lease->writes.HasRemaining() && lease->output.ProgressWrite(material->material)) {
    KandeloTerminalWriteResult(cx, view, bytes, material->material.error, false, none, result);return true;
  }
  RootedObject request(cx, JS_NewObject(cx, &KandeloTerminalWriteClass));if (!request) return false;
  auto preparing = std::make_unique<Request>(cx, lease, std::move(material));
  const auto account = KandeloNativeMemoryOwner(cx);
  preparing->claims.Add(preparing->allocation.Handle(), account);
  preparing->claims.Add(preparing->ticket->material.allocation.Handle(), account);
  preparing->pending = std::make_unique<PersistentRootedObject>(cx, request);
  preparing->RefreshMemory();
  auto* state = preparing.release();
  JS::SetReservedSlot(request, TerminalWriteState, PrivateValue(state));
  JS::SetReservedSlot(request, TerminalWriteParent, ObjectValue(*parent));
  bool published = false;
  auto abandon = mozilla::MakeScopeExit([&] { if (!published) state->Retire(); });
  RootedValue null(cx, NullValue()), zero(cx, Int32Value(0)), no(cx, BooleanValue(false));
  // These are actual request fields, initialized before WRITEWRAP init just
  // like the pinned WriteWrap ObjectTemplate, not fabricated completion data.
  for (const char* name : {"oncomplete","callback","handle","buffer","writeStatus"})
    if (!JS_DefineProperty(cx, request, name, null, JSPROP_ENUMERATE)) return false;
  if (!JS_DefineProperty(cx, request, "bytes", zero, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, request, "async", no, JSPROP_ENUMERATE)) return false;
  kandelo::async::DefaultTriggerScope trigger(cx->kandeloDefaultTrigger(), lease->id);
  if (!trigger.Ready()) { JS_ReportErrorASCII(cx, "TTY parent has no valid async identity");return false; }
  RootedValue frame(cx);
  if (!cx->kandeloAsyncProperty("frame", &frame) ||
      !cx->getKandeloDefaultTriggerAsyncId(&state->trigger) || !JS_WrapValue(cx, &frame)) return false;
  state->id = cx->allocateKandeloAsyncId();
  JS::SetReservedSlot(request, TerminalWriteFrame, frame);
  if (!cx->notifyKandeloAsyncLifecycle("native:init", request, frame)) return false;
  // Prepare the actual return wrapper in the native caller's original realm
  // before queue commit. A borrowed method may target another owner realm;
  // raw foreign objects must not escape in a native rval after realm restore.
  RootedObject publicRequest(cx, request);
  {
    JSAutoRealm resultRealm(cx, resultGlobal);
    if (!JS_WrapObject(cx, &publicRequest)) return false;
  }
  // Init/wrapping can close the parent, detach the state or submit nested
  // writes. Complete every fallible authority step before the infallible
  // queue commit and native remainder syscalls.
  // Keep/revalidate the actual previously bound environment state even when
  // a reentrant queued close has cleared the parent's reusable root slots.
  if (!KandeloTerminalWriteStateView(cx, streamState, &view)) return false;
  // Error-completed requests retain their remaining byte count until their
  // callback admission. Like uv_write2, do not attempt a new write while that
  // accounting still marks the stream nonempty/error-state.
  const bool emptyBefore = !lease->writes.HasRemaining();
  int error = lease->state->detached || GetShellContext(cx)->quitting ? ECANCELED :
      lease->writes.Publish(state->ticket.get());
  if (error) {
    KandeloTerminalWriteResult(cx, view, bytes, error, false, publicRequest, result);return true;
  }
  state->previous = lease->writeTail;
  if (lease->writeTail) lease->writeTail->next = state;else lease->writeHead = state;
  lease->writeTail = state;state->queued = true;++lease->requests;
  published = true;
  if (emptyBefore) lease->writes.Progress(lease->output, state->ticket.get());
  KandeloTerminalWriteResult(cx, view, bytes, 0, true, publicRequest, result);return true;
}
static bool KandeloTerminalWriteBuffer(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  // StreamBase's method gate rejects completed close before any input
  // conversion. A still-closing handle remains alive at this entry seam;
  // its actual transport/admission owns subsequent errors independently.
  // After the real close callback/checkpoint retires this resource, the
  // target no longer has a native StreamBase and returns undefined at entry.
  if (lease->retired) { args.rval().setUndefined();return true; }
  if (lease->closed) { args.rval().setInt32(-EINVAL);return true; }
  auto span = KandeloTerminalWriteSpan(cx, args.get(1));if (!span) return false;
  RootedObject resultGlobal(cx, JS::CurrentGlobalOrNull(cx));
  if (!resultGlobal) { JS_ReportErrorASCII(cx, "TTY write requires its calling realm");return false; }
  JSAutoRealm realm(cx, owner);
  try {
    std::vector<JS::KandeloBacking::SpanRef> spans;spans.push_back(std::move(span));
    return KandeloTerminalSubmitWrite(cx, owner, lease, resultGlobal, std::move(spans), args.rval());
  } catch (const std::length_error&) { JS_ReportErrorASCII(cx, "TTY write byte count overflow");return false; }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx);return false; }
}
static bool KandeloTerminalWriteVector(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx), authority(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  // StreamBase's method gate rejects completed close before any input
  // conversion. A still-closing handle remains alive at this entry seam;
  // its actual transport/admission owns subsequent errors independently.
  // After the real close callback/checkpoint retires this resource, the
  // target no longer has a native StreamBase and returns undefined at entry.
  if (lease->retired) { args.rval().setUndefined();return true; }
  if (lease->closed) { args.rval().setInt32(-EINVAL);return true; }
  if (!KandeloTerminalCheckedObject(cx, args.get(0), &authority)) return false;
  // Property access stays through the caller's original object/wrapper. An
  // allowed array does not delegate its realm's authority to returned views.
  RootedObject chunks(cx, args.get(0).isObject() ? &args[0].toObject() : nullptr);
  bool array;
  if (!chunks || !JS::IsArrayObject(cx, chunks, &array) || !array) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "TTY vector write requires an actual Array");return false;
  }
  uint32_t count;if (!JS::GetArrayLength(cx, chunks, &count)) return false;
  try {
    std::vector<JS::KandeloBacking::SpanRef> spans;spans.reserve(count);
    for (uint32_t i = 0; i < count; i++) {
      RootedValue value(cx);if (!JS_GetElement(cx, chunks, i, &value)) return false;
      auto span = KandeloTerminalWriteSpan(cx, value);if (!span) return false;spans.push_back(std::move(span));
    }
    RootedObject resultGlobal(cx, JS::CurrentGlobalOrNull(cx));
    if (!resultGlobal) { JS_ReportErrorASCII(cx, "TTY write requires its calling realm");return false; }
    JSAutoRealm realm(cx, owner);
    return KandeloTerminalSubmitWrite(cx, owner, lease, resultGlobal, std::move(spans), args.rval());
  } catch (const std::length_error&) { JS_ReportErrorASCII(cx, "TTY write byte count overflow");return false; }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx);return false; }
}
static bool KandeloTerminalWriteQueueSize(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject owner(cx);
  auto* lease = KandeloTerminalThis(cx, args, &owner);if (!lease) return false;
  args.rval().setNumber(double(lease->writes.QueueSize()));return true;
}
static int KandeloDispatchTerminalWrite(JSContext* cx, js::shell::KandeloTerminalLease* lease) {
  auto* state = lease->writeHead;
  if (!state || !state->pending || state->callbackActive) return 0;
  if (!lease->writes.Progress(lease->output, state->ticket.get())) return 0;
  RootedObject request(cx, *state->pending);JSAutoRealm realm(cx, request);
  RootedObject parent(cx, &JS::GetReservedSlot(request, TerminalWriteParent).toObject());
  state->callbackActive = true;state->ticket->phase = js::shell::KandeloTerminalWriteTicket::Phase::Delivering;
  auto retire = mozilla::MakeScopeExit([&] { state->Retire(); });
  RootedValue callback(cx), status(cx, Int32Value(-state->ticket->material.error));
  if (!JS_GetProperty(cx, request, "oncomplete", &callback)) return -1;
  if (!callback.isObject() || !JS::IsCallable(&callback.toObject())) {
    return JS_SetProperty(cx, request, "writeStatus", status) ? 1 : -1;
  }
  RootedValue frame(cx, JS::GetReservedSlot(request, TerminalWriteFrame)), ignored(cx);
  KandeloNativeCallbackScope scope(cx, request, frame);
  if (!scope.Enter()) return -1;
  if (scope.Stopped()) return scope.Close() ? 1 : -1;
  JS::RootedValueArray<3> arguments(cx);
  arguments[0].set(status);arguments[1].setObject(*parent);arguments[2].setUndefined();
  const bool called = scope.Call(callback, arguments, &ignored);
  return (called ? scope.Close() : scope.Fail()) ? 1 : -1;
}
static bool KandeloTerminalPrototype(JSContext* cx, MutableHandleObject result) {
  auto* state = js::shell::KandeloGetNativeAsyncState(cx);if (!state) return false;
  RootedObject global(cx, JS::CurrentGlobalOrNull(cx));
  if (!global || state->detached || !state->process.initialized() || !state->process) {
    JS_ReportErrorASCII(cx, "TTY prototype requires its live process environment");return false;
  }
  RootedObject process(cx, js::CheckedUnwrapStatic(state->process)), map(cx);
  if (!process) { if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);return false; }
  RootedValue key(cx, ObjectValue(*global)), value(cx);
  {
    JSAutoRealm realm(cx, process);
    if (!state->terminalPrototypes.initialized()) {
      map = JS::NewWeakMapObject(cx);if (!map) return false;
      state->terminalPrototypes.init(cx);state->terminalPrototypes = map;
    } else map = state->terminalPrototypes;
    if (!JS_WrapValue(cx, &key) || !JS::GetWeakMapEntry(cx, map, key, &value)) return false;
  }
  if (value.isUndefined()) {
    RootedObject streamPrototype(cx, JS_NewPlainObject(cx));if (!streamPrototype) return false;
    RootedFunction getter(cx, JS_NewFunction(cx, KandeloTerminalOnReadGet, 0, 0, nullptr));
    RootedFunction setter(cx, JS_NewFunction(cx, KandeloTerminalOnReadSet, 0, 0, nullptr));
    if (!getter || !setter) return false;
    RootedObject getObject(cx, JS_GetFunctionObject(getter)), setObject(cx, JS_GetFunctionObject(setter));
    if (!JS_DefineProperty(cx, streamPrototype, "onread", getObject, setObject, JSPROP_PERMANENT)) return false;
    RootedObject prototype(cx, JS_NewPlainObject(cx));
    if (!prototype || !JS_SetPrototype(cx, prototype, streamPrototype)) return false;
    static const JSFunctionSpec methods[] = {
      JS_FN("configureRead", KandeloTerminalConfigure, 2, 0),
      JS_FN("configureWrite", KandeloTerminalConfigureWrite, 1, 0),
      JS_FN("writeBuffer", KandeloTerminalWriteBuffer, 2, 0),
      JS_FN("writeVector", KandeloTerminalWriteVector, 1, 0),
      JS_FN("readStart", KandeloTerminalReadStart, 0, 0),JS_FN("readStop", KandeloTerminalReadStop, 0, 0),
      JS_FN("ref", KandeloTerminalRef, 0, 0),JS_FN("unref", KandeloTerminalUnref, 0, 0),
      JS_FN("hasRef", KandeloTerminalHasRef, 0, 0),JS_FN("getAsyncId", KandeloTerminalAsyncId, 0, 0),
      JS_FN("close", KandeloTerminalClose, 0, 0),JS_FS_END
    };
    static const JSPropertySpec properties[] = {JS_PSG("fd", KandeloTerminalFd, 0),
      JS_PSG("writeQueueSize", KandeloTerminalWriteQueueSize, 0),JS_PS_END};
    if (!JS_DefineFunctions(cx, prototype, methods) || !JS_DefineProperties(cx, prototype, properties)) return false;
    value.setObject(*prototype);
    {
      JSAutoRealm realm(cx, process);
      if (!JS_WrapValue(cx, &value) || !JS::SetWeakMapEntry(cx, map, key, value)) return false;
    }
  }
  if (!JS_WrapValue(cx, &value)) return false;result.set(&value.toObject());return true;
}
static bool KandeloTerminalHasReferences(JSContext* cx) {
  auto* state = js::shell::KandeloGetNativeAsyncState(cx);if (!state) return false;
  for (auto* lease = state->terminalLeases; lease; lease = lease->next) {
    if (lease->cx != cx) continue;
    if (lease->writeHead) return true; // Genuine active requests keep uv alive independently of handle unref.
    if (lease->closing && lease->closeRoot) return true;
    if (lease->readRoot && lease->reads.Reading() && lease->referenced) return true;
  }
  return false;
}
static int KandeloDispatchTerminalOwners(JSContext* cx) {
  auto* state = js::shell::KandeloGetNativeAsyncState(cx);if (!state) return -1;
  for (auto* lease = state->terminalLeases; lease; lease = lease->next) {
    if (lease->cx != cx) continue;
    const int written = KandeloDispatchTerminalWrite(cx, lease);
    if (written) return written; // No lease/list-next survives JS reentry.
    if (!lease->closing || lease->requests || !lease->closeRoot || lease->closeActive) continue;
    RootedObject owner(cx, *lease->closeRoot);JSAutoRealm realm(cx, owner);
    lease->closeActive = true;lease->closed = true;lease->closing = false;
    auto retire = mozilla::MakeScopeExit([&] {
      for (uint32_t slot : {TerminalFrame,TerminalDispatch,TerminalStreamState,TerminalOnRead,TerminalCloseCallback})
        JS::SetReservedSlot(owner, slot, UndefinedValue());
      lease->closing = false;lease->closed = true;lease->Retire();lease->closeRoot.reset();lease->closeActive = false;
    });
    RootedValue callback(cx, JS::GetReservedSlot(owner, TerminalCloseCallback));
    if (callback.isObject() && JS::IsCallable(&callback.toObject())) {
      RootedValue frame(cx, JS::GetReservedSlot(owner, TerminalFrame)), ignored(cx);
      KandeloNativeCallbackScope scope(cx, owner, frame);
      if (!scope.Enter()) return -1;
      if (scope.Stopped()) return scope.Close() ? 1 : -1;
      const bool called = scope.Call(callback, JS::HandleValueArray::empty(), &ignored);
      if (!(called ? scope.Close() : scope.Fail())) return -1;
    }
    return 1; // Never retain a list-next pointer across callback/after/checkpoint.
  }
  return 0;
}

static bool KandeloTerminalDeliverStream(JSContext* cx, HandleObject owner,
    js::shell::KandeloTerminalLease* lease,
    const std::shared_ptr<kandelo::terminal::ReadTicket>& ticket, bool* admitted) {
  *admitted = false;JSAutoRealm realm(cx, owner);
  RootedObject buffer(cx);
  if (ticket->status > 0) {
    buffer = JS::NewArrayBuffer(cx, size_t(ticket->status));if (!buffer) return false;
    JS::AutoCheckCannotGC nogc;bool shared;
    uint8_t* bytes = JS::GetArrayBufferData(buffer, &shared, nogc);
    memcpy(bytes, ticket->bytes.data(), size_t(ticket->status));
  }
  RootedValue callback(cx, JS::GetReservedSlot(owner, TerminalDispatch));
  RootedValue onread(cx, JS::GetReservedSlot(owner, TerminalOnRead));
  RootedValue streamState(cx, JS::GetReservedSlot(owner, TerminalStreamState));
  RootedObject view(cx);
  if (!KandeloTerminalCheckedObject(cx, streamState, &view)) return false;
  if (!view || !JS_IsInt32Array(view)) {
    JS_ReportErrorASCII(cx, "TTY read lost its actual stream state");return false;
  }
  bool invalid;
  {
    JSAutoRealm viewRealm(cx, view);JS::AutoCheckCannotGC nogc;bool shared;
    int32_t* data = JS_GetInt32ArrayData(view, &shared, nogc);
    invalid = shared || !data || JS_GetTypedArrayLength(view) < TerminalStreamStateFields::kNumStreamBaseStateFields;
    if (!invalid) {
      data[TerminalStreamStateFields::kReadBytesOrError] = ticket->status == 0 ? -4095 : int32_t(ticket->status);
      data[TerminalStreamStateFields::kArrayBufferOffset] = 0;
    }
  }
  if (invalid) { JS_ReportErrorASCII(cx, "TTY stream state is detached or shared");return false; }
  JS::RootedValueArray<3> arguments(cx);
  arguments[0].setNumber(ticket->status);
  if (buffer) arguments[1].setObject(*buffer);else arguments[1].setUndefined();
  arguments[2].set(onread);
  RootedValue frame(cx, JS::GetReservedSlot(owner, TerminalFrame)), ignored(cx);
  // The actual original native ticket stays alive until callback/after/jobs
  // retire. Only prepared JS arguments can relinquish its queued slot.
  if (!lease->reads.Admit(ticket)) {
    JS_ReportErrorASCII(cx, "TTY read admission lost its actual ticket");return false;
  }
  *admitted = true;
  KandeloNativeCallbackScope scope(cx, owner, frame);
  if (!scope.Enter()) return false;
  if (scope.Stopped()) return scope.Close();
  const bool called = scope.Call(callback, arguments, &ignored);
  return called ? scope.Close() : scope.Fail();
}
static bool KandeloTerminalDispatch(JSContext* cx, const CallArgs& args,
                                    const char* name, MutableHandleValue value, int* error) {
  if (strcmp(name, "tty-size") == 0 || strcmp(name, "tty-open") == 0 || strcmp(name, "tty-output-open") == 0 || strcmp(name, "tty-input-open") == 0) {
    int64_t fd;if (!KandeloFsInteger(cx, args.get(1), INT32_MIN, INT32_MAX, &fd)) return false;
    if (strcmp(name, "tty-size") == 0) {
      std::array<unsigned, 2> dimensions{};*error = kandelo::terminal::WindowSize(int(fd), &dimensions);
      if (*error) return true;
      JS::RootedValueArray<2> fields(cx);fields[0].setNumber(dimensions[0]);fields[1].setNumber(dimensions[1]);
      RootedObject array(cx, JS::NewArrayObject(cx, fields));if (!array) return false;
      value.setObject(*array);return true;
    }
    auto* state = js::shell::KandeloGetNativeAsyncState(cx);if (!state) return false;
    const bool io = strcmp(name, "tty-output-open") == 0 || strcmp(name, "tty-input-open") == 0;
    RootedObject prototype(cx);
    if (io && !KandeloTerminalPrototype(cx, &prototype)) return false;
    RootedObject object(cx, io ? JS_NewObjectWithGivenProto(cx, &KandeloTerminalIOClass, prototype) : JS_NewObject(cx, &KandeloTerminalClass));if (!object) return false;
    if (js::shell::gKandeloTerminalGeneration == UINT64_MAX) {
      JS_ReportErrorASCII(cx, "TTY owner generation exhausted");return false;
    }
    auto* lease = js_new<js::shell::KandeloTerminalLease>(cx, state);
    if (!lease) { JS_ReportOutOfMemory(cx);return false; }
    lease->outputOwner = strcmp(name, "tty-output-open") == 0;
    lease->inputOwner = strcmp(name, "tty-input-open") == 0;
    *error = lease->outputOwner ? lease->output.Open(int(fd)) :
        lease->inputOwner ? lease->input.Open(int(fd)) : lease->mode.Open(int(fd));
    if (*error) { js_delete(lease);return true; }
    JS::AddAssociatedMemory(object, sizeof(*lease), JS::MemoryUse::Embedding3);
    JS::SetReservedSlot(object, 0, PrivateValue(lease));
    if (io && !KandeloTerminalInitializeIO(cx, object, lease)) {
      JS::SetReservedSlot(object, 0, UndefinedValue());
      JS::SetReservedSlot(object, 1, UndefinedValue());
      JS::RemoveAssociatedMemory(object, sizeof(*lease), JS::MemoryUse::Embedding3);
      js_delete(lease);return false;
    }
    value.setObject(*object);return true;
  }
  RootedObject leaseObject(cx);
  if (!KandeloTerminalCheckedObject(cx, args.get(1), &leaseObject)) return false;
  if (!leaseObject || (JS::GetClass(leaseObject) != &KandeloTerminalClass && JS::GetClass(leaseObject) != &KandeloTerminalIOClass) ||
      JS::GetReservedSlot(leaseObject, 0).isUndefined()) {
    JS_ReportErrorASCII(cx, "Terminal operation requires an actual terminal lease");return false;
  }
  // Keep the actual native owner alive while later view authority checks may
  // reenter. Do not cache its fd: a reentrant close must produce real EBADF.
  auto* lease = static_cast<js::shell::KandeloTerminalLease*>(JS::GetReservedSlot(leaseObject, 0).toPrivate());
  if (lease->cx != cx || lease->state->detached) {
    JS_ReportErrorASCII(cx, "Terminal owner belongs to a retired or different context");return false;
  }
  if (strcmp(name, "tty-input-start") == 0) {
    if (!lease->inputOwner || !args.get(3).isObject() || !JS::IsCallable(&args[3].toObject())) {
      JS_ReportErrorASCII(cx, "Terminal callback read requires its input owner and callback");return false;
    }
    int64_t length;if (!KandeloFsInteger(cx, args.get(2), 1, INT32_MAX, &length)) return false;
    return KandeloTerminalStartRead(cx, leaseObject, lease, int32_t(length), args.get(3), value);
  }
  if (strcmp(name, "tty-input-stop") == 0) {
    if (!lease->inputOwner) { JS_ReportErrorASCII(cx, "Terminal stop requires an input owner");return false; }
    value.setBoolean(KandeloTerminalStopRead(lease));return true;
  }
  if (strcmp(name, "tty-input-ref") == 0) {
    if (!lease->inputOwner || !args.get(2).isBoolean()) {
      JS_ReportErrorASCII(cx, "Terminal reference control requires its input owner and boolean");return false;
    }
    lease->referenced = args[2].toBoolean();
    value.setBoolean(KandeloTerminalRefRead(lease, lease->referenced));return true;
  }
  if (strcmp(name, "tty-input-read") == 0) {
    if (!lease->inputOwner) { JS_ReportErrorASCII(cx, "Terminal input requires its actual input owner");return false; }
    int64_t length;if (!KandeloFsInteger(cx, args.get(2), 1, INT32_MAX, &length)) return false;
    return KandeloTerminalRead(cx, leaseObject, lease, int32_t(length), value);
  }
  if (strcmp(name, "tty-input-control") == 0) {
    if (!lease->inputOwner) { JS_ReportErrorASCII(cx, "Terminal input requires its actual input owner");return false; }
    RootedObject promise(cx);
    if (!KandeloTerminalCheckedObject(cx, args.get(2), &promise)) return false;
    if (!promise || !(args.get(3).isBoolean() || args.get(3).isNull())) {
      JS_ReportErrorASCII(cx, "Terminal input control requires its actual read Promise and boolean/null");return false;
    }
    return KandeloTerminalReadControl(cx, lease, promise, args.get(3), value);
  }
  if (strcmp(name, "tty-input-close") == 0) {
    if (!lease->inputOwner) { JS_ReportErrorASCII(cx, "Terminal input requires its actual input owner");return false; }
    return KandeloTerminalBeginClose(cx, leaseObject, lease);
  }
  if (strcmp(name, "tty-output-size") == 0) {
    if (!lease->outputOwner) { JS_ReportErrorASCII(cx, "Terminal output requires an output owner");return false; }
    std::array<unsigned, 2> dimensions{};
    *error = lease->output.GetWindowSize(&dimensions);
    if (*error) return true;
    JS::RootedValueArray<2> fields(cx);fields[0].setNumber(dimensions[0]);fields[1].setNumber(dimensions[1]);
    RootedObject array(cx, JS::NewArrayObject(cx, fields));if (!array) return false;
    value.setObject(*array);return true;
  }
  if (strcmp(name, "tty-output-write") == 0) {
    if (!lease->outputOwner) {
      JS_ReportErrorASCII(cx, "Terminal output requires its actual owner and ArrayBufferView");return false;
    }
    RootedObject view(cx);
    if (!KandeloTerminalCheckedObject(cx, args.get(2), &view)) return false;
    if (!view || !JS_IsArrayBufferViewObject(view)) {
      JS_ReportErrorASCII(cx, "Terminal output requires its actual owner and ArrayBufferView");return false;
    }
    kandelo::terminal::OutputHandle::WriteResult result{};
    bool live;
    {
      // The public view APIs are nonallocating borrows. Enter the admitted
      // actual view realm first; no wrapper/security work or JS error occurs
      // while its original bytes are live through the synchronous libc write.
      JSAutoRealm realm(cx, view);
      JS::AutoCheckCannotGC nogc;
      const size_t length = JS_GetArrayBufferViewByteLength(view);
      bool shared;
      const auto* bytes = static_cast<const uint8_t*>(JS_GetArrayBufferViewData(view, &shared, nogc));
      live = !length || bytes;
      if (live) result = lease->output.Write(bytes, length);
    }
    if (!live) { JS_ReportErrorASCII(cx, "Terminal view has no backing data");return false; }
    *error = result.error;value.setNumber(double(result.transferred));return true;
  }
  if (strcmp(name, "tty-output-close") == 0) {
    if (!lease->outputOwner) { JS_ReportErrorASCII(cx, "Terminal output requires an output owner");return false; }
    return KandeloTerminalBeginClose(cx, leaseObject, lease);
  }
  if (lease->outputOwner) { JS_ReportErrorASCII(cx, "Terminal mode requires an input mode owner");return false; }
  if (strcmp(name, "tty-close") == 0) {
    if (lease->inputOwner) {
      return KandeloTerminalBeginClose(cx, leaseObject, lease);
    }
    lease->mode.Close();return true;
  }
  if (strcmp(name, "tty-mode") == 0) {
    int64_t mode;if (!KandeloFsInteger(cx, args.get(2), 0, 3, &mode)) return false;
    *error = lease->inputOwner ? (lease->inputClosing ? -EBADF : lease->input.SetMode(int(mode))) : lease->mode.SetMode(int(mode));return true;
  }
  JS_ReportErrorASCII(cx, "Unknown terminal operation");return false;
}
}  // namespace
