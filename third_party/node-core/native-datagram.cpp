// The native UDP owner is distinct from TCP's stream/EOF watch. Active receives
// and queued sends root their actual handle/request until completion or close.
#include "kandelo-node-datagram-operations.h"
#include "kandelo-node-datagram-send-spans.h"
#include "js/experimental/KandeloBackingStore.h"
#include <deque>
#include <memory>
#include <vector>
#include <poll.h>
#include <cmath>
#include <sys/stat.h>

namespace js::shell {
struct KandeloUdpState;
struct KandeloUdpRegistry { std::vector<KandeloUdpState*> owners; };
struct KandeloUdpSend {
  JS::PersistentRootedObject request;
  kandelo::udp::SendSpans buffers;
  bool completed = false;
  int status = 0;
  kandelo::udp::Address destination;
  bool addressed, callback;
  size_t associated = 0;
  KandeloUdpSend(JSContext* cx, JSObject* request, kandelo::udp::SendSpans&& buffers,
                 const kandelo::udp::Address& destination, bool addressed, bool callback)
      : request(cx, request), buffers(std::move(buffers)), destination(destination),
        addressed(addressed), callback(callback) {}
  ~KandeloUdpSend() {
    // Request root remains alive through callback/checkpoint or cancellation.
    // UDP shutdown destroys each send before the owning context disappears.
    if (associated) JS::RemoveAssociatedMemory(request, associated, JS::MemoryUse::Embedding3);
  }
  void Charge() {
    MOZ_RELEASE_ASSERT(!associated);
    associated = sizeof(*this);
    JS::AddAssociatedMemory(request, associated, JS::MemoryUse::Embedding3);
  }
  // libuv retries sendmsg ENOBUFS as EAGAIN; retain live spans until a real
  // attempt succeeds/fails, without exposing a copied pending message.
  void Attempt(kandelo::udp::Endpoint& endpoint) {
    MOZ_RELEASE_ASSERT(!completed);
    size_t sent = 0;
    const int error = endpoint.SendSpans(buffers.entries.data(), buffers.entries.size(),
        addressed ? &destination : nullptr, &sent);
    if (error != EAGAIN && error != EWOULDBLOCK && error != ENOBUFS) {
      completed = true; status = error;
    }
  }
};
struct KandeloUdpState {
  KandeloUdpRegistry* registry = nullptr;
  KandeloNativeAsyncState* lifetime = nullptr;
  kandelo::udp::Endpoint endpoint;
  JS::PersistentRootedObject active;
  std::deque<std::unique_ptr<KandeloUdpSend>> sends;
  double id = -1, trigger = -1;
  bool request, referenced = true, receiving = false, closing = false, retired = false;
  explicit KandeloUdpState(JSContext* cx, bool request) : active(cx), request(request) {}
  void Retire() {
    if (!retired) { retired = true; if (lifetime) lifetime->Finalized(id); }
  }
  void UpdateRoot(JSObject* owner) {
    if (receiving || closing || !sends.empty()) active = owner; else active.reset();
  }
  ~KandeloUdpState() {
    Retire();
    if (registry) {
      auto& owners = registry->owners;
      for (auto it = owners.begin(); it != owners.end(); ++it)
        if (*it == this) { owners.erase(it); break; }
    }
    if (lifetime) lifetime->Release();
  }
};
static void KandeloShutdownUdp(ShellContext* sc) {
  auto* registry = sc->kandeloUdp; if (!registry) return;
  for (auto* state : registry->owners) {
    state->endpoint.Close(); state->receiving = false; state->closing = false;
    state->Retire(); state->registry = nullptr;
    for (auto& send : state->sends) {
      const Value slot = JS::GetReservedSlot(send->request, 0);
      if (!slot.isUndefined()) static_cast<KandeloUdpState*>(slot.toPrivate())->Retire();
    }
    state->sends.clear(); state->active.reset();
  }
  sc->kandeloUdp = nullptr; js_delete(registry);
}
}  // namespace js::shell

