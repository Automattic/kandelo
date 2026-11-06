// Focused native-host adapter fixture only. The SAME portable guest manager
// backs the source adapter; this never delegates to host worker_threads.locks.
// Production uses native-locks.cpp/SpiderMonkey rather than Node-API.
#include "lock-manager.h"
#include <node_api.h>
#include <optional>
#include <stdexcept>
#include <string>
namespace {
kandelo::locks::Manager manager;
struct Context {
  uint64_t id;
  std::optional<kandelo::locks::Event> prepared;
  int failPacketAt = -1;
};
void PacketCheckpoint(Context& context, int step) {
  if (context.failPacketAt == step) { context.failPacketAt = -1; throw std::runtime_error("Injected packet allocation failure"); }
}
void Check(napi_status status) { if (status != napi_ok) throw std::runtime_error("Node-API fixture operation failed"); }
napi_value String(napi_env env, const char* value) { napi_value out; Check(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &out)); return out; }
napi_value Number(napi_env env, uint64_t value) { napi_value out; Check(napi_create_double(env, double(value), &out)); return out; }
std::string Text(napi_env env, napi_value value) {
  size_t size; Check(napi_get_value_string_utf8(env, value, nullptr, 0, &size));
  std::string text(size + 1, '\0'); Check(napi_get_value_string_utf8(env, value, text.data(), text.size(), &size)); text.resize(size); return text;
}
std::u16string Name(napi_env env, napi_value value) {
  size_t size; Check(napi_get_value_string_utf16(env, value, nullptr, 0, &size));
  std::u16string text(size + 1, 0); Check(napi_get_value_string_utf16(env, value, text.data(), text.size(), &size)); text.resize(size); return text;
}
bool Boolean(napi_env env, napi_value value) { bool result; Check(napi_get_value_bool(env, value, &result)); return result; }
void Set(napi_env env, napi_value object, const char* name, napi_value value) { Check(napi_set_named_property(env, object, name, value)); }
napi_value Info(napi_env env, const kandelo::locks::Info& info) {
  napi_value result, name; Check(napi_create_object(env, &result));
  Check(napi_create_string_utf16(env, info.name.data(), info.name.size(), &name));
  Set(env, result, "name", name);
  Set(env, result, "mode", String(env, info.mode == kandelo::locks::Mode::Shared ? "shared" : "exclusive"));
  Set(env, result, "clientId", String(env, info.clientId.c_str())); return result;
}
napi_value Array(napi_env env, const std::vector<kandelo::locks::Info>& values) {
  napi_value result; Check(napi_create_array_with_length(env, values.size(), &result));
  for (size_t i = 0; i < values.size(); ++i) Check(napi_set_element(env, result, i, Info(env, values[i])));
  return result;
}
void Cleanup(void* pointer) {
  auto* context = static_cast<Context*>(pointer); manager.Retire(context->id); delete context;
}
napi_value Dispatch(napi_env env, napi_callback_info callback) {
  try {
    napi_value args[6], result; size_t count = 6; void* pointer;
    Check(napi_get_cb_info(env, callback, &count, args, nullptr, &pointer));
    auto& context = *static_cast<Context*>(pointer);
    const auto id = context.id;
    const auto operation = Text(env, args[0]);
    if (operation == "request") return Number(env, manager.Request(id, Name(env, args[1]), Text(env, args[2]),
        Text(env, args[3]) == "shared" ? kandelo::locks::Mode::Shared : kandelo::locks::Mode::Exclusive,
        Boolean(env, args[4]), Boolean(env, args[5])));
    if (operation == "complete") {
      double request; Check(napi_get_value_double(env, args[1], &request));
      const auto status = manager.Complete(id, uint64_t(request));
      return Number(env, status == kandelo::locks::Completion::Stolen ? 2 : status == kandelo::locks::Completion::Completed ? 1 : 0);
    }
    if (operation == "next") {
      context.prepared.reset();
      auto event = manager.Preview(id);
      int step = 0; PacketCheckpoint(context, step++);
      if (event.kind == kandelo::locks::Event::Kind::Empty) { Check(napi_get_undefined(env, &result)); return result; }
      Check(napi_create_object(env, &result)); PacketCheckpoint(context, step++);
      Set(env, result, "id", Number(env, event.info.id)); PacketCheckpoint(context, step++);
      Set(env, result, "info", Info(env, event.info)); PacketCheckpoint(context, step++);
      Set(env, result, "kind", String(env, event.kind == kandelo::locks::Event::Kind::Grant ? "grant" : event.kind == kandelo::locks::Event::Kind::Miss ? "miss" : "stolen")); PacketCheckpoint(context, step++);
      napi_value stolen; Check(napi_create_array_with_length(env, event.localStolen.size(), &stolen)); PacketCheckpoint(context, step++);
      for (size_t i = 0; i < event.localStolen.size(); ++i)
        { Check(napi_set_element(env, stolen, i, Number(env, event.localStolen[i]))); PacketCheckpoint(context, step++); }
      Set(env, result, "localStolen", stolen); PacketCheckpoint(context, step++);
      context.prepared.emplace(std::move(event)); return result;
    }
    if (operation == "commit") {
      double request; Check(napi_get_value_double(env, args[1], &request));
      const bool committed = context.prepared && request == double(context.prepared->info.id) && manager.Commit(*context.prepared);
      context.prepared.reset(); Check(napi_get_boolean(env, committed, &result)); return result;
    }
    if (operation == "discard") {
      context.prepared.reset(); Check(napi_get_undefined(env, &result)); return result;
    }
    if (operation == "failPacket") {
      Check(napi_get_value_int32(env, args[1], &context.failPacketAt)); Check(napi_get_undefined(env, &result)); return result;
    }
    if (operation == "query") {
      const auto snapshot = manager.Query(id); Check(napi_create_object(env, &result));
      Set(env, result, "held", Array(env, snapshot.held)); Set(env, result, "pending", Array(env, snapshot.pending)); return result;
    }
    throw std::runtime_error("Unknown native locks fixture operation");
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value Init(napi_env env, napi_value exports) {
  auto* context = new Context{manager.Register(), {}, -1};
  napi_value callback;
  Check(napi_add_env_cleanup_hook(env, Cleanup, context));
  Check(napi_create_function(env, "locks", NAPI_AUTO_LENGTH, Dispatch, context, &callback));
  Set(env, exports, "locks", callback); return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
