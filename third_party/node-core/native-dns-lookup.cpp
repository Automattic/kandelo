/* Actual OS name-service requests for the Node embedding. Included after
 * native-work/native-async and the shared UV table. Workers never touch JS.
 * Source candidate: the engine and public DNS frontend still need validation.
 */
#include "kandelo-node-dns-lookup.h"
#include "kandelo-node-dns-errors.h"
#include "kandelo-node-dns-resolver.h"
#include <atomic>

namespace {
enum DnsRequestSlot { DnsRequestState, DnsRequestFrame, DnsRequestSlots };
enum class DnsRequestKind { Address, Name, Query, Channel };
// Pinned src/cares_wrap.h values; checked against that exact reference.
enum DnsLookupOrder { DnsOrderVerbatim = 0, DnsOrderIPv4First = 1, DnsOrderIPv6First = 2 };
struct KandeloDnsRequestState {
  js::shell::KandeloNativeAsyncState* lifetime = nullptr;
  double id = -1, trigger = -1;
  DnsRequestKind kind;
  bool dispatched = false, retired = false;
  std::shared_ptr<kandelo::dns::Resolver> resolver;
  std::atomic<size_t> activeQueries{0};  // Native producer retires wire activity.
  explicit KandeloDnsRequestState(DnsRequestKind kind) : kind(kind) {}
  void Retire() {
    if (!retired) {
      retired = true;
      if (lifetime && id >= 0) lifetime->Finalized(id);
    }
  }
  ~KandeloDnsRequestState() {
    Retire();
    if (lifetime) lifetime->Release();
  }
};
static void KandeloDnsRequestFinalize(JS::GCContext*, JSObject* object) {
  const Value slot = JS::GetReservedSlot(object, DnsRequestState);
  if (!slot.isUndefined()) {
    JS::RemoveAssociatedMemory(object, sizeof(KandeloDnsRequestState), JS::MemoryUse::Embedding3);
    js_delete(static_cast<KandeloDnsRequestState*>(slot.toPrivate()));
  }
}
static const JSClassOps KandeloDnsRequestClassOps = {
    nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
    KandeloDnsRequestFinalize, nullptr, nullptr, nullptr};
static const JSClass KandeloDnsRequestClass = {
    "KandeloNodeDNSRequest", JSCLASS_HAS_RESERVED_SLOTS(DnsRequestSlots) |
    JSCLASS_FOREGROUND_FINALIZE, &KandeloDnsRequestClassOps};
static KandeloDnsRequestState* KandeloDnsRequestStateOf(JSContext* cx, HandleObject owner) {
  if (JS::GetClass(owner) != &KandeloDnsRequestClass ||
      JS::GetReservedSlot(owner, DnsRequestState).isUndefined()) {
    JS_ReportErrorASCII(cx, "Invalid native DNS request"); return nullptr;
  }
  return static_cast<KandeloDnsRequestState*>(JS::GetReservedSlot(owner, DnsRequestState).toPrivate());
}
static bool KandeloDnsRequestResourceInfo(JSContext* cx, HandleObject owner, MutableHandleValue result) {
  auto* state = KandeloDnsRequestStateOf(cx, owner);
  if (!state) return false;
  JS::RootedValueArray<4> entries(cx);
  const bool active = state->id >= 0 && !state->retired;
  entries[0].setNumber(active ? state->id : -1); entries[1].setNumber(active ? state->trigger : -1);
  entries[2].set(JS::GetReservedSlot(owner, DnsRequestFrame));
  if (active) {
    const char* name = state->kind == DnsRequestKind::Address ? "GETADDRINFOREQWRAP" :
        state->kind == DnsRequestKind::Name ? "GETNAMEINFOREQWRAP" :
        state->kind == DnsRequestKind::Query ? "QUERYWRAP" : "DNSCHANNEL";
    RootedString provider(cx, JS_NewStringCopyZ(cx, name));
    if (!provider) return false;
    entries[3].setString(provider);
  } else {
    entries[3].setUndefined();
  }
  for (size_t i = 0; i < 4; ++i) if (!JS_WrapValue(cx, entries[i])) return false;
  RootedObject array(cx, JS::NewArrayObject(cx, entries));
  if (!array) return false;
  result.setObject(*array); return true;
}
static bool KandeloNativeCreateDnsRequest(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if ((!args.get(0).isObject() && !args.get(0).isNull()) ||
      (!args.get(1).isBoolean() && !args.get(1).isUndefined())) {
    JS_ReportErrorASCII(cx, "DNS request requires a prototype and name-service kind"); return false;
  }
  RootedObject prototype(cx, args[0].toObjectOrNull());
  RootedObject owner(cx, JS_NewObjectWithGivenProto(cx, &KandeloDnsRequestClass, prototype));
  if (!owner) return false;
  const auto kind = args[1].isUndefined() ? DnsRequestKind::Query :
      args[1].toBoolean() ? DnsRequestKind::Name : DnsRequestKind::Address;
  auto* state = js_new<KandeloDnsRequestState>(kind);
  if (!state) { JS_ReportOutOfMemory(cx); return false; }
  JS::SetReservedSlot(owner, DnsRequestState, PrivateValue(state));
  JS::AddAssociatedMemory(owner, sizeof(*state), JS::MemoryUse::Embedding3);
  // Native provider construction occurs on dispatch, after the pinned public
  // frontend has assigned hostname/callback/oncomplete, as in cares_wrap.cc.
  args.rval().setObject(*owner); return true;
}
static bool KandeloInitializeDnsRequest(JSContext* cx, HandleObject owner,
                                        KandeloDnsRequestState* state) {
  RootedValue frame(cx); double trigger;
  if (!cx->kandeloAsyncProperty("frame", &frame) ||
      !cx->getKandeloDefaultTriggerAsyncId(&trigger)) return false;
  auto* lifetime = js::shell::KandeloGetNativeAsyncState(cx);
  if (!lifetime) return false;
  lifetime->Retain(); state->lifetime = lifetime;
  state->id = cx->allocateKandeloAsyncId();
  state->trigger = trigger;
  JS::SetReservedSlot(owner, DnsRequestFrame, frame);
  return cx->notifyKandeloAsyncLifecycle("native:init", owner, frame);
}
class KandeloDnsRequestWork final : public js::shell::KandeloNativeWork {
  JS::PersistentRootedObject owner_;
  DnsRequestKind kind_;
  UniqueChars hostname_;
  int family_ = 0, flags_ = 0, order_ = 0;
  sockaddr_storage address_{};
  socklen_t length_ = 0;
  kandelo::dns::LookupResult addresses_;
  kandelo::dns::NameInfoResult name_;
 public:
  KandeloDnsRequestWork(JSContext* cx, JSObject* owner, UniqueChars&& hostname,
                         int family, int flags, int order)
      : owner_(cx, owner), kind_(DnsRequestKind::Address), hostname_(std::move(hostname)),
        family_(family), flags_(flags), order_(order) { workClass = WorkClass::SlowIo; }
  KandeloDnsRequestWork(JSContext* cx, JSObject* owner,
                         const sockaddr_storage& address, socklen_t length)
      : owner_(cx, owner), kind_(DnsRequestKind::Name), address_(address), length_(length) {
    workClass = WorkClass::SlowIo;
  }
  void Run() override {
    if (kind_ == DnsRequestKind::Address)
      addresses_ = kandelo::dns::Lookup(hostname_.get(), family_, flags_);
    else
      name_ = kandelo::dns::NameInfo(address_, length_, NI_NAMEREQD);
  }
  bool Complete(JSContext* cx) override {
    RootedObject owner(cx, owner_);
    JSAutoRealm realm(cx, owner);
    auto* state = KandeloDnsRequestStateOf(cx, owner);
    if (!state) return false;
    auto retire = mozilla::MakeScopeExit([&] {
      state->Retire();
      JS::SetReservedSlot(owner, DnsRequestFrame, UndefinedValue());
    });
    int status = kind_ == DnsRequestKind::Address ?
        kandelo::dns::ErrorStatus(addresses_.status, addresses_.system_error) :
        kandelo::dns::ErrorStatus(name_.status, name_.system_error);
    if (failure != Failure::None) status = failure == Failure::OutOfMemory ? UV__EAI_MEMORY :
        failure == Failure::Cancelled ? UV__EAI_CANCELED : UV__EIO;
    JS::RootedValueArray<3> arguments(cx);
    arguments[0].setInt32(status); arguments[1].setNull(); arguments[2].setNull();
    if (status == 0 && kind_ == DnsRequestKind::Address) {
      RootedObject results(cx, JS::NewArrayObject(cx, 0));
      if (!results) return false;
      uint32_t index = 0;
      // cares_wrap preserves OS order within each family and never deduplicates.
      // The two ordered modes partition results; verbatim retains the OS order.
      auto append = [&](int family) {
        for (const auto& address : addresses_.addresses) {
          if (family && address.family != family) continue;
          RootedString text(cx, JS_NewStringCopyZ(cx, address.address.c_str()));
          if (!text) return false;
          RootedValue value(cx, StringValue(text));
          if (!JS_SetElement(cx, results, index++, value)) return false;
        }
        return true;
      };
      if (order_ == DnsOrderIPv4First) { if (!append(4) || !append(6)) return false; }
      else if (order_ == DnsOrderIPv6First) { if (!append(6) || !append(4)) return false; }
      else if (!append(0)) return false;
      if (index == 0) arguments[0].setInt32(UV__EAI_NODATA);
      arguments[1].setObject(*results);
    } else if (status == 0) {
      // Target OneByteString semantics, not an implicit UTF-8 reinterpretation.
      RootedString hostname(cx, JS_NewStringCopyZ(cx, name_.hostname.c_str()));
      if (!hostname) return false;
      arguments[1].setString(hostname);
      RootedString service(cx, JS_NewStringCopyZ(cx, name_.service.c_str()));
      if (!service) return false;
      arguments[2].setString(service);
    }
    RootedValue callback(cx), ignored(cx);
    if (!JS_GetProperty(cx, owner, "oncomplete", &callback)) return false;
    RootedValue frame(cx, JS::GetReservedSlot(owner, DnsRequestFrame));
    KandeloNativeCallbackScope scope(cx, owner, frame);
    if (!scope.Enter()) return scope.Stopped();
    bool ok;
    if (kind_ == DnsRequestKind::Address) {
      JS::RootedValueArray<2> addressArguments(cx);
      addressArguments[0].set(arguments[0]); addressArguments[1].set(arguments[1]);
      ok = JS_CallFunctionValue(cx, owner, callback, addressArguments, &ignored);
    } else {
      ok = JS_CallFunctionValue(cx, owner, callback, arguments, &ignored);
    }
    if (!ok) return false;
    return scope.Close();
  }
  void Cancel(JSContext*) override {
    // Queue shutdown has joined native workers; no user callback enters a dying realm.
    auto* state = static_cast<KandeloDnsRequestState*>(JS::GetReservedSlot(owner_, DnsRequestState).toPrivate());
    state->Retire();
    JS::SetReservedSlot(owner_, DnsRequestFrame, UndefinedValue());
    owner_.reset();
  }
};
static bool KandeloSubmitDnsRequest(JSContext* cx, HandleObject owner,
                                    KandeloDnsRequestState* state, KandeloDnsRequestWork* work,
                                    MutableHandleValue result) {
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  auto disposeWork = mozilla::MakeScopeExit([&] { js_delete(work); });
  state->dispatched = true;  // Prevent reentrant init hooks from dispatching twice.
  auto failedHandoff = mozilla::MakeScopeExit([&] {
    state->Retire();
    JS::SetReservedSlot(owner, DnsRequestFrame, UndefinedValue());
  });
  if (!KandeloInitializeDnsRequest(cx, owner, state)) return false;
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx);
  if (!queue) return false;
  if (!queue->Submit(work)) { result.setInt32(UV__ECANCELED); return true; }
  disposeWork.release(); failedHandoff.release(); result.setInt32(0); return true;
}
static bool KandeloNativeDnsLookup(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject() || !args.get(2).isInt32() || !args.get(3).isInt32() || !args.get(4).isInt32()) {
    JS_ReportErrorASCII(cx, "DNS lookup requires request, ASCII hostname, family, flags and order"); return false;
  }
  RootedObject owner(cx, &args[0].toObject());
  auto* state = KandeloDnsRequestStateOf(cx, owner);
  if (!state) return false;
  const int family = args[2].toInt32(), order = args[4].toInt32();
  if (state->kind != DnsRequestKind::Address || state->dispatched || state->retired ||
      (family != 0 && family != 4 && family != 6) || order < DnsOrderVerbatim || order > DnsOrderIPv6First) {
    JS_ReportErrorASCII(cx, "DNS address request is not idle or has invalid options"); return false;
  }
  UniqueChars hostname;
  if (!KandeloGetString(cx, args[1], &hostname)) return false;
  return KandeloSubmitDnsRequest(cx, owner, state,
      js_new<KandeloDnsRequestWork>(cx, owner.get(), std::move(hostname), family, args[3].toInt32(), order), args.rval());
}
static bool KandeloNativeDnsLookupService(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject() || !args.get(2).isInt32() || args[2].toInt32() < 0 || args[2].toInt32() > 65535) {
    JS_ReportErrorASCII(cx, "DNS reverse lookup requires request, IP and port"); return false;
  }
  RootedObject owner(cx, &args[0].toObject());
  auto* state = KandeloDnsRequestStateOf(cx, owner);
  if (!state) return false;
  if (state->kind != DnsRequestKind::Name || state->dispatched || state->retired) {
    JS_ReportErrorASCII(cx, "DNS name request is not idle"); return false;
  }
  UniqueChars ip;
  if (!KandeloGetString(cx, args[1], &ip)) return false;
  sockaddr_storage address{}; socklen_t length;
  if (!kandelo::dns::NameInfoAddress(ip.get(), uint16_t(args[2].toInt32()), &address, &length)) {
    args.rval().setInt32(UV__EINVAL); return true;
  }
  return KandeloSubmitDnsRequest(cx, owner, state,
      js_new<KandeloDnsRequestWork>(cx, owner.get(), address, length), args.rval());
}
static bool KandeloNativeDnsLookupConstants(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedObject constants(cx, JS_NewPlainObject(cx));
  if (!constants || !KandeloDefineSocketInt(cx, constants, "AI_ADDRCONFIG", AI_ADDRCONFIG) ||
      !KandeloDefineSocketInt(cx, constants, "AI_ALL", AI_ALL) ||
      !KandeloDefineSocketInt(cx, constants, "AI_V4MAPPED", AI_V4MAPPED)) return false;
  args.rval().setObject(*constants); return true;
}
}  // namespace
