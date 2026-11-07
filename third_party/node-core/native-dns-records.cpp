/* c-ares channels and query completions for the guest Node embedding.
 * Event threads publish owned native packets; only the owning JS loop enters
 * realms, creates values, runs callbacks and releases persistent roots.
 */
#include "kandelo-node-dns-constants.h"

namespace {
static bool KandeloDnsRecordValue(JSContext* cx, const kandelo::dns::RecordValue& input,
                                  MutableHandleValue result) {
  using Kind = kandelo::dns::RecordValue::Kind;
  switch (input.kind) {
    case Kind::Hole:
    case Kind::Undefined:
      result.setUndefined(); return true;
    case Kind::Number:
      result.setNumber(static_cast<double>(input.number)); return true;
    case Kind::String: {
      RootedString text(cx, JS_NewStringCopyN(cx, input.bytes.data(), input.bytes.size()));
      if (!text) return false;
      result.setString(text); return true;
    }
    case Kind::ArrayBuffer: {
      RootedObject buffer(cx, JS::NewArrayBuffer(cx, input.bytes.size()));
      if (!buffer) return false;
      {
        JS::AutoCheckCannotGC noGC;
        bool shared;
        auto* data = JS::GetArrayBufferData(buffer, &shared, noGC);
        if (!input.bytes.empty()) memcpy(data, input.bytes.data(), input.bytes.size());
      }
      result.setObject(*buffer); return true;
    }
    case Kind::Array: {
      RootedObject array(cx, JS::NewArrayObject(cx, input.elements.size()));
      if (!array) return false;
      for (size_t i = 0; i < input.elements.size(); ++i) {
        if (input.elements[i].kind == Kind::Hole) continue;
        RootedValue value(cx);
        if (!KandeloDnsRecordValue(cx, input.elements[i], &value) ||
            !JS_SetElement(cx, array, i, value)) return false;
      }
      result.setObject(*array); return true;
    }
    case Kind::Object: {
      RootedObject object(cx, JS_NewPlainObject(cx));
      if (!object) return false;
      for (const auto& field : input.fields) {
        RootedValue value(cx);
        if (!KandeloDnsRecordValue(cx, field.second, &value) ||
            !JS_DefineProperty(cx, object, field.first.c_str(), value, JSPROP_ENUMERATE)) return false;
      }
      for (const auto& assignment : input.assignments) {
        RootedValue value(cx);
        RootedString key(cx, JS_NewStringCopyN(cx, assignment.first.data(), assignment.first.size()));
        RootedId id(cx);
        // CAA's dynamic tag uses ordinary [[Set]], including prototype
        // setters and their exceptions. It is not a fixed dictionary field.
        if (!key || !JS_StringToId(cx, key, &id) ||
            !KandeloDnsRecordValue(cx, assignment.second, &value) ||
            !JS_SetPropertyById(cx, object, id, value)) return false;
      }
      result.setObject(*object); return true;
    }
  }
  MOZ_CRASH("Invalid owned DNS record kind");
}

static KandeloDnsRequestState* KandeloDnsChannelState(JSContext* cx, HandleObject owner) {
  auto* state = KandeloDnsRequestStateOf(cx, owner);
  if (!state) return nullptr;
  if (state->kind != DnsRequestKind::Channel || !state->resolver || state->retired) {
    JS_ReportErrorASCII(cx, "Invalid native DNS channel"); return nullptr;
  }
  return state;
}

static bool KandeloNativeCreateDnsChannel(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if ((!args.get(0).isObject() && !args.get(0).isNull()) ||
      !args.get(1).isInt32() || !args.get(2).isInt32() || !args.get(3).isNumber()) {
    JS_ReportErrorASCII(cx, "DNS channel requires prototype, timeout, tries and maximum timeout"); return false;
  }
  RootedObject prototype(cx, args[0].toObjectOrNull());
  RootedObject owner(cx, JS_NewObjectWithGivenProto(cx, &KandeloDnsRequestClass, prototype));
  if (!owner) return false;
  auto* state = js_new<KandeloDnsRequestState>(DnsRequestKind::Channel);
  if (!state) { JS_ReportOutOfMemory(cx); return false; }
  JS::SetReservedSlot(owner, DnsRequestState, PrivateValue(state));
  JS::AddAssociatedMemory(owner, sizeof(*state), JS::MemoryUse::Embedding3);
  try {
    state->resolver = std::make_shared<kandelo::dns::Resolver>(args[1].toInt32(),
        args[2].toInt32(), static_cast<unsigned>(args[3].toNumber()));
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  const int status = state->resolver->Status();
  if (status != ARES_SUCCESS) {
    JS_ReportErrorASCII(cx, "%s", kandelo::dns::ToErrorCodeString(status)); return false;
  }
  if (!KandeloInitializeDnsRequest(cx, owner, state)) return false;
  state->dispatched = true;
  args.rval().setObject(*owner); return true;
}

class KandeloDnsRecordWork final : public js::shell::KandeloNativeWork {
  JS::PersistentRootedObject owner_;
  JS::PersistentRootedObject channel_;
  std::shared_ptr<kandelo::dns::Resolver> resolver_;
  KandeloDnsRequestState* channelState_;
  kandelo::dns::QueryResult packet_;
  int type_;

 public:
  KandeloDnsRecordWork(JSContext* cx, JSObject* owner, JSObject* channel,
                       KandeloDnsRequestState* state, int type)
      : owner_(cx, owner), channel_(cx, channel), resolver_(state->resolver), channelState_(state), type_(type) {}
  void Run() override { MOZ_CRASH("DNS event work must not enter the pool"); }
  static void Publish(void* data, const kandelo::dns::QueryResult& result) {
    auto* work = static_cast<KandeloDnsRecordWork*>(data);
    work->packet_ = result;
    // Node retires wire activity when queuing the callback, allowing server
    // replacement inside that callback. The rooted request remains active
    // through MakeCallback/microtasks until its JS completion is unwound.
    MOZ_RELEASE_ASSERT(work->channelState_->activeQueries.fetch_sub(1) > 0);
    work->queue->FinishExternal(work);
  }
  void Interrupt() override { resolver_->Cancel(); }
  void Retire() {
    auto* state = static_cast<KandeloDnsRequestState*>(JS::GetReservedSlot(owner_, DnsRequestState).toPrivate());
    state->Retire();
    JS::SetReservedSlot(owner_, DnsRequestFrame, UndefinedValue());
  }
  bool Complete(JSContext* cx) override {
    RootedObject owner(cx, owner_);
    JSAutoRealm realm(cx, owner);
    auto retire = mozilla::MakeScopeExit([&] { Retire(); });
    kandelo::dns::DecodedRecords decoded;
    try { decoded = packet_.Decode(type_); }
    catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
    JS::RootedValueArray<3> arguments(cx);
    unsigned count = 1;
    if (decoded.status != ARES_SUCCESS) {
      RootedString code(cx, JS_NewStringCopyZ(cx, kandelo::dns::ToErrorCodeString(decoded.status)));
      if (!code) return false;
      arguments[0].setString(code);
    } else {
      arguments[0].setInt32(0);
      if (!KandeloDnsRecordValue(cx, decoded.value, arguments[1])) return false;
      count = 2;
      if (decoded.has_ttls) {
        RootedObject ttls(cx, JS::NewArrayObject(cx, decoded.ttls.size()));
        if (!ttls) return false;
        for (size_t i = 0; i < decoded.ttls.size(); ++i) {
          RootedValue ttl(cx, NumberValue(decoded.ttls[i]));
          if (!JS_SetElement(cx, ttls, i, ttl)) return false;
        }
        arguments[2].setObject(*ttls); count = 3;
      }
    }
    RootedValue callback(cx), ignored(cx);
    if (!JS_GetProperty(cx, owner, "oncomplete", &callback)) return false;
    RootedValue frame(cx, JS::GetReservedSlot(owner, DnsRequestFrame));
    KandeloNativeCallbackScope scope(cx, owner, frame);
    if (!scope.Enter()) return scope.Stopped();
    if (!JS_CallFunctionValue(cx, owner, callback,
            JS::HandleValueArray::subarray(arguments, 0, count), &ignored)) return scope.Fail();
    return scope.Close();
  }
  void Cancel(JSContext*) override {
    Retire();  // Teardown never runs user JS or releases roots on a producer.
    owner_.reset(); channel_.reset(); resolver_.reset();
  }
};

static bool KandeloNativeDnsQuery(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject() || !args.get(1).isObject() || !args.get(3).isInt32()) {
    JS_ReportErrorASCII(cx, "DNS query requires channel, request, ASCII name and record type"); return false;
  }
  RootedObject channel(cx, &args[0].toObject()), owner(cx, &args[1].toObject());
  auto* state = KandeloDnsRequestStateOf(cx, owner);
  auto* channelState = KandeloDnsChannelState(cx, channel);
  if (!state || !channelState) return false;
  if (state->kind != DnsRequestKind::Query || state->dispatched || state->retired) {
    JS_ReportErrorASCII(cx, "DNS query request is not idle"); return false;
  }
  UniqueChars name;
  if (!KandeloGetString(cx, args[2], &name)) return false;
  const int type = args[3].toInt32();
  in6_addr reverseAddress{};
  int reverseFamily = AF_INET, reverseLength = sizeof(in_addr);
  auto* work = js_new<KandeloDnsRecordWork>(cx, owner.get(), channel.get(), channelState, type);
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  auto dispose = mozilla::MakeScopeExit([&] { js_delete(work); });
  state->dispatched = true;
  auto failed = mozilla::MakeScopeExit([&] {
    state->Retire(); JS::SetReservedSlot(owner, DnsRequestFrame, UndefinedValue());
  });
  if (!KandeloInitializeDnsRequest(cx, owner, state)) return false;
  if (type == 0 && kandelo::dns::ParseAddress(AF_INET, name.get(), &reverseAddress) != 1) {
    reverseFamily = AF_INET6; reverseLength = sizeof(in6_addr);
    if (kandelo::dns::ParseAddress(AF_INET6, name.get(), &reverseAddress) != 1) {
      args.rval().setInt32(UV__EINVAL); return true;
    }
  }
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx);
  if (!queue || !queue->BeginExternal(work)) return false;
  ++channelState->activeQueries;
  dispose.release(); failed.release();
  try {
    if (type == 0) channelState->resolver->Reverse(&reverseAddress, reverseLength, reverseFamily,
        KandeloDnsRecordWork::Publish, work);
    else channelState->resolver->Submit(name.get(), static_cast<ares_dns_rec_type_t>(type),
        KandeloDnsRecordWork::Publish, work);
  } catch (const std::bad_alloc&) {
    kandelo::dns::QueryResult error; error.status = ARES_ENOMEM;
    KandeloDnsRecordWork::Publish(work, error);
  }
  args.rval().setInt32(0); return true;
}

