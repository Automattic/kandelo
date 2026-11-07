// Foreground, context-owned TCP descriptors and undelivered read/write material.
// Included after native callback/retained-memory owners; source candidate.
#include "kandelo-node-socket-owner.h"
#include "kandelo-node-socket-stream-state.h"
#include "js/WeakMap.h"
#include <netinet/tcp.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <fcntl.h>
namespace {
namespace SocketStreamStateFields = kandelo::socket::state;
using KandeloSocketWriteMaterial = kandelo::socket::Write<JS::KandeloBacking::SpanRef>;
enum KandeloSocketSlot { SocketState, SocketFrame, SocketDispatch,
                         SocketExecutionResource, SocketParent, SocketCloseCallback, SocketStreamState, SocketOnRead, SocketSlots };
struct KandeloSocketState {
  JSContext* cx;
  KandeloSocketState* next = nullptr;
  std::unique_ptr<kandelo::socket::Owner> socket;
  std::unique_ptr<PersistentRootedObject> accepted;
  std::unique_ptr<KandeloSocketWriteMaterial> write;
  std::shared_ptr<kandelo::socket::Read> delivering;
  std::unique_ptr<PersistentRootedObject> pending, liveRoot;
  js::shell::KandeloNativeAsyncState* lifetime = nullptr;
  double id = -1, trigger = -1;
  uint64_t writeSequence = 0;
  bool connect = false, connectSubmitted = false, connectPreparing = false, writeResource = false;
  int connectError = 0;
  bool retired = false, detached = false, closing = false, socketPublished = false, callbackActive = false;
  kandelo::memory::Allocation allocation{sizeof(KandeloSocketState)};
  kandelo::memory::Claims claims;
  std::unique_ptr<kandelo::memory::Claim> readClaim, inflightReadClaim;
  explicit KandeloSocketState(JSContext* context) : cx(context) {}
  void RefreshMemory() noexcept {
    allocation.Resize(sizeof(KandeloSocketState) + claims.MaterialBytes() +
        (accepted ? sizeof(PersistentRootedObject) : 0) +
        (pending ? sizeof(PersistentRootedObject) : 0) +
        (liveRoot ? sizeof(PersistentRootedObject) : 0) +
        (readClaim ? sizeof(kandelo::memory::Claim) : 0) +
        (inflightReadClaim ? sizeof(kandelo::memory::Claim) : 0));
  }
  void Retire() {
    if (!retired && lifetime && id >= 0) { retired = true; lifetime->Finalized(id); }
  }
  void BeginClose() {
    if (!socket || closing || !liveRoot) return;
    socket->Close(); readClaim.reset(); pending.reset(); closing = true;
    RefreshMemory();
  }
  void CloseAccepted();
  void Close() {
    if (socket) socket->Close();
    CloseAccepted();
    write.reset();
    delivering.reset(); readClaim.reset(); inflightReadClaim.reset();
    pending.reset(); liveRoot.reset(); closing = false;
    if (!socket) Retire(); RefreshMemory();
  }
  ~KandeloSocketState() { Close(); Retire(); if (lifetime) lifetime->Release(); }
};
// This list owns no JS roots. Open handles and active requests own their roots.
// It is confined to the JS thread; context shutdown removes its own entries.
static thread_local KandeloSocketState* gKandeloSocketOwners = nullptr;
static thread_local uint64_t gKandeloSocketGeneration = 0;
static void KandeloSocketOwnerUnlink(KandeloSocketState* state) {
  auto** link = &gKandeloSocketOwners;
  while (*link) {
    if (*link == state) { *link = state->next; state->next = nullptr; return; }
    link = &(*link)->next;
  }
}
static void KandeloSocketOwnerFinalize(JS::GCContext*, JSObject* object) {
  const Value slot = JS::GetReservedSlot(object, SocketState);
  if (!slot.isUndefined()) {
    auto* state = static_cast<KandeloSocketState*>(slot.toPrivate());
    KandeloSocketOwnerUnlink(state); delete state;
  }
}
static const JSClassOps KandeloSocketOwnerClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
  KandeloSocketOwnerFinalize, nullptr, nullptr, nullptr};
static const JSClass KandeloSocketOwnerClass = {
  "TCP", JSCLASS_HAS_RESERVED_SLOTS(SocketSlots) | JSCLASS_FOREGROUND_FINALIZE,
  &KandeloSocketOwnerClassOps};
static const JSClass KandeloSocketConnectClass = {
  "TCPConnectWrap", JSCLASS_HAS_RESERVED_SLOTS(SocketSlots) | JSCLASS_FOREGROUND_FINALIZE,
  &KandeloSocketOwnerClassOps};
static const JSClass KandeloSocketWriteClass = {
  "WriteWrap", JSCLASS_HAS_RESERVED_SLOTS(SocketSlots) | JSCLASS_FOREGROUND_FINALIZE,
  &KandeloSocketOwnerClassOps};
// A null-prototype publication capability roots the actual already-initialized
// accepted TCP owner. The capability has no fabricated AsyncWrap identity.
static const JSClass KandeloAcceptedSocketClass = {
  "KandeloAcceptedSocket", JSCLASS_HAS_RESERVED_SLOTS(SocketSlots) | JSCLASS_FOREGROUND_FINALIZE,
  &KandeloSocketOwnerClassOps};
void KandeloSocketState::CloseAccepted() {
  if (!accepted) return;
  // The persistent root keeps this actual owner/state alive even if both
  // token and closed handle would otherwise be finalized in the same GC.
  const Value slot = JS::GetReservedSlot(*accepted, SocketState);
  auto* owner = slot.isUndefined() ? nullptr : static_cast<KandeloSocketState*>(slot.toPrivate());
  if (owner) owner->BeginClose();
  accepted.reset();RefreshMemory();
}
static bool KandeloCreateSocketOwner(JSContext* cx, MutableHandleObject result,
                                     kandelo::socket::Lease* prior);