namespace {
using js::shell::KandeloUdpState;
static void KandeloUdpFinalize(JS::GCContext*, JSObject* object) {
  const Value slot = JS::GetReservedSlot(object, 0); if (slot.isUndefined()) return;
  JS::RemoveAssociatedMemory(object, sizeof(KandeloUdpState), JS::MemoryUse::Embedding3);
  js_delete(static_cast<KandeloUdpState*>(slot.toPrivate()));
}
static const JSClassOps KandeloUdpClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloUdpFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloUdpClass = {"UDP",
  JSCLASS_HAS_RESERVED_SLOTS(3) | JSCLASS_FOREGROUND_FINALIZE, &KandeloUdpClassOps};
static const JSClass KandeloUdpRequestClass = {"UDPSENDWRAP",
  JSCLASS_HAS_RESERVED_SLOTS(2) | JSCLASS_FOREGROUND_FINALIZE, &KandeloUdpClassOps};
static KandeloUdpState* KandeloUdpStateOf(JSContext* cx, HandleObject object) {
  if ((JS::GetClass(object) != &KandeloUdpClass && JS::GetClass(object) != &KandeloUdpRequestClass) ||
      JS::GetReservedSlot(object, 0).isUndefined()) {
    JS_ReportErrorASCII(cx, "UDP operation requires an actual native owner"); return nullptr;
  }
  return static_cast<KandeloUdpState*>(JS::GetReservedSlot(object, 0).toPrivate());
}
static bool KandeloUdpResourceInfo(JSContext* cx, HandleObject owner, MutableHandleValue result) {
  auto* state = KandeloUdpStateOf(cx, owner); if (!state) return false;
  JS::RootedValueArray<4> fields(cx);
  fields[0].setNumber(state->id); fields[1].setNumber(state->trigger);
  fields[2].set(JS::GetReservedSlot(owner, 1));
  RootedString provider(cx, JS_NewStringCopyZ(cx, state->request ? "UDPSENDWRAP" : "UDPWRAP"));
  if (!provider) return false;
  fields[3].setString(provider);
  for (size_t i = 0; i < 4; ++i) if (!JS_WrapValue(cx, fields[i])) return false;
  RootedObject array(cx, JS::NewArrayObject(cx, fields)); if (!array) return false;
  result.setObject(*array); return true;
}
static bool KandeloInitializeUdp(JSContext* cx, HandleObject owner, KandeloUdpState* state,
                                 double triggerOverride = -1) {
  RootedValue frame(cx); double trigger;
  if (!cx->kandeloAsyncProperty("frame", &frame) ||
      !cx->getKandeloDefaultTriggerAsyncId(&trigger)) return false;
  auto* lifetime = js::shell::KandeloGetNativeAsyncState(cx); if (!lifetime) return false;
  lifetime->Retain(); state->lifetime = lifetime;
  state->id = cx->allocateKandeloAsyncId();
  state->trigger = triggerOverride >= 0 ? triggerOverride : trigger;
  JS::SetReservedSlot(owner, 1, frame);
  return cx->notifyKandeloAsyncLifecycle("native:init", owner, frame);
}
static bool KandeloUdpName(JSContext* cx, const kandelo::udp::Address& address, HandleObject object) {
  RootedValue text(cx); std::string ip;
  const int error = address.Text(&ip);
  if (error) { JS_ReportErrorUTF8(cx, "UDP address interface: %s", strerror(error)); return false; }
  if (!KandeloFsPathString(cx, ip.data(), ip.size(), &text) ||
      !JS_DefineProperty(cx, object, "address", text, JSPROP_ENUMERATE)) return false;
  RootedString family(cx, JS_NewStringCopyZ(cx, address.family() == AF_INET ? "IPv4" : "IPv6"));
  if (!family) return false;
  text.setString(family);
  return JS_DefineProperty(cx, object, "family", text, JSPROP_ENUMERATE) &&
      JS_DefineProperty(cx, object, "port", int32_t(address.port()), JSPROP_ENUMERATE);
}
static bool KandeloUdpCall(JSContext* cx, HandleObject resource, const char* name,
                            const JS::HandleValueArray& arguments) {
  JSAutoRealm realm(cx, resource);
  RootedValue callback(cx), bridge(cx), ignored(cx), frame(cx, JS::GetReservedSlot(resource, 1));
  const bool message = strcmp(name, "onmessage") == 0;
  if (message) bridge = JS::GetReservedSlot(resource, 2);
  // Match AsyncWrap's named MakeCallback: lookup (and any throwing getter)
  // precedes hooks; a nonfunction is skipped without entering a scope. Keep
  // both resolved callback and private converter rooted across before hooks.
  if (!JS_GetProperty(cx, resource, name, &callback)) return false;
  if (!callback.isObject() || !JS::IsCallable(&callback.toObject())) return true;
  KandeloNativeCallbackScope scope(cx, resource, frame);
  if (!scope.Enter()) return false;
  if (scope.Stopped()) return scope.Close();
  bool called;
  if (message) {
    MOZ_RELEASE_ASSERT(arguments.length() == 4);
    JS::RootedValueArray<5> forwarded(cx); forwarded[0].set(callback);
    for (size_t i = 0; i < 4; ++i) forwarded[i + 1].set(arguments[i]);
    called = JS_CallFunctionValue(cx, resource, bridge, forwarded, &ignored);
  } else called = JS_CallFunctionValue(cx, resource, callback, arguments, &ignored);
  return called ? scope.Close() : scope.Fail();
}
static bool KandeloUdpHasReferences(JSContext* cx) {
  auto* registry = GetShellContext(cx)->kandeloUdp; if (!registry) return false;
  for (auto* state : registry->owners)
    if (state->closing || !state->sends.empty() || (state->referenced && state->receiving)) return true;
  return false;
}
static int KandeloUdpDispatchImpl(JSContext* cx) {
  auto* registry = GetShellContext(cx)->kandeloUdp; if (!registry) return 0;
  // Each callback may close peers, dispatch new sends or trigger GC. Snapshot
  // rooted objects, never raw next pointers or descriptor numbers across JS.
  JS::RootedObjectVector owners(cx);
  for (auto* state : registry->owners)
    if (state->active && !owners.append(state->active)) return -1;
  int count = 0;
  for (size_t index = 0; index < owners.length(); ++index) {
    RootedObject owner(cx, owners[index]); JSAutoRealm realm(cx, owner);
    auto* state = KandeloUdpStateOf(cx, owner); if (!state) return -1;
    short ready = 0;
    if (!state->closing && state->endpoint.fd() >= 0) {
      pollfd item{state->endpoint.fd(), short((state->receiving ? POLLIN : 0) |
          (!state->sends.empty() ? POLLOUT : 0)), 0};
      int result;
      do { result = poll(&item, 1, 0); } while (result < 0 && errno == EINTR);
      if (result < 0) {
        JS_ReportErrorUTF8(cx, "UDP poll: %s", strerror(errno)); return -1;
      }
      ready = item.revents;
    }
    if (!state->sends.empty() && (state->sends.front()->completed || state->closing ||
        (ready & (POLLOUT | POLLERR | POLLHUP | POLLNVAL)))) {
      auto& queued = state->sends.front();
      if (!queued->completed) {
        if (state->closing) { queued->completed = true; queued->status = ECANCELED; }
        else queued->Attempt(state->endpoint);
      }
      if (queued->completed) {
        const int error = queued->status;
        auto send = std::move(queued); state->sends.pop_front();
        RootedObject request(cx, send->request);
        auto* requestState = KandeloUdpStateOf(cx, request); if (!requestState) return -1;
        auto retire = mozilla::MakeScopeExit([&] { requestState->Retire(); JS::SetReservedSlot(request, 1, UndefinedValue()); });
        if (send->callback) {
          JS::RootedValueArray<2> arguments(cx); arguments[0].setInt32(-error); arguments[1].setNumber(send->buffers.bytes);
          if (!KandeloUdpCall(cx, request, "oncomplete", arguments)) return -1;
        }
        ++count;
      }
    }
    if (GetShellContext(cx)->quitting) return count;
    if (state->receiving && !state->closing && (ready & (POLLIN | POLLERR | POLLHUP | POLLNVAL))) {
      uint8_t bytes[65536]; size_t received = 0; kandelo::udp::Address source;
      int error = state->endpoint.Receive(bytes, sizeof(bytes), &received, &source);
      if (error != EAGAIN && error != EWOULDBLOCK) {
        JS::RootedValueArray<4> arguments(cx);
        arguments[0].setNumber(error ? -error : double(received)); arguments[1].setObject(*owner);
        arguments[2].setUndefined(); arguments[3].setUndefined();
        if (!error) {
          RootedObject buffer(cx, KandeloNewUint8ArrayCopy(cx, bytes, received));
          RootedObject rinfo(cx, JS_NewPlainObject(cx));
          if (!buffer || !rinfo || !KandeloUdpName(cx, source, rinfo)) return -1;
          arguments[2].setObject(*buffer); arguments[3].setObject(*rinfo);
        }
        // A successful zero-byte read is a message, never TCP EOF.
        if (!KandeloUdpCall(cx, owner, "onmessage", arguments)) return -1;
        ++count;
      }
    }
    if (state->closing && state->sends.empty()) { state->Retire(); state->closing = false; }
    state->UpdateRoot(owner);
    if (GetShellContext(cx)->quitting) return count;
  }
  return count;
}
static int KandeloUdpDispatch(JSContext* cx) {
  try { return KandeloUdpDispatchImpl(cx); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return -1; }
}
static bool KandeloNativeUdpImpl(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  UniqueChars operation;
  if (!KandeloGetString(cx, args.get(0), &operation)) return false;
  const char* op = operation.get();
  if (strcmp(op, "constants") == 0) {
    RootedObject object(cx, JS_NewPlainObject(cx));
    if (!object || !JS_DefineProperty(cx, object, "AF_INET", AF_INET, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, object, "AF_INET6", AF_INET6, JSPROP_ENUMERATE)) return false;
    args.rval().setObject(*object); return true;
  }
  if (strcmp(op, "guess") == 0) {
    int32_t fd; if (!JS::ToInt32(cx, args.get(1), &fd)) return false;
    int type = 0; socklen_t length = sizeof(type); const char* name = "UNKNOWN";
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &length) == 0) {
      sockaddr_storage address{}; socklen_t addressLength = sizeof(address);
      if (getsockname(fd, reinterpret_cast<sockaddr*>(&address), &addressLength) == 0) {
        if (type == SOCK_DGRAM && (address.ss_family == AF_INET || address.ss_family == AF_INET6)) name = "UDP";
        else if (type == SOCK_STREAM) name = address.ss_family == AF_UNIX ? "PIPE" : "TCP";
      }
    } else if (isatty(fd)) name = "TTY";
    else {
      struct stat status;
      if (fstat(fd, &status) == 0) {
        if (S_ISREG(status.st_mode)) name = "FILE";
        else if (S_ISFIFO(status.st_mode)) name = "PIPE";
      }
    }
    RootedString text(cx, JS_NewStringCopyZ(cx, name)); if (!text) return false;
    args.rval().setString(text); return true;
  }
  if (strcmp(op, "create") == 0) {
    if (!args.get(1).isObject() || !args.get(2).isBoolean()) { JS_ReportErrorASCII(cx, "UDP requires prototype and request flag"); return false; }
    const bool request = args[2].toBoolean();
    RootedObject proto(cx, &args[1].toObject());
    RootedObject owner(cx, JS_NewObjectWithGivenProto(cx, request ? &KandeloUdpRequestClass : &KandeloUdpClass, proto));
    if (!owner) return false;
    auto* state = js_new<KandeloUdpState>(cx, request); if (!state) { JS_ReportOutOfMemory(cx); return false; }
    JS::SetReservedSlot(owner, 0, PrivateValue(state));
    JS::AddAssociatedMemory(owner, sizeof(*state), JS::MemoryUse::Embedding3);
    if (!request) {
      auto* sc = GetShellContext(cx);
      if (!sc->kandeloUdp) sc->kandeloUdp = js_new<js::shell::KandeloUdpRegistry>();
      if (!sc->kandeloUdp) { JS_ReportOutOfMemory(cx); return false; }
      state->registry = sc->kandeloUdp; state->registry->owners.push_back(state);
      if (!KandeloInitializeUdp(cx, owner, state)) return false;
    }
    args.rval().setObject(*owner); return true;
  }
  if (!args.get(1).isObject()) { JS_ReportErrorASCII(cx, "UDP requires handle"); return false; }
  RootedObject owner(cx, &args[1].toObject());
  auto* state = KandeloUdpStateOf(cx, owner); if (!state) return false;
  if (strcmp(op, "info") == 0) return KandeloUdpResourceInfo(cx, owner, args.rval());
  if (state->request) { JS_ReportErrorASCII(cx, "UDP send request is not a handle"); return false; }
  int error = 0;
  if (strcmp(op, "close") == 0) {
    if (!state->retired) { state->endpoint.Close(); state->receiving = false; state->closing = true;
      JS::SetReservedSlot(owner, 2, UndefinedValue()); state->UpdateRoot(owner); }
  } else if (strcmp(op, "ref") == 0) state->referenced = JS::ToBoolean(args.get(2));
  else if (strcmp(op, "hasRef") == 0) { args.rval().setBoolean(state->referenced); return true; }
  else if (strcmp(op, "fd") == 0) { args.rval().setInt32(state->endpoint.fd()); return true; }
  else if (strcmp(op, "queueSize") == 0 || strcmp(op, "queueCount") == 0) {
    size_t size = 0; for (auto& send : state->sends) size += send->buffers.bytes;
    args.rval().setNumber(strcmp(op, "queueSize") == 0 ? size : state->sends.size()); return true;
  } else if (strcmp(op, "recvStart") == 0) {
    error = state->endpoint.fd() < 0 ? EBADF : 0;
    if (!args.get(2).isObject() || !JS::IsCallable(&args[2].toObject())) {
      JS_ReportErrorASCII(cx, "UDP receive requires message dispatch callback"); return false;
    }
    if (!error) { JS::SetReservedSlot(owner, 2, args[2]); state->receiving = true; state->UpdateRoot(owner); }
  } else if (strcmp(op, "recvStop") == 0) {
    state->receiving = false; JS::SetReservedSlot(owner, 2, UndefinedValue()); state->UpdateRoot(owner);
  }
  else if (strcmp(op, "disconnect") == 0) error = state->endpoint.Disconnect();
  else if (strcmp(op, "open") == 0) {
    int32_t fd; if (!JS::ToInt32(cx, args.get(2), &fd)) return false;
    if (state->endpoint.fd() >= 0) error = EBUSY;
    else {
      auto* registry = GetShellContext(cx)->kandeloUdp;
      if (registry) for (auto* other : registry->owners)
        if (other != state && other->endpoint.fd() == fd && fd >= 0) { error = EEXIST; break; }
      if (!error) error = state->endpoint.Adopt(fd);
    }
  } else if (strcmp(op, "bind") == 0 || strcmp(op, "connect") == 0) {
    UniqueChars text; int32_t family, port, flags;
    if (!KandeloGetString(cx, args.get(2), &text) || !JS::ToInt32(cx, args.get(3), &port) ||
        !JS::ToInt32(cx, args.get(4), &family) || !JS::ToInt32(cx, args.get(5), &flags)) return false;
    kandelo::udp::Address address; error = kandelo::udp::Address::Parse(family, text.get(), unsigned(port), &address);
    if (!error) error = strcmp(op, "bind") == 0 ? state->endpoint.Bind(address, unsigned(flags)) : state->endpoint.Connect(address);
  } else if (strcmp(op, "name") == 0) {
    if (!args.get(3).isObject()) { JS_ReportErrorASCII(cx, "UDP name requires output object"); return false; }
    kandelo::udp::Address address; error = state->endpoint.Name(&address, JS::ToBoolean(args.get(2)));
    RootedObject output(cx, &args[3].toObject()); if (!error && !KandeloUdpName(cx, address, output)) return false;
  } else if (strcmp(op, "send") == 0) {
    if (!args.get(2).isObject() || !args.get(3).isObject()) { JS_ReportErrorASCII(cx, "UDP send requires request/list"); return false; }
    RootedObject request(cx, &args[2].toObject()); auto* requestState = KandeloUdpStateOf(cx, request);
    if (!requestState) return false;
    if (!requestState->request || requestState->id >= 0) { JS_ReportErrorASCII(cx, "UDP send request already used"); return false; }
    RootedObject list(cx, &args[3].toObject());
    // The pinned caller already captured count before entering the binding.
    // Reading list.length again can invoke a getter or change the native loop.
    if (!args.get(8).isNumber()) { JS_ReportErrorASCII(cx, "UDP send requires a captured count"); return false; }
    const double countValue = args[8].toNumber();
    if (!std::isfinite(countValue) || countValue < 0 || countValue > UINT32_MAX || std::floor(countValue) != countValue) {
      JS_ReportErrorASCII(cx, "UDP send count is not uint32"); return false;
    }
    const uint32_t count = uint32_t(countValue);
    kandelo::udp::SendSpans buffers(count, JS::KandeloBacking::ResolveAccount(cx), JS::KandeloBacking::TrackMetadata);
    for (uint32_t i = 0; i < count; ++i) {
      RootedValue item(cx); if (!JS_GetElement(cx, list, i, &item)) return false;
      if (!item.isObject()) { JS_ReportErrorASCII(cx, "UDP send requires actual byte spans"); return false; }
      RootedObject input(cx, &item.toObject());
      // Public dgram's pinned validation still admits views only. Preserve the
      // existing private BufferSource route for real bare AB/SAB as well.
      auto span = JS_IsArrayBufferViewObject(input) ? JS::KandeloBacking::Acquire(cx, input) :
          JS::KandeloBacking::AcquireBuffer(cx, input);
      if (!span) return false;
      buffers.Capture(i, std::move(span));
    }
    const bool addressed = !args.get(4).isNull(); kandelo::udp::Address destination;
    if (addressed) {
      UniqueChars text; int32_t port, family;
      if (!KandeloGetString(cx, args.get(4), &text) || !JS::ToInt32(cx, args.get(5), &port) ||
          !JS::ToInt32(cx, args.get(6), &family)) return false;
      error = kandelo::udp::Address::Parse(family, text.get(), unsigned(port), &destination);
    }
    size_t sent = 0;
    if (!error && state->sends.empty()) error = state->endpoint.SendSpans(buffers.entries.data(), buffers.entries.size(), addressed ? &destination : nullptr, &sent);
    else if (!error) error = EAGAIN;
    if (!error) { args.rval().setNumber(sent + 1); return true; }
    if (error == EAGAIN || error == EWOULDBLOCK || error == ENOBUFS) {
      // Pinned UDPWrap::Send sets the environment default around request init,
      // including nested allocations in the actual UDPSENDWRAP init hook.
      kandelo::async::DefaultTriggerScope triggerScope(cx->kandeloDefaultTrigger(), state->id);
      if (!triggerScope.Ready()) { JS_ReportErrorASCII(cx, "UDP default trigger ID is invalid"); return false; }
      auto queued = std::make_unique<js::shell::KandeloUdpSend>(cx, request, std::move(buffers), destination, addressed, JS::ToBoolean(args.get(7)));
      queued->Charge();
      auto retire = mozilla::MakeScopeExit([&] { requestState->Retire(); });
      // SendWrap init precedes uv_udp_send dispatch and queue publication.
      // Reentrant sends see only already dispatched requests, and can send
      // before this outer request. Original allocation spans stay live here.
      if (!KandeloInitializeUdp(cx, request, requestState, state->id)) return false;
      if (GetShellContext(cx)->quitting) return false;
      if (state->closing || state->endpoint.closed()) {
        args.rval().setInt32(-EBADF); return true;
      }
      const bool emptyQueue = state->sends.empty();
      auto* token = queued.get(); state->sends.push_back(std::move(queued));
      state->UpdateRoot(owner); retire.release();
      // libuv attempts a newly dispatched send immediately when no earlier
      // request (including completed-but-undelivered requests) owns the queue.
      // Physical send success/error is retained for deferred completion; close
      // must not cancel a datagram already submitted to the real socket.
      if (emptyQueue) token->Attempt(state->endpoint);
      error = 0;
    }
  } else if (strcmp(op, "bufferSize") == 0) {
    uint32_t size; if (!JS::ToUint32(cx, args.get(2), &size)) return false;
    int result = 0; error = state->endpoint.BufferSize(JS::ToBoolean(args.get(3)), size, &result);
    JS::RootedValueArray<2> fields(cx); fields[0].setInt32(-error); fields[1].setInt32(result);
    RootedObject packet(cx, JS::NewArrayObject(cx, fields)); if (!packet) return false;
    args.rval().setObject(*packet); return true;
  } else if (strcmp(op, "membership") == 0 || strcmp(op, "multicastInterface") == 0) {
    UniqueChars group, interface, source;
    if (!KandeloGetString(cx, args.get(2), &group)) return false;
    if (strcmp(op, "multicastInterface") == 0) error = state->endpoint.MulticastInterface(group.get());
    else {
      if (!args.get(3).isUndefined() && !KandeloGetString(cx, args.get(3), &interface)) return false;
      if (!args.get(4).isUndefined() && !KandeloGetString(cx, args.get(4), &source)) return false;
      error = state->endpoint.Membership(group.get(), interface.get(), source.get(), JS::ToBoolean(args.get(5)));
    }
  } else if (strcmp(op, "option") == 0) {
    UniqueChars name; double number;
    if (!KandeloGetString(cx, args.get(2), &name) || !JS::ToNumber(cx, args.get(3), &number)) return false;
    if (!std::isfinite(number) || number < INT32_MIN || number > INT32_MAX) error = EINVAL;
    else {
      const bool v6 = state->endpoint.family() == AF_INET6; int value = int(number);
      if (strcmp(name.get(), "broadcast") == 0) error = state->endpoint.IntegerOption(SOL_SOCKET, SO_BROADCAST, value);
      else if (strcmp(name.get(), "ttl") == 0) error = value < 1 || value > 255 ? EINVAL :
          state->endpoint.IntegerOption(v6 ? IPPROTO_IPV6 : IPPROTO_IP, v6 ? IPV6_UNICAST_HOPS : IP_TTL, value);
      else if (strcmp(name.get(), "multicastTTL") == 0) error = value < 0 || value > 255 ? EINVAL :
          state->endpoint.IntegerOption(v6 ? IPPROTO_IPV6 : IPPROTO_IP, v6 ? IPV6_MULTICAST_HOPS : IP_MULTICAST_TTL, value);
      else if (strcmp(name.get(), "multicastLoopback") == 0) error = state->endpoint.IntegerOption(
          v6 ? IPPROTO_IPV6 : IPPROTO_IP, v6 ? IPV6_MULTICAST_LOOP : IP_MULTICAST_LOOP, value);
      else { JS_ReportErrorASCII(cx, "Unknown UDP option"); return false; }
    }
  } else { JS_ReportErrorASCII(cx, "Unknown UDP operation"); return false; }
  args.rval().setInt32(-error); return true;
}
static bool KandeloNativeUdp(JSContext* cx, unsigned argc, Value* vp) {
  try { return KandeloNativeUdpImpl(cx, argc, vp); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  catch (const std::exception& error) { JS_ReportErrorUTF8(cx, "UDP native owner: %s", error.what()); return false; }
}
}  // namespace