static bool KandeloNativeDnsGetServers(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) { JS_ReportErrorASCII(cx, "DNS channel required"); return false; }
  RootedObject owner(cx, &args[0].toObject());
  auto* state = KandeloDnsChannelState(cx, owner);
  if (!state) return false;
  std::vector<std::pair<std::string, int>> servers;
  try {
    int status = state->resolver->GetServers(&servers);
    if (status != ARES_SUCCESS) { JS_ReportErrorASCII(cx, "%s", kandelo::dns::ToErrorCodeString(status)); return false; }
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  RootedObject output(cx, JS::NewArrayObject(cx, servers.size()));
  if (!output) return false;
  for (size_t i = 0; i < servers.size(); ++i) {
    RootedString ip(cx, JS_NewStringCopyZ(cx, servers[i].first.c_str()));
    if (!ip) return false;
    JS::RootedValueArray<2> fields(cx);
    fields[0].setString(ip); fields[1].setInt32(servers[i].second);
    RootedObject pair(cx, JS::NewArrayObject(cx, fields));
    if (!pair) return false;
    RootedValue value(cx, ObjectValue(*pair));
    if (!JS_SetElement(cx, output, i, value)) return false;
  }
  args.rval().setObject(*output); return true;
}

static bool KandeloNativeDnsSetServers(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject() || !args.get(1).isObject()) {
    JS_ReportErrorASCII(cx, "DNS channel and server list required"); return false;
  }
  RootedObject owner(cx, &args[0].toObject()), input(cx, &args[1].toObject());
  auto* state = KandeloDnsChannelState(cx, owner);
  if (!state) return false;
  if (state->activeQueries) { args.rval().setInt32(kandelo::dns::DNS_ESETSRVPENDING); return true; }
  uint32_t count;
  if (!JS::GetArrayLength(cx, input, &count)) return false;
  try {
    std::vector<ares_addr_port_node> servers(count);
    for (uint32_t i = 0; i < count; ++i) {
      RootedValue tuple(cx), family(cx), ip(cx), port(cx);
      if (!JS_GetElement(cx, input, i, &tuple) || !tuple.isObject()) return false;
      RootedObject item(cx, &tuple.toObject());
      if (!JS_GetElement(cx, item, 0, &family) || !JS_GetElement(cx, item, 1, &ip) ||
          !JS_GetElement(cx, item, 2, &port)) return false;
      if (!family.isInt32() || !port.isInt32()) { JS_ReportErrorASCII(cx, "Invalid native DNS server tuple"); return false; }
      UniqueChars address;
      if (!KandeloGetString(cx, ip, &address)) return false;
      auto& server = servers[i];
      server.family = family.toInt32() == 4 ? AF_INET : AF_INET6;
      server.udp_port = server.tcp_port = port.toInt32();
      if (kandelo::dns::ParseAddress(server.family, address.get(), &server.addr) != 1) {
        args.rval().setInt32(ARES_EBADSTR); return true;
      }
      server.next = i + 1 < count ? &servers[i + 1] : nullptr;
    }
    args.rval().setInt32(state->resolver->SetServers(servers)); return true;
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}