static KandeloSocketState* KandeloAcceptedSocketState(JSContext* cx, HandleValue value) {
  JSObject* object = value.isObject() ? js::CheckedUnwrapStatic(&value.toObject()) : nullptr;
  if (!object || JS::GetClass(object) != &KandeloAcceptedSocketClass) {
    JS_ReportErrorASCII(cx, "Invalid accepted TCP lease"); return nullptr;
  }
  const Value slot = JS::GetReservedSlot(object, SocketState);
  auto* state = slot.isUndefined() ? nullptr : static_cast<KandeloSocketState*>(slot.toPrivate());
  if (!state || state->detached || state->cx != cx) {
    JS_ReportErrorASCII(cx, "Accepted TCP lease belongs to a retired or different context"); return nullptr;
  }
  return state;
}
static bool KandeloResolveAcceptedSocket(JSContext* cx, HandleObject promise, int fd) {
  kandelo::socket::Lease prior(fd);
  // Poll dispatch need not still be in the realm that registered the accept.
  // The actual request Promise owns the creation realm of its TCP and token.
  JSAutoRealm realm(cx, promise);
  RootedObject token(cx, JS_NewObjectWithGivenProto(cx, &KandeloAcceptedSocketClass, nullptr)); if (!token) return false;
  std::unique_ptr<KandeloSocketState> preparing;
  try {
    preparing = std::make_unique<KandeloSocketState>(cx);
    preparing->claims.Add(preparing->allocation.Handle(), KandeloNativeMemoryOwner(cx));
    preparing->RefreshMemory();
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  RootedObject owner(cx);
  // Pinned ConnectionWrap creates the real client TCPWRAP before onconnection
  // enters Socket construction/drop/blocklist getters. The candidate keeps
  // fd -1 through init, then the existing transaction adopts the actual lease.
  if (!KandeloCreateSocketOwner(cx, &owner, &prior)) return false;
  auto* actual = static_cast<KandeloSocketState*>(JS::GetReservedSlot(owner, SocketState).toPrivate());
  bool rooted = false;
  auto closeUnrooted = mozilla::MakeScopeExit([&] { if (!rooted) actual->BeginClose(); });
  try { preparing->accepted = std::make_unique<PersistentRootedObject>(cx, owner); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  rooted = true;preparing->RefreshMemory();
  auto* state = preparing.release();
  JS::SetReservedSlot(token, SocketState, PrivateValue(state));
  state->next = gKandeloSocketOwners; gKandeloSocketOwners = state;
  bool resolved = false;
  auto rollback = mozilla::MakeScopeExit([&] { if (!resolved) state->CloseAccepted(); });
  RootedValue result(cx, ObjectValue(*token));
  // Keep the null-prototype capability: publishing a mutable TCP prototype
  // directly would add an inherited then-getter assimilation/reentry path.
  if (!JS::ResolvePromise(cx, promise, result)) return false;
  resolved = true; return true;
}
static KandeloSocketState* KandeloAcceptedOwnerState(JSContext* cx, KandeloSocketState* token) {
  if (!token->accepted) {
    JS_ReportErrorASCII(cx, "Accepted TCP lease has already retired or transferred"); return nullptr;
  }
  const Value slot = JS::GetReservedSlot(*token->accepted, SocketState);
  auto* owner = slot.isUndefined() ? nullptr : static_cast<KandeloSocketState*>(slot.toPrivate());
  if (!owner || owner->detached || owner->cx != cx || !owner->socket || owner->socket->Fd() < 0) {
    JS_ReportErrorASCII(cx, "Accepted TCP owner has already closed"); return nullptr;
  }
  return owner;
}
static bool KandeloNativeAcceptedSocketFd(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = KandeloAcceptedSocketState(cx, args.get(0)); if (!state) return false;
  auto* owner = KandeloAcceptedOwnerState(cx, state);if (!owner) return false;
  args.rval().setInt32(owner->socket->Fd()); return true;
}
static bool KandeloNativeCloseAcceptedSocket(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = KandeloAcceptedSocketState(cx, args.get(0)); if (!state) return false;
  state->CloseAccepted();args.rval().setUndefined(); return true;
}
static KandeloSocketState* KandeloSocketOwnerState(JSContext* cx, HandleObject object,
                                                    bool allowWrite = false) {
  JSObject* owner = object ? js::CheckedUnwrapStatic(object) : nullptr;
  if (!owner || (JS::GetClass(owner) != &KandeloSocketOwnerClass &&
      (!allowWrite || (JS::GetClass(owner) != &KandeloSocketWriteClass &&
                       JS::GetClass(owner) != &KandeloSocketConnectClass)))) {
    JS_ReportErrorASCII(cx, "Invalid native TCP owner"); return nullptr;
  }
  const Value slot = JS::GetReservedSlot(owner, SocketState);
  auto* state = slot.isUndefined() ? nullptr : static_cast<KandeloSocketState*>(slot.toPrivate());
  if (!state || state->detached || state->cx != cx) {
    JS_ReportErrorASCII(cx, "TCP owner belongs to a retired or different context"); return nullptr;
  }
  return state;
}
static KandeloSocketState* KandeloSocketThis(JSContext* cx, const CallArgs& args) {
  if (!args.thisv().isObject()) { JS_ReportErrorASCII(cx, "Invalid native TCP receiver"); return nullptr; }
  RootedObject owner(cx, js::CheckedUnwrapStatic(&args.thisv().toObject()));
  return KandeloSocketOwnerState(cx, owner);
}
// StreamBase uses a native internal field, not an ordinary property lookup at
// delivery. A shadowing own property must not invoke arbitrary JS or replace
// the callback already owned by this native field.
static bool KandeloSocketOnReadGet(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!KandeloSocketThis(cx, args)) return false;
  RootedObject owner(cx, js::CheckedUnwrapStatic(&args.thisv().toObject()));
  RootedValue callback(cx, JS::GetReservedSlot(owner, SocketOnRead));
  if (!JS_WrapValue(cx, &callback)) return false;
  args.rval().set(callback); return true;
}
static bool KandeloSocketOnReadSet(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!KandeloSocketThis(cx, args)) return false;
  // Pinned BaseObject::InternalFieldSet<Value::IsFunction> uses CHECK.
  MOZ_RELEASE_ASSERT(args.get(0).isObject() && JS::IsCallable(&args[0].toObject()));
  RootedObject owner(cx, js::CheckedUnwrapStatic(&args.thisv().toObject()));
  JSAutoRealm realm(cx, owner);
  RootedValue callback(cx, args[0]);
  if (!JS_WrapValue(cx, &callback)) return false;
  JS::SetReservedSlot(owner, SocketOnRead, callback);
  args.rval().setUndefined(); return true;
}
static bool KandeloSocketPrototype(JSContext* cx, MutableHandleObject result) {
  auto* environment = js::shell::KandeloGetNativeAsyncState(cx);
  if (!environment) return false;
  if (environment->detached || !environment->process.initialized() || !environment->process) {
    JS_ReportErrorASCII(cx, "TCP prototype requires its live process environment"); return false;
  }
  RootedObject global(cx, JS::CurrentGlobalOrNull(cx));
  RootedObject process(cx, js::CheckedUnwrapStatic(environment->process));
  if (!global || !process) {
    JS_ReportErrorASCII(cx, "TCP prototype realm is unavailable"); return false;
  }
  RootedValue key(cx, ObjectValue(*global)), value(cx);
  RootedObject map(cx);
  {
    // The rooted map belongs to the environment's existing process realm,
    // never to the first foreign realm that happens to create a socket.
    JSAutoRealm realm(cx, process);
    if (!environment->socketPrototypes.initialized()) {
      map = JS::NewWeakMapObject(cx); if (!map) return false;
      environment->socketPrototypes.init(cx); environment->socketPrototypes = map;
    } else map = environment->socketPrototypes;
    if (!JS_WrapValue(cx, &key) || !JS::GetWeakMapEntry(cx, map, key, &value)) return false;
  }
  if (value.isUndefined()) {
    RootedObject streamPrototype(cx, JS_NewPlainObject(cx)); if (!streamPrototype) return false;
    RootedFunction getter(cx, JS_NewFunction(cx, KandeloSocketOnReadGet, 0, 0, nullptr));
    if (!getter) return false;
    RootedObject getObject(cx, JS_GetFunctionObject(getter));
    RootedFunction setter(cx, JS_NewFunction(cx, KandeloSocketOnReadSet, 0, 0, nullptr));
    if (!setter) return false;
    RootedObject setObject(cx, JS_GetFunctionObject(setter));
    // Native AddAccessor exposes anonymous zero-length functions on the
    // StreamBase prototype, one level above the TCP prototype.
    if (!JS_DefineProperty(cx, streamPrototype, "onread", getObject, setObject, JSPROP_PERMANENT)) return false;
    RootedObject prototype(cx, JS_NewPlainObject(cx));
    if (!prototype || !JS_SetPrototype(cx, prototype, streamPrototype)) return false;
    value.setObject(*prototype);
    {
      JSAutoRealm realm(cx, process);
      if (!JS_WrapValue(cx, &value) || !JS::SetWeakMapEntry(cx, map, key, value)) return false;
    }
  }
  if (!JS_WrapValue(cx, &value)) return false;
  MOZ_RELEASE_ASSERT(value.isObject());
  result.set(&value.toObject()); return true;
}
static bool KandeloSocketResourceInfo(JSContext* cx, HandleObject owner,
                                       MutableHandleValue result) {
  auto* state = KandeloSocketOwnerState(cx, owner, true); if (!state) return false;
  JS::RootedValueArray<5> entries(cx);
  entries[0].setNumber(state->id); entries[1].setNumber(state->trigger);
  entries[2].set(JS::GetReservedSlot(owner, SocketFrame));
  RootedString provider(cx, JS_NewStringCopyZ(cx, state->connect ? "TCPCONNECTWRAP" : state->writeResource ? "WRITEWRAP" : "TCPWRAP"));
  if (!provider) return false;
  entries[3].setString(provider);
  entries[4].set(JS::GetReservedSlot(owner, SocketExecutionResource));
  for (size_t i = 0; i < 5; ++i) if (!JS_WrapValue(cx, entries[i])) return false;
  RootedObject array(cx, JS::NewArrayObject(cx, entries)); if (!array) return false;
  result.setObject(*array); return true;
}
static bool KandeloSocketInitialize(JSContext* cx, HandleObject owner,
                                     HandleValue executionResource, double forcedTrigger = -1) {
  auto* state = KandeloSocketOwnerState(cx, owner, true); if (!state) return false;
  RootedValue frame(cx); double trigger;
  if (!cx->kandeloAsyncProperty("frame", &frame) ||
      !cx->getKandeloDefaultTriggerAsyncId(&trigger)) return false;
  if (!state->lifetime) {
    state->lifetime = js::shell::KandeloGetNativeAsyncState(cx);
    if (!state->lifetime) return false;
    state->lifetime->Retain();
  }
  RootedValue wrappedResource(cx, executionResource);
  if (!JS_WrapValue(cx, &frame) || !JS_WrapValue(cx, &wrappedResource)) return false;
  state->Retire(); state->id = cx->allocateKandeloAsyncId();
  state->trigger = forcedTrigger >= 0 ? forcedTrigger : trigger;
  state->retired = false;
  JS::SetReservedSlot(owner, SocketFrame, frame);
  JS::SetReservedSlot(owner, SocketExecutionResource, wrappedResource);
  return cx->notifyKandeloAsyncLifecycle("native:init", owner, frame);
}
static bool KandeloSocketRootPending(JSContext* cx, HandleObject owner,
                                      KandeloSocketState* state) {
  if (state->pending) return true;
  try { state->pending = std::make_unique<PersistentRootedObject>(cx, owner); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  state->RefreshMemory(); return true;
}
static void KandeloSocketRetireClosed(JSContext* cx, HandleObject owner,
                                       KandeloSocketState* state) {
  if (!state->socket || !state->socket->Closed() || state->closing || state->socket->HasTransportRequests()) return;
  for (auto* work = gKandeloSocketOwners; work; work = work->next) {
    if (work->cx != cx || !work->pending || (!work->write && !work->connect)) continue;
    RootedObject request(cx, *work->pending);
    if (JS::GetReservedSlot(request, SocketParent) == ObjectValue(*owner)) return;
  }
  state->Retire();
  JS::SetReservedSlot(owner, SocketFrame, UndefinedValue());
}
static void KandeloRetireSocketRequest(HandleObject request, KandeloSocketState* state) {
  state->pending.reset(); state->write.reset(); state->Retire();
  // ReqWrap disposal releases its native parent/callback/context-frame edges
  // even when an init hook retained the actual JS request object.
  for (uint32_t slot : {SocketParent, SocketFrame, SocketDispatch})
    JS::SetReservedSlot(request, slot, UndefinedValue());
  state->RefreshMemory();
}
static bool KandeloSocketFd(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloSocketThis(cx, args);
  if (!state) return false; args.rval().setInt32(state->socket->Fd()); return true;
}
static bool KandeloSocketClose(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloSocketThis(cx, args);
  if (!state) return false;
  args.rval().setUndefined();
  if (state->socket->Fd() < 0 && !state->liveRoot) return true;
  RootedObject owner(cx, js::CheckedUnwrapStatic(&args.thisv().toObject()));
  JSAutoRealm realm(cx, owner);
  RootedValue callback(cx, args.get(0));
  if (callback.isObject() && JS::IsCallable(&callback.toObject()) &&
      JS::GetReservedSlot(owner, SocketCloseCallback).isUndefined()) {
    if (!JS_WrapValue(cx, &callback)) return false;
    // Internal connect cancellation may already have closed the actual fd.
    // Register the one Socket close continuation while that real native
    // completion is still pending; an existing continuation is never replaced.
    JS::SetReservedSlot(owner, SocketCloseCallback, callback);
  }
  state->BeginClose(); return true;
}
static bool KandeloNativeAbortSocketAdoption(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) { JS_ReportErrorASCII(cx, "Invalid TCP adoption owner"); return false; }
  RootedObject owner(cx, &args[0].toObject());
  auto* state = KandeloSocketOwnerState(cx, owner); if (!state) return false;
  // Publication rollback uses the native owner, even if init hooks replaced
  // public JS handle methods before Socket wrapper publication could commit.
  state->BeginClose(); args.rval().setUndefined(); return true;
}
static bool KandeloNativeCommitSocketAdoption(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) { JS_ReportErrorASCII(cx, "Invalid TCP adoption owner"); return false; }
  RootedObject owner(cx, &args[0].toObject()); auto* state = KandeloSocketOwnerState(cx, owner);
  if (!state) return false;
  if (state->socket->Closed() || !state->liveRoot) {
    JS_ReportErrorASCII(cx, "TCP owner closed before Socket publication committed"); return false;
  }
  state->socketPublished = true; args.rval().setUndefined(); return true;
}
static bool KandeloSocketRef(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloSocketThis(cx, args);
  if (!state) return false;
  state->socket->Ref(argc == 0 || JS::ToBoolean(args[0])); args.rval().setUndefined(); return true;
}
static bool KandeloSocketHasPendingRead(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloSocketThis(cx, args);
  if (!state) return false;
  const int status = state->socket->PendingRead();
  // The Agent's boolean guard treats actual errors as pending, never idle.
  args.rval().setBoolean(status > 0 || (status < 0 && status != -ENOTCONN && status != -ENOTSOCK)); return true;
}
static bool KandeloSocketPendingReadStatus(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloSocketThis(cx, args);
  if (!state) return false; args.rval().setInt32(state->socket->PendingRead()); return true;
}
static bool KandeloSocketReadStart(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloSocketThis(cx, args);
  if (!state) return false;
  if (state->socket->HasTransport()) { args.rval().setInt32(-EBUSY); return true; }
  RootedObject owner(cx, js::CheckedUnwrapStatic(&args.thisv().toObject()));
  const bool priorRoot = bool(state->pending), priorReading = state->socket->Reading();
  if (!KandeloSocketRootPending(cx, owner, state)) return false;
  try {
    if (!state->socket->StartRead()) { state->pending.reset(); args.rval().setInt32(-EBADF); return true; }
    auto ticket = state->socket->CurrentRead();
    if (ticket && !state->readClaim)
      state->readClaim = std::make_unique<kandelo::memory::Claim>(ticket->allocation.Handle(), KandeloNativeMemoryOwner(cx));
  } catch (const std::bad_alloc&) {
    if (!priorReading) state->socket->StopRead();
    if (!priorRoot) state->pending.reset();
    state->RefreshMemory(); JS_ReportOutOfMemory(cx); return false;
  }
  state->RefreshMemory(); args.rval().setInt32(0); return true;
}
static bool KandeloSocketReadStop(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloSocketThis(cx, args);
  if (!state) return false;
  state->socket->StopRead(); state->pending.reset();
  if (!state->socket->CurrentRead()) state->readClaim.reset();
  state->RefreshMemory();
  args.rval().setInt32(0); return true;
}
static bool KandeloSocketAsyncId(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloSocketThis(cx, args);
  if (!state) return false; args.rval().setNumber(state->id); return true;
}
static bool KandeloSocketProvider(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); if (!KandeloSocketThis(cx, args)) return false;
  // Index of TCPWRAP in the pinned async_wrap.h non-crypto provider list.
  // The source generator/control validates this against the actual owner list.
  args.rval().setInt32(41); return true;
}
static bool KandeloSocketAsyncReset(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloSocketThis(cx, args);
  if (!state) return false;
  if (state->socket->Fd() < 0) { JS_ReportErrorASCII(cx, "TCP owner is closed"); return false; }
  RootedObject owner(cx, js::CheckedUnwrapStatic(&args.thisv().toObject()));
  JSAutoRealm realm(cx, owner);
  RootedValue resource(cx, args.get(0));
  if (!resource.isObject()) { JS_ReportErrorASCII(cx, "TCP reset requires its real execution resource"); return false; }
  if (!KandeloSocketInitialize(cx, owner, resource)) return false;
  args.rval().setUndefined(); return true;
}
static bool KandeloSocketConfigure(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloSocketThis(cx, args);
  if (!state) return false;
  if (!args.get(0).isObject() || !JS::IsCallable(&args[0].toObject())) {
    JS_ReportErrorASCII(cx, "TCP read dispatcher must be callable"); return false;
  }
  RootedObject owner(cx, js::CheckedUnwrapStatic(&args.thisv().toObject()));
  JSAutoRealm realm(cx, owner);
  RootedValue callback(cx, args[0]), streamState(cx, args.get(1));
  RootedObject view(cx, streamState.isObject() ? js::CheckedUnwrapStatic(&streamState.toObject()) : nullptr);
  if (!view || !JS_IsInt32Array(view) || JS_GetTypedArrayLength(view) < SocketStreamStateFields::kNumStreamBaseStateFields) {
    JS_ReportErrorASCII(cx, "TCP dispatcher requires its actual stream state"); return false;
  }
  if (!JS_WrapValue(cx, &callback) || !JS_WrapValue(cx, &streamState)) return false;
  JS::SetReservedSlot(owner, SocketDispatch, callback);
  JS::SetReservedSlot(owner, SocketStreamState, streamState);
  args.rval().setUndefined(); return true;
}
static bool KandeloSocketSetOption(JSContext* cx, const CallArgs& args, bool keepAlive) {
  auto* state = KandeloSocketThis(cx, args); if (!state) return false;
  const int enabled = JS::ToBoolean(args.get(0)) ? 1 : 0;
  int status = setsockopt(state->socket->Fd(), keepAlive ? SOL_SOCKET : IPPROTO_TCP,
                         keepAlive ? SO_KEEPALIVE : TCP_NODELAY, &enabled, sizeof(enabled));
  args.rval().setInt32(status < 0 ? -errno : 0); return true;
}
static bool KandeloSocketSetNoDelay(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); return KandeloSocketSetOption(cx, args, false);
}
static bool KandeloSocketSetKeepAlive(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloSocketThis(cx, args);
  if (!state) return false;
  const int enabled = JS::ToBoolean(args.get(0));
  uint32_t idle, interval = 1, count = 10;
  if (!JS::ToUint32(cx, args.get(1), &idle)) return false;
  auto actualUint32 = [](const Value& value) {
    return value.isNumber() && value.toNumber() >= 0 && value.toNumber() <= UINT32_MAX &&
           double(uint32_t(value.toNumber())) == value.toNumber();
  };
  if (actualUint32(args.get(2))) interval = uint32_t(args[2].toNumber());
  if (actualUint32(args.get(3))) count = uint32_t(args[3].toNumber());
  // Conversion can reenter and retire/reuse the old fd. The owning backend
  // fetches its actual descriptor only after all such JavaScript has returned.
  const int error = state->socket->SetKeepAlive(enabled != 0, idle, interval, count);
  args.rval().setInt32(-error); return true;
}
static bool KandeloSocketWriteQueueSize(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloSocketThis(cx, args);
  if (!state) return false;
  RootedObject owner(cx, js::CheckedUnwrapStatic(&args.thisv().toObject()));
  double total = 0;
  for (auto* work = gKandeloSocketOwners; work; work = work->next) {
    if (work->cx != cx || !work->write || !work->pending) continue;
    RootedObject request(cx, *work->pending);
    const Value parent = JS::GetReservedSlot(request, SocketParent);
    if (parent == ObjectValue(*owner)) total += double(work->write->Remaining());
  }
  args.rval().setNumber(total); return true;
}
static bool KandeloSocketEarlierWrite(JSContext* cx, HandleObject parent) {
  for (auto* active = gKandeloSocketOwners; active; active = active->next) {
    if (active->cx != cx || !active->write || !active->pending || !active->write->Remaining()) continue;
    RootedObject prior(cx, *active->pending);
    if (JS::GetReservedSlot(prior, SocketParent) == ObjectValue(*parent)) return true;
  }
  return false;
}
static bool KandeloSocketWriteResult(JSContext* cx, HandleValue streamState,
                                     uint64_t bytes, int error, HandleObject request,
                                     MutableHandleValue result) {
  RootedObject view(cx, streamState.isObject() ? js::CheckedUnwrapStatic(&streamState.toObject()) : nullptr);
  if (!view || !JS_IsInt32Array(view) || JS_GetTypedArrayLength(view) < SocketStreamStateFields::kNumStreamBaseStateFields) {
    JS_ReportErrorASCII(cx, "TCP write requires its actual stream state"); return false;
  }
  {
    JS::AutoCheckCannotGC nogc; bool shared;
    int32_t* data = JS_GetInt32ArrayData(view, &shared, nogc);
    if (shared || !data) { JS_ReportErrorASCII(cx, "TCP stream state is detached or shared"); return false; }
    // Same Int32 producer as StreamBase::SetWriteResult, using the original
    // requested length, including any prefix consumed before request init.
    data[SocketStreamStateFields::kBytesWritten] = int32_t(uint32_t(bytes));
    data[SocketStreamStateFields::kLastWriteWasAsync] = request && !error ? 1 : 0;
    data[SocketStreamStateFields::kLastWriteErr] = -error;
  }
  if (request) result.setObject(*request); else result.setInt32(-error);
  return true;
}
static JS::KandeloBacking::SpanRef KandeloSocketWriteSpan(JSContext* cx, HandleValue input) {
  RootedObject view(cx, input.isObject() ? js::CheckedUnwrapStatic(&input.toObject()) : nullptr);
  if (!view || !JS_IsUint8Array(view)) {
    JS_ReportErrorASCII(cx, "TCP write requires an actual Uint8Array"); return {};
  }
  return JS::KandeloBacking::Acquire(cx, view);
}
static bool KandeloSocketSubmitWrite(JSContext* cx, HandleObject parent,
                                      KandeloSocketState* parentState,
                                      std::vector<JS::KandeloBacking::SpanRef> spans,
                                      MutableHandleValue result) {
  RootedValue streamState(cx, JS::GetReservedSlot(parent, SocketStreamState));
  std::unique_ptr<KandeloSocketWriteMaterial> work;
  try { work = std::make_unique<KandeloSocketWriteMaterial>(std::move(spans)); }
  catch (const std::length_error&) {
    RootedObject empty(cx); return KandeloSocketWriteResult(cx, streamState, 0, ENOBUFS, empty, result);
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  const uint64_t bytes = work->totalBytes;
  RootedObject empty(cx);
  // Capture precedes try-write and request initialization. A completed initial
  // try-write has no WRITEWRAP; EAGAIN retains the same original allocations.
  if (!KandeloSocketEarlierWrite(cx, parent) && parentState->socket->ProgressWrite(*work))
    return KandeloSocketWriteResult(cx, streamState, bytes, work->error, empty, result);
  RootedObject request(cx, JS_NewObject(cx, &KandeloSocketWriteClass)); if (!request) return false;
  std::unique_ptr<KandeloSocketState> preparing;
  try {
    preparing = std::make_unique<KandeloSocketState>(cx);
    preparing->writeResource = true; preparing->write = std::move(work);
    preparing->claims.Add(preparing->allocation.Handle(), KandeloNativeMemoryOwner(cx)); preparing->RefreshMemory();
    preparing->claims.Add(preparing->write->allocation.Handle(), KandeloNativeMemoryOwner(cx)); preparing->RefreshMemory();
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  auto* state = preparing.release();
  JS::SetReservedSlot(request, SocketState, PrivateValue(state));
  bool submitted = false;
  auto abandon = mozilla::MakeScopeExit([&] {
    if (!submitted) KandeloRetireSocketRequest(request, state);
  });
  JS::SetReservedSlot(request, SocketParent, ObjectValue(*parent));
  RootedValue status(cx, NullValue());
  if (!JS_DefineProperty(cx, request, "writeStatus", status, JSPROP_ENUMERATE) ||
      !KandeloSocketRootPending(cx, request, state)) return false;
  RootedValue execution(cx, ObjectValue(*request));
  kandelo::async::DefaultTriggerScope triggerScope(cx->kandeloDefaultTrigger(), parentState->id);
  if (!triggerScope.Ready()) { JS_ReportErrorASCII(cx, "TCP parent has no valid async identity"); return false; }
  if (!KandeloSocketInitialize(cx, request, execution, parentState->id)) return false;
  // Like uv_write2, the operation is published only AFTER WRITEWRAP init.
  // An init hook's nested write can therefore precede this outer remainder.
  const int submissionError = parentState->socket->ValidateWrite(*state->write);
  if (submissionError)
    return KandeloSocketWriteResult(cx, streamState, bytes, submissionError, request, result);
  if (!KandeloSocketEarlierWrite(cx, parent)) parentState->socket->ProgressWrite(*state->write);
  state->writeSequence = ++parentState->writeSequence;
  state->next = gKandeloSocketOwners; gKandeloSocketOwners = state;
  submitted = true;
  return KandeloSocketWriteResult(cx, streamState, bytes, 0, request, result);
}
static bool KandeloSocketWrite(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* parentState = KandeloSocketThis(cx, args);
  if (!parentState) return false;
  RootedObject parent(cx, js::CheckedUnwrapStatic(&args.thisv().toObject()));
  JSAutoRealm realm(cx, parent);
  auto span = KandeloSocketWriteSpan(cx, args.get(0)); if (!span) return false;
  try {
    std::vector<JS::KandeloBacking::SpanRef> spans;
    spans.push_back(std::move(span));
    return KandeloSocketSubmitWrite(cx, parent, parentState, std::move(spans), args.rval());
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
static bool KandeloSocketWriteVector(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* parentState = KandeloSocketThis(cx, args);
  if (!parentState) return false;
  RootedObject parent(cx, js::CheckedUnwrapStatic(&args.thisv().toObject()));
  JSAutoRealm realm(cx, parent);
  RootedObject chunks(cx, args.get(0).isObject() ? &args[0].toObject() : nullptr);
  bool array = false;
  if (!chunks || !JS::IsArrayObject(cx, chunks, &array) || !array) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "TCP vector write requires an actual array");
    return false;
  }
  uint32_t count;
  if (!JS::GetArrayLength(cx, chunks, &count)) return false;
  try {
    std::vector<JS::KandeloBacking::SpanRef> spans; spans.reserve(count);
    for (uint32_t i = 0; i < count; ++i) {
      RootedValue entry(cx);
      if (!JS_GetElement(cx, chunks, i, &entry)) return false;
      auto span = KandeloSocketWriteSpan(cx, entry); if (!span) return false;
      spans.push_back(std::move(span));
    }
    return KandeloSocketSubmitWrite(cx, parent, parentState, std::move(spans), args.rval());
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
static int KandeloDispatchSocketWrite(JSContext* cx, KandeloSocketState* state) {
  RootedObject request(cx, *state->pending); JSAutoRealm realm(cx, request);
  RootedObject parent(cx, &JS::GetReservedSlot(request, SocketParent).toObject());
  auto* parentState = KandeloSocketOwnerState(cx, parent); if (!parentState) return -1;
  for (auto* prior = gKandeloSocketOwners; prior; prior = prior->next) {
    if (prior == state || prior->cx != cx || !prior->write || !prior->pending ||
        prior->writeSequence >= state->writeSequence) continue;
    RootedObject earlier(cx, *prior->pending);
    if (JS::GetReservedSlot(earlier, SocketParent) == ObjectValue(*parent)) return 0;
  }
  if (parentState->socket->Fd() < 0 && !state->write->complete) {
    state->write->error = ECANCELED; state->write->complete = true;
  } else if (!parentState->socket->ProgressWrite(*state->write)) return 0;
  state->callbackActive = true;
  auto leaveCallback = mozilla::MakeScopeExit([&] { state->callbackActive = false; });
  auto disposeRequest = mozilla::MakeScopeExit([&] {
    KandeloRetireSocketRequest(request, state);
    KandeloSocketRetireClosed(cx, parent, parentState);
  });
  RootedValue callback(cx), status(cx, Int32Value(-state->write->error));
  if (!JS_GetProperty(cx, request, "oncomplete", &callback)) return -1;
  if (!callback.isObject() || !JS::IsCallable(&callback.toObject())) {
    if (!JS_SetProperty(cx, request, "writeStatus", status)) return -1;
    return 1;
  }
  RootedValue frame(cx, JS::GetReservedSlot(request, SocketFrame));
  KandeloNativeCallbackScope scope(cx, request, frame);
  if (!scope.Enter()) return -1;
  if (scope.Stopped()) return scope.Close() ? 0 : -1;
  JS::RootedValueArray<3> arguments(cx);
  arguments[0].set(status); arguments[1].setObject(*parent); arguments[2].setUndefined();
  RootedValue ignored(cx);
  const bool called = JS_CallFunctionValue(cx, request, callback, arguments, &ignored);
  if (!(called ? scope.Close() : scope.Fail())) return -1;
  return 1;
}
static bool KandeloCreateSocketOwner(JSContext* cx, MutableHandleObject result,
                                       kandelo::socket::Lease* prior = nullptr) {
  if (prior) {
  int kind = 0; socklen_t kindSize = sizeof(kind);
  if (getsockopt(prior->Fd(), SOL_SOCKET, SO_TYPE, &kind, &kindSize) < 0 || kind != SOCK_STREAM) {
    JS_ReportErrorASCII(cx, "Native TCP owner requires a stream socket"); return false;
  }
  sockaddr_storage endpoint = {}; socklen_t endpointSize = sizeof(endpoint);
  if (getsockname(prior->Fd(), reinterpret_cast<sockaddr*>(&endpoint), &endpointSize) < 0 ||
      (endpoint.ss_family != AF_INET && endpoint.ss_family != AF_INET6)) {
    JS_ReportErrorASCII(cx, "Native TCP owner requires an actual INET socket"); return false;
  }
  }
  RootedObject owner(cx, JS_NewObject(cx, &KandeloSocketOwnerClass)); if (!owner) return false;
  KandeloSocketState* state = nullptr;
  bool published = false;
  auto abandon = mozilla::MakeScopeExit([&] { if (state && !published) { state->Close(); state->Retire(); } });
  try {
    state = new KandeloSocketState(cx);
    if (!state) { JS_ReportOutOfMemory(cx); return false; }
    JS::SetReservedSlot(owner, SocketState, PrivateValue(state));
    state->socket = std::make_unique<kandelo::socket::Owner>(++gKandeloSocketGeneration);
    state->liveRoot = std::make_unique<PersistentRootedObject>(cx, owner);
    const auto account = KandeloNativeMemoryOwner(cx);
    state->claims.Add(state->allocation.Handle(), account);
    state->claims.Add(state->socket->allocation.Handle(), account); state->RefreshMemory();
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  state->next = gKandeloSocketOwners; gKandeloSocketOwners = state;
  static const JSFunctionSpec methods[] = {
    JS_FN("write", KandeloSocketWrite, 1, 0),
    JS_FN("writeVector", KandeloSocketWriteVector, 1, 0),
    JS_FN("close", KandeloSocketClose, 0, 0), JS_FN("ref", KandeloSocketRef, 1, 0),
    JS_FN("readStart", KandeloSocketReadStart, 0, 0), JS_FN("readStop", KandeloSocketReadStop, 0, 0),
    JS_FN("hasPendingRead", KandeloSocketHasPendingRead, 0, 0),
    JS_FN("pendingReadStatus", KandeloSocketPendingReadStatus, 0, 0),
    JS_FN("getAsyncId", KandeloSocketAsyncId, 0, 0), JS_FN("getProviderType", KandeloSocketProvider, 0, 0),
    JS_FN("asyncReset", KandeloSocketAsyncReset, 1, 0), JS_FN("configureRead", KandeloSocketConfigure, 2, 0),
    JS_FN("setNoDelay", KandeloSocketSetNoDelay, 1, 0), JS_FN("setKeepAlive", KandeloSocketSetKeepAlive, 1, 0), JS_FS_END
  };
  static const JSPropertySpec properties[] = { JS_PSG("fd", KandeloSocketFd, 0),
    JS_PSG("writeQueueSize", KandeloSocketWriteQueueSize, 0), JS_PS_END };
  RootedObject prototype(cx);
  if (!KandeloSocketPrototype(cx, &prototype) || !JS_SetPrototype(cx, owner, prototype) ||
      !JS_DefineFunctions(cx, owner, methods) || !JS_DefineProperties(cx, owner, properties)) return false;
  RootedValue execution(cx, ObjectValue(*owner));
  if (!KandeloSocketInitialize(cx, owner, execution)) return false;
  // All fallible JS publication/init work precedes the sole fd transfer.
  if (state->socket->Closed() || (prior && !state->socket->Adopt(*prior))) { JS_ReportErrorASCII(cx, "TCP descriptor adoption failed"); return false; }
  published = true; result.set(owner); return true;
}
// TLS construction needs the real empty TCP resource before DNS/connect.
static bool KandeloNativeCreateSocketOwner(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedObject owner(cx);
  if (!KandeloCreateSocketOwner(cx, &owner)) return false;
  args.rval().setObject(*owner); return true;
}
static bool KandeloNativeAdoptSocket(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); int32_t fd;
  if (!JS::ToInt32(cx, args.get(0), &fd)) return false;
  int kind = 0; socklen_t kindSize = sizeof(kind);
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &kind, &kindSize) < 0 || kind != SOCK_STREAM) {
    JS_ReportErrorASCII(cx, "Socket fd is not a TCP stream descriptor"); return false;
  }
  sockaddr_storage endpoint = {}; socklen_t size = sizeof(endpoint);
  if (getsockname(fd, reinterpret_cast<sockaddr*>(&endpoint), &size) < 0 ||
      (endpoint.ss_family != AF_INET && endpoint.ss_family != AF_INET6)) {
    JS_ReportErrorASCII(cx, "Socket fd is not an INET TCP descriptor"); return false;
  }
  const int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
    JS_ReportErrorASCII(cx, "TCP fd cannot enter nonblocking mode"); return false;
  }
  kandelo::socket::Lease prior(fd); RootedObject owner(cx);
  if (!KandeloCreateSocketOwner(cx, &owner, &prior)) return false;
  args.rval().setObject(*owner); return true;
}
static bool KandeloNativeAdoptAcceptedSocket(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = KandeloAcceptedSocketState(cx, args.get(0)); if (!state) return false;
  if (!KandeloAcceptedOwnerState(cx, state)) return false;
  // Transfer the same already-initialized real owner exactly once. No second
  // TCPWRAP construction/init or raw-fd adoption belongs in Socket's getter path.
  RootedObject owner(cx, *state->accepted);
  if (!JS_WrapObject(cx, &owner)) return false;
  state->accepted.reset();state->RefreshMemory();
  args.rval().setObject(*owner); return true;
}
static bool KandeloSocketConnectFailure(JSContext* cx, HandleObject owner,
                                         int error, const char* syscall,
                                         MutableHandleValue result) {
  RootedObject record(cx, JS_NewPlainObject(cx));
  RootedString operation(cx, JS_NewStringCopyZ(cx, syscall));
  if (!record || !operation) return false;
  RootedValue status(cx, Int32Value(-error)), name(cx, StringValue(operation)),
      handle(cx, ObjectValue(*owner));
  if (!JS_DefineProperty(cx, record, "error", status, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, record, "syscall", name, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, record, "owner", handle, JSPROP_ENUMERATE)) return false;
  result.setObject(*record); return true;
}
static bool KandeloNativeConnectSocketOwner(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  UniqueChars host, local;
  int32_t port, family = 0, localPort = 0;
  if (argc < 6 || !KandeloGetString(cx, args[0], &host) || !JS::ToInt32(cx, args[1], &port) ||
      (!args[2].isUndefined() && !JS::ToInt32(cx, args[2], &family)) ||
      (!args[4].isUndefined() && !JS::ToInt32(cx, args[4], &localPort))) return false;
  if (!args[5].isObject() || !JS::IsCallable(&args[5].toObject())) {
    JS_ReportErrorASCII(cx, "TCP connect requires its actual completion callback"); return false;
  }
  const bool hasLocal = !args[3].isNullOrUndefined();
  if (hasLocal && !KandeloGetString(cx, args[3], &local)) return false;
  RootedValue callback(cx, args[5]);
  RootedObject owner(cx);
  if (argc > 6 && !args[6].isUndefined()) {
    if (!args[6].isObject()) { JS_ReportErrorASCII(cx, "TCP connect requires an actual parent"); return false; }
    owner = js::CheckedUnwrapDynamic(&args[6].toObject(), cx);
    if (!owner) { if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx); return false; }
  } else if (!KandeloCreateSocketOwner(cx, &owner)) return false;
  RootedValue result(cx);
  bool ok;
  {
    // The optional actual parent can be admitted through a security-checked CCW.
    // Request slots/lifecycle belong to that parent's realm, not the caller's.
    JSAutoRealm realm(cx, owner);
    if (!JS_WrapValue(cx, &callback)) return false;
    auto submit = [&]() -> bool {
      auto* parentState = KandeloSocketOwnerState(cx, owner); if (!parentState) return false;
      if (!parentState->socket || parentState->closing || parentState->socket->Closed() ||
          parentState->socket->Fd() >= 0 || parentState->connectPreparing) {
        JS_ReportErrorASCII(cx, "TCP parent is closed, connecting, or already has a descriptor"); return false;
      }
      parentState->connectPreparing = true;
      auto preparing = mozilla::MakeScopeExit([&] { parentState->connectPreparing = false; });
      bool submitted = false;
      auto closeFailure = mozilla::MakeScopeExit([&] { if (!submitted) parentState->BeginClose(); });
      auto failed = [&](int error, const char* syscall) {
        if (!KandeloSocketConnectFailure(cx, owner, error, syscall, &result)) return false;
        submitted = true; return true;
      };
      if (port < 0 || port > 65535 || localPort < 0 || localPort > 65535) return failed(EINVAL, "connect");
      addrinfo hints = {}; hints.ai_family = family == 6 ? AF_INET6 : family == 4 ? AF_INET : AF_UNSPEC;
      hints.ai_socktype = SOCK_STREAM; hints.ai_flags = AI_NUMERICHOST;
      addrinfo* target = nullptr;
      if (getaddrinfo(host.get(), nullptr, &hints, &target) != 0 || !target) {
        if (target) freeaddrinfo(target); return failed(EINVAL, "connect");
      }
      auto freeTarget = mozilla::MakeScopeExit([&] { freeaddrinfo(target); });
      if (target->ai_family == AF_INET6) reinterpret_cast<sockaddr_in6*>(target->ai_addr)->sin6_port = htons(uint16_t(port));
      else reinterpret_cast<sockaddr_in*>(target->ai_addr)->sin_port = htons(uint16_t(port));
      auto ensureDescriptor = [&]() -> int {
        if (parentState->socket->Closed()) return ECANCELED;
        if (parentState->socket->Fd() >= 0) return 0;
        kandelo::socket::Lease lease(socket(target->ai_family, SOCK_STREAM, 0));
        if (lease.Fd() < 0) return errno;
        const int flags = fcntl(lease.Fd(), F_GETFL, 0);
        if (flags < 0 || fcntl(lease.Fd(), F_SETFL, flags | O_NONBLOCK) < 0 ||
            fcntl(lease.Fd(), F_SETFD, FD_CLOEXEC) < 0) return errno;
        if (parentState->socket->Closed()) return ECANCELED;
        return parentState->socket->Adopt(lease) ? 0 : errno;
      };
      if (hasLocal || localPort) {
        const int error = ensureDescriptor(); if (error) return failed(error, "bind");
        const int fd = parentState->socket->Fd(), reuse = 1;
        if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0) return failed(errno, "bind");
        const char* name = target->ai_family == AF_INET6 ? "::" : "0.0.0.0";
        if (hasLocal) name = local.get();
        addrinfo localHints = hints; localHints.ai_family = target->ai_family;
        addrinfo* bindAddress = nullptr;
        if (getaddrinfo(name, nullptr, &localHints, &bindAddress) != 0 || !bindAddress) {
          if (bindAddress) freeaddrinfo(bindAddress); return failed(EINVAL, "bind");
        }
        auto freeLocal = mozilla::MakeScopeExit([&] { freeaddrinfo(bindAddress); });
        if (bindAddress->ai_family == AF_INET6) reinterpret_cast<sockaddr_in6*>(bindAddress->ai_addr)->sin6_port = htons(uint16_t(localPort));
        else reinterpret_cast<sockaddr_in*>(bindAddress->ai_addr)->sin_port = htons(uint16_t(localPort));
    #ifdef IPV6_V6ONLY
        if (bindAddress->ai_family == AF_INET6) {
          const int only = 0;
          if (setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &only, sizeof(only)) < 0) return failed(errno, "bind");
        }
    #endif
        if (bind(fd, bindAddress->ai_addr, bindAddress->ai_addrlen) < 0)
          return failed(errno == EAFNOSUPPORT ? EINVAL : errno, "bind");
      }
      RootedObject request(cx, JS_NewObject(cx, &KandeloSocketConnectClass)); if (!request) return false;
      KandeloSocketState* state;
      try {
        state = new KandeloSocketState(cx);
        JS::SetReservedSlot(request, SocketState, PrivateValue(state)); state->connect = true;
        state->claims.Add(state->allocation.Handle(), KandeloNativeMemoryOwner(cx)); state->RefreshMemory();
      } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
      JS::SetReservedSlot(request, SocketParent, ObjectValue(*owner));
      JS::SetReservedSlot(request, SocketDispatch, callback);
      if (!KandeloSocketRootPending(cx, request, state)) return false;
      state->next = gKandeloSocketOwners; gKandeloSocketOwners = state;
      RootedValue execution(cx, ObjectValue(*request));
      // Like TCPWrap::Connect, nested init work inherits the actual TCP parent.
      kandelo::async::DefaultTriggerScope triggerScope(cx->kandeloDefaultTrigger(), parentState->id);
      if (!triggerScope.Ready()) {
        KandeloRetireSocketRequest(request, state);
        JS_ReportErrorASCII(cx, "TCP parent has no valid async identity"); return false;
      }
      if (!KandeloSocketInitialize(cx, request, execution, parentState->id)) {
        KandeloRetireSocketRequest(request, state); return false;
      }
      const int openError = ensureDescriptor();
      if (openError) { KandeloRetireSocketRequest(request, state); KandeloSocketRetireClosed(cx, owner, parentState); return failed(openError, "connect"); }
      int connected;
      do {
        errno = 0;
        connected = connect(parentState->socket->Fd(), target->ai_addr, target->ai_addrlen);
      } while (connected < 0 && errno == EINTR);
      if (connected < 0 && errno != 0 && errno != EINPROGRESS) {
        if (errno == ECONNREFUSED) state->connectError = ECONNREFUSED;
        else {
          const int error = errno; KandeloRetireSocketRequest(request, state);
          KandeloSocketRetireClosed(cx, owner, parentState); return failed(error, "connect");
        }
      }
      state->connectSubmitted = true;
      submitted = true; result.setObject(*request); return true;
    };
    ok = submit();
  }
  if (!ok || !JS_WrapValue(cx, &result)) return false;
  args.rval().set(result); return true;
}
static KandeloSocketState* KandeloSocketConnectRequest(JSContext* cx, HandleObject token) {
  JSObject* actual = js::CheckedUnwrapStatic(token);
  if (!actual || JS::GetClass(actual) != &KandeloSocketConnectClass) return nullptr;
  const Value slot = JS::GetReservedSlot(actual, SocketState);
  auto* state = slot.isUndefined() ? nullptr : static_cast<KandeloSocketState*>(slot.toPrivate());
  return state && state->cx == cx && !state->detached && state->connect && state->pending ? state : nullptr;
}
static bool KandeloNativeSocketConnectOwner(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); args.rval().setUndefined();
  if (!args.get(0).isObject()) return true;
  RootedObject token(cx, &args[0].toObject()); auto* state = KandeloSocketConnectRequest(cx, token);
  if (!state) return true;
  RootedObject request(cx, *state->pending);
  RootedValue owner(cx, JS::GetReservedSlot(request, SocketParent));
  if (!JS_WrapValue(cx, &owner)) return false;
  args.rval().set(owner); return true;
}
static bool KandeloNativeCancelSocketOwnerConnect(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); args.rval().setBoolean(false);
  if (!args.get(0).isObject()) return true;
  RootedObject token(cx, &args[0].toObject()); auto* state = KandeloSocketConnectRequest(cx, token);
  if (!state) return true;
  RootedObject request(cx, *state->pending);
  RootedObject owner(cx, &JS::GetReservedSlot(request, SocketParent).toObject());
  auto* parent = KandeloSocketOwnerState(cx, owner); if (!parent) return false;
  parent->BeginClose(); state->connectError = ECANCELED; args.rval().setBoolean(true); return true;
}
static bool KandeloNativeRefSocketOwnerConnect(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); args.rval().setUndefined();
  if (!args.get(0).isObject()) return true;
  RootedObject token(cx, &args[0].toObject()); auto* state = KandeloSocketConnectRequest(cx, token);
  if (!state) return true;
  RootedObject request(cx, *state->pending);
  RootedObject owner(cx, &JS::GetReservedSlot(request, SocketParent).toObject());
  auto* parent = KandeloSocketOwnerState(cx, owner); if (!parent) return false;
  parent->socket->Ref(JS::ToBoolean(args.get(1))); return true;
}
static int KandeloDispatchSocketConnect(JSContext* cx, KandeloSocketState* state) {
  if (!state->connectSubmitted) return 0;
  RootedObject request(cx, *state->pending); JSAutoRealm realm(cx, request);
  RootedObject owner(cx, &JS::GetReservedSlot(request, SocketParent).toObject());
  auto* parent = KandeloSocketOwnerState(cx, owner); if (!parent) return -1;
  int error = state->connectError;
  if (!error && parent->socket->Fd() < 0) error = ECANCELED;
  if (!error) {
    pollfd descriptor = {}; descriptor.fd = parent->socket->Fd(); descriptor.events = POLLOUT;
    const int ready = poll(&descriptor, 1, 0);
    if (ready == 0 || (ready < 0 && errno == EINTR)) return 0;
    if (ready < 0) error = errno;
    else { socklen_t size = sizeof(error);
      if (getsockopt(parent->socket->Fd(), SOL_SOCKET, SO_ERROR, &error, &size) < 0) error = errno; }
  }
  state->callbackActive = true;
  auto leaveCallback = mozilla::MakeScopeExit([&] { state->callbackActive = false; });
  auto disposeRequest = mozilla::MakeScopeExit([&] {
    KandeloRetireSocketRequest(request, state);
    KandeloSocketRetireClosed(cx, owner, parent);
  });
  RootedValue frame(cx, JS::GetReservedSlot(request, SocketFrame));
  KandeloNativeCallbackScope scope(cx, request, frame);
  if (!scope.Enter()) return -1;
  if (scope.Stopped()) return scope.Close() ? 0 : -1;
  if (!error && parent->socket->Fd() < 0) error = ECANCELED;
  RootedValue callback(cx, JS::GetReservedSlot(request, SocketDispatch)), ignored(cx);
  JS::RootedValueArray<2> arguments(cx);
  arguments[0].setInt32(-error); arguments[1].setObject(*owner);
  const bool called = JS_CallFunctionValue(cx, request, callback, arguments, &ignored);
  if (!(called ? scope.Close() : scope.Fail())) return -1;
  return 1;
}
static int KandeloDispatchSocketClose(JSContext* cx, KandeloSocketState* state) {
  // A retained transport's real native requests must retire before the TCP
  // async close/destroy, including canceled TLS requests awaiting publication.
  if (state->socket->HasTransportRequests()) return 0;
  RootedObject owner(cx, *state->liveRoot); JSAutoRealm realm(cx, owner);
  // An actual native close completion follows its canceled native requests.
  // No reused numeric fd participates in this admission check.
  for (auto* child = gKandeloSocketOwners; child; child = child->next) {
    if (child->cx != cx || !child->pending || (!child->write && !child->connect) ||
        (child->connect && !child->connectSubmitted)) continue;
    RootedObject request(cx, *child->pending);
    if (JS::GetReservedSlot(request, SocketParent) == ObjectValue(*owner)) return 0;
  }
  state->callbackActive = true;
  auto leaveCallback = mozilla::MakeScopeExit([&] { state->callbackActive = false; });
  auto retireClose = mozilla::MakeScopeExit([&] {
    JS::SetReservedSlot(owner, SocketCloseCallback, UndefinedValue());
    state->delivering.reset(); state->readClaim.reset(); state->inflightReadClaim.reset();
    state->closing = false; state->liveRoot.reset();
    KandeloSocketRetireClosed(cx, owner, state); state->RefreshMemory();
  });
  RootedValue callback(cx, JS::GetReservedSlot(owner, SocketCloseCallback));
  if (callback.isObject() && JS::IsCallable(&callback.toObject())) {
    RootedValue frame(cx, JS::GetReservedSlot(owner, SocketFrame)), ignored(cx);
    KandeloNativeCallbackScope scope(cx, owner, frame);
    if (!scope.Enter()) return -1;
    if (scope.Stopped()) return scope.Close() ? 0 : -1;
    const bool called = JS_CallFunctionValue(cx, owner, callback, JS::HandleValueArray::empty(), &ignored);
    if (!(called ? scope.Close() : scope.Fail())) return -1;
  }
  return 1;
}
static bool KandeloSocketOwnersHaveReferences(JSContext* cx) {
  for (auto* state = gKandeloSocketOwners; state; state = state->next) {
    if (state->cx != cx) continue;
    if (state->closing) return true;
    if (!state->pending) continue;
    if (state->socket && state->socket->Reading() && state->socket->Referenced()) return true;
    if ((state->write || state->connect) && !state->callbackActive &&
        (!state->connect || state->connectSubmitted)) {
      RootedObject request(cx, *state->pending);
      RootedObject parent(cx, &JS::GetReservedSlot(request, SocketParent).toObject());
      auto* parentState = KandeloSocketOwnerState(cx, parent);
      // A pending write is an actual active native request. uv's active
      // request count keeps the loop alive independently of handle unref.
      if (parentState) return true;
    }
  }
  return false;
}
static int KandeloDispatchSocketOwners(JSContext* cx) {
  // At most one actual completion per socket phase. Never hold raw list-next
  // pointers across JS: before/onread/checkpoint can close or GC other owners.
  for (auto* state = gKandeloSocketOwners; state; state = state->next) {
    if (state->cx != cx || state->callbackActive) continue;
    if (state->closing) {
      const int progress = KandeloDispatchSocketClose(cx, state);
      if (progress) return progress;
      continue;
    }
    if (!state->pending) continue;
    if (state->connect) {
      const int progress = KandeloDispatchSocketConnect(cx, state);
      if (progress) return progress;
      continue;
    }
    if (state->write) {
      const int progress = KandeloDispatchSocketWrite(cx, state);
      if (progress) return progress;
      continue;
    }
    if (!state->socket || !state->socket->Reading()) continue;
    if (!state->socket->CurrentRead()) {
      try {
        state->socket->StartRead();
        if (!state->readClaim) state->readClaim = std::make_unique<kandelo::memory::Claim>(
            state->socket->CurrentRead()->allocation.Handle(), KandeloNativeMemoryOwner(cx));
      } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return -1; }
      state->RefreshMemory();
    }
    state->socket->ProgressRead();
    auto ticket = state->socket->BeginDelivery(); if (!ticket) continue;
    state->delivering = ticket;
    state->callbackActive = true;
    auto leaveCallback = mozilla::MakeScopeExit([&] { state->callbackActive = false; });
    KandeloSocketOwnerUnlink(state);
    auto** tail = &gKandeloSocketOwners; while (*tail) tail = &(*tail)->next;
    *tail = state;
    RootedObject owner(cx, *state->pending);
    JSAutoRealm realm(cx, owner);
    // Own the actual JS callback arguments before admission, as in
    // StreamBase::CallJSOnreadMethod. In-flight material is not queued input.
    RootedObject buffer(cx);
    if (ticket->status > 0) {
      buffer = JS::NewArrayBuffer(cx, size_t(ticket->status));
      if (!buffer) { state->socket->AbortDelivery(ticket); return -1; }
      JS::AutoCheckCannotGC nogc; bool shared;
      uint8_t* data = JS::GetArrayBufferData(buffer, &shared, nogc);
      memcpy(data, ticket->bytes.data(), size_t(ticket->status));
    }
    RootedValue onread(cx, JS::GetReservedSlot(owner, SocketOnRead));
    RootedValue callback(cx, JS::GetReservedSlot(owner, SocketDispatch));
    RootedValue streamState(cx, JS::GetReservedSlot(owner, SocketStreamState));
    RootedObject view(cx, streamState.isObject() ? js::CheckedUnwrapStatic(&streamState.toObject()) : nullptr);
    if (!view || !JS_IsInt32Array(view) || JS_GetTypedArrayLength(view) < SocketStreamStateFields::kNumStreamBaseStateFields) {
      state->socket->AbortDelivery(ticket); JS_ReportErrorASCII(cx, "TCP stream state is detached or invalid"); return -1;
    }
    {
      JS::AutoCheckCannotGC nogc; bool shared;
      int32_t* data = JS_GetInt32ArrayData(view, &shared, nogc);
      if (shared || !data) { state->socket->AbortDelivery(ticket); JS_ReportErrorASCII(cx, "TCP stream state must be owned by this environment"); return -1; }
      data[SocketStreamStateFields::kReadBytesOrError] = ticket->status == 0 ? -4095 : int32_t(ticket->status);
      data[SocketStreamStateFields::kArrayBufferOffset] = 0;
    }
    JS::RootedValueArray<3> arguments(cx);
    arguments[0].setNumber(ticket->status);
    if (buffer) arguments[1].setObject(*buffer); else arguments[1].setUndefined();
    arguments[2].set(onread);
    RootedValue frame(cx, JS::GetReservedSlot(owner, SocketFrame));
    // This is an ownership transaction: the queued slot is relinquished only
    // after bytes/status/callback are rooted. Keep the physical native copy
    // and its claim until callback/after/checkpoint retirement completes.
    if (!state->socket->AdmitDelivery(ticket)) {
      JS_ReportErrorASCII(cx, "TCP read admission lost its actual ticket"); return -1;
    }
    state->inflightReadClaim = std::move(state->readClaim);
    if (ticket->status <= 0) state->socket->StopRead();
    state->RefreshMemory();
    auto retireDelivery = mozilla::MakeScopeExit([&] {
      ticket->phase = kandelo::socket::Read::Phase::Retired;
      state->delivering.reset(); state->inflightReadClaim.reset();
      if (!state->socket->Reading() || state->socket->Fd() < 0) state->pending.reset();
      state->RefreshMemory();
    });
    KandeloNativeCallbackScope scope(cx, owner, frame);
    if (!scope.Enter()) return -1;
    if (scope.Stopped()) return scope.Close() ? 0 : -1;
    RootedValue ignored(cx);
    const bool called = JS_CallFunctionValue(cx, owner, callback, arguments, &ignored);
    const bool completed = called ? scope.Close() : scope.Fail();
    if (!completed) return -1;
    return 1;
  }
  return 0;
}
static void KandeloShutdownSocketOwners(JSContext* cx) {
  auto** link = &gKandeloSocketOwners;
  while (*link) {
    auto* state = *link;
    if (state->cx != cx) { link = &state->next; continue; }
    *link = state->next; state->next = nullptr;
    state->Close(); state->Retire(); state->claims.Clear(); state->RefreshMemory(); state->detached = true; state->cx = nullptr;
  }
}
} // namespace