static bool KandeloNativeDnsCancel(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) { JS_ReportErrorASCII(cx, "DNS channel required"); return false; }
  RootedObject owner(cx, &args[0].toObject());
  auto* state = KandeloDnsChannelState(cx, owner);
  if (!state) return false;
  state->resolver->Cancel(); args.rval().setUndefined(); return true;
}

static bool KandeloNativeDnsSetLocalIP(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject() || !args.get(1).isInt32()) {
    JS_ReportErrorASCII(cx, "DNS channel, family and local address required"); return false;
  }
  RootedObject owner(cx, &args[0].toObject());
  auto* state = KandeloDnsChannelState(cx, owner);
  UniqueChars address;
  if (!state || !KandeloGetString(cx, args[2], &address)) return false;
  args.rval().setInt32(state->resolver->SetLocalIP(args[1].toInt32(), address.get())); return true;
}

static bool KandeloNativeDnsStrError(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isInt32()) { JS_ReportErrorASCII(cx, "DNS status required"); return false; }
  const int code = args[0].toInt32();
  RootedString text(cx, JS_NewStringCopyZ(cx, code == kandelo::dns::DNS_ESETSRVPENDING ?
      "There are pending queries." : ares_strerror(code)));
  if (!text) return false;
  args.rval().setString(text); return true;
}

static bool KandeloNativeDnsVersion(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedString text(cx, JS_NewStringCopyZ(cx, ares_version(nullptr)));
  if (!text) return false;
  args.rval().setString(text); return true;
}
}  // namespace
