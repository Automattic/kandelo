/* Process/thread-shared guest Web Locks metadata. There are deliberately no JS
 * roots in the shared manager: receiver-local callbacks live in its adapter.
 * Included by the generated native embedding, not a separate translation unit.
 */
#include "kandelo-node-lock-manager.h"
#include "kandelo-node-provider-rotation.h"
#include <cmath>
#include <map>
#include <optional>
namespace {
static kandelo::locks::Manager& KandeloLockManager() {
  static kandelo::locks::Manager manager;
  return manager;
}
struct KandeloLockContext {
  kandelo::locks::Identity identity;
  std::optional<kandelo::locks::Event> prepared;
};
static thread_local std::map<JSContext*, KandeloLockContext> kandeloLockEnvironments;
static KandeloLockContext& KandeloLockEnvironment(JSContext* cx) {
  const auto found = kandeloLockEnvironments.find(cx);
  if (found != kandeloLockEnvironments.end()) return found->second;
  const auto id = KandeloLockManager().Register();
  try { return kandeloLockEnvironments.emplace(cx, KandeloLockContext{id, {}}).first->second; }
  catch (...) { KandeloLockManager().Retire(id); throw; }
}
static bool KandeloLocksHaveReferences(JSContext* cx) {
  const auto found = kandeloLockEnvironments.find(cx);
  // Like pinned SetImmediateThreadsafe wakeups, deliverable work is referenced.
  // An unresolved callback/pending Promise alone does not keep Node running.
  return found != kandeloLockEnvironments.end() && KandeloLockManager().Ready(found->second.identity);
}
static bool KandeloWaitForLocksReady(JSContext* cx, unsigned maximumMicroseconds) {
  const auto found = kandeloLockEnvironments.find(cx);
  if (found == kandeloLockEnvironments.end()) return false;
  // Replace only the existing bounded provider sleep, inside its idle-clock
  // bracket. Never extend a timer/socket/work provider's chosen deadline.
  KandeloLockManager().WaitForReady(found->second.identity, std::chrono::microseconds(maximumMicroseconds));
  return true;
}
static void KandeloShutdownLocks(JSContext* cx) {
  const auto found = kandeloLockEnvironments.find(cx);
  if (found == kandeloLockEnvironments.end()) return;
  KandeloLockManager().Retire(found->second.identity);
  kandeloLockEnvironments.erase(found);
}
static bool KandeloLockInfo(JSContext* cx, const kandelo::locks::Info& info,
                           MutableHandleObject result) {
  result.set(JS_NewPlainObject(cx));
  RootedString name(cx, JS_NewUCStringCopyN(cx, info.name.data(), info.name.size()));
  RootedString mode(cx, JS_NewStringCopyZ(cx, info.mode == kandelo::locks::Mode::Shared ? "shared" : "exclusive"));
  RootedString client(cx, JS_NewStringCopyN(cx, info.clientId.data(), info.clientId.size()));
  return result && name && mode && client &&
      JS_DefineProperty(cx, result, "name", name, JSPROP_ENUMERATE) &&
      JS_DefineProperty(cx, result, "mode", mode, JSPROP_ENUMERATE) &&
      JS_DefineProperty(cx, result, "clientId", client, JSPROP_ENUMERATE);
}
static bool KandeloLockArray(JSContext* cx, const std::vector<kandelo::locks::Info>& entries,
                            MutableHandleObject result) {
  result.set(JS::NewArrayObject(cx, entries.size()));
  if (!result) return false;
  for (size_t i = 0; i < entries.size(); ++i) {
    RootedObject item(cx);
    if (!KandeloLockInfo(cx, entries[i], &item) || !JS_DefineElement(cx, result, i, item, JSPROP_ENUMERATE)) return false;
  }
  return true;
}
static bool KandeloLockDispatch(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "Web Locks operation required"); return false; }
  RootedString operationString(cx, args[0].toString());
  JS::UniqueChars operation(JS_EncodeStringToUTF8(cx, operationString));
  if (!operation) return false;
  auto& context = KandeloLockEnvironment(cx);
  const auto environment = context.identity;
  if (!strcmp(operation.get(), "ready")) {
    args.rval().setBoolean(KandeloLockManager().Ready(environment)); return true;
  }
  if (!strcmp(operation.get(), "request")) {
    if (!args.get(1).isString() || !args.get(2).isString() || !args.get(3).isString() ||
        !args.get(4).isBoolean() || !args.get(5).isBoolean()) {
      JS_ReportErrorASCII(cx, "Invalid Web Locks native request"); return false;
    }
    RootedString name(cx, args[1].toString()), client(cx, args[2].toString()), mode(cx, args[3].toString());
    AutoStableStringChars chars(cx);
    if (!chars.initTwoByte(cx, name)) return false;
    JS::UniqueChars clientText(JS_EncodeStringToUTF8(cx, client)), modeText(JS_EncodeStringToUTF8(cx, mode));
    if (!clientText || !modeText) return false;
    std::u16string resource(chars.twoByteChars(), JS_GetStringLength(name));
    const auto id = KandeloLockManager().Request(environment, std::move(resource), clientText.get(),
        !strcmp(modeText.get(), "shared") ? kandelo::locks::Mode::Shared : kandelo::locks::Mode::Exclusive,
        args[4].toBoolean(), args[5].toBoolean());
    args.rval().setNumber(double(id)); return true;
  }
  if (!strcmp(operation.get(), "next")) {
    context.prepared.reset();
    auto event = KandeloLockManager().Preview(environment);
    if (event.kind == kandelo::locks::Event::Kind::Empty) { args.rval().setUndefined(); return true; }
    RootedObject result(cx, JS_NewPlainObject(cx)), info(cx), localStolen(cx, JS::NewArrayObject(cx, event.localStolen.size()));
    const char* kind = event.kind == kandelo::locks::Event::Kind::Grant ? "grant" :
        event.kind == kandelo::locks::Event::Kind::Miss ? "miss" : "stolen";
    RootedString kindString(cx, JS_NewStringCopyZ(cx, kind));
    if (!result || !localStolen || !kindString || !KandeloLockInfo(cx, event.info, &info) ||
        !JS_DefineProperty(cx, result, "id", double(event.info.id), JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, result, "kind", kindString, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, result, "info", info, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, result, "localStolen", localStolen, JSPROP_ENUMERATE)) return false;
    for (size_t i = 0; i < event.localStolen.size(); ++i)
      if (!JS_DefineElement(cx, localStolen, i, double(event.localStolen[i]), JSPROP_ENUMERATE)) return false;
    // Moving this metadata cannot allocate. Neither manager state nor victims
    // changed while JS constructed the packet; the receiver commits only after
    // it also owns its local callback/error roots.
    context.prepared.emplace(std::move(event));
    args.rval().setObject(*result); return true;
  }
  if (!strcmp(operation.get(), "discard")) {
    context.prepared.reset(); args.rval().setUndefined(); return true;
  }
  if (!strcmp(operation.get(), "commit")) {
    const auto value = args.get(1);
    const bool matches = value.isNumber() && context.prepared &&
        value.toNumber() == double(context.prepared->info.id);
    const bool committed = matches && KandeloLockManager().Commit(*context.prepared);
    context.prepared.reset(); args.rval().setBoolean(committed); return true;
  }
  if (!strcmp(operation.get(), "complete")) {
    const auto value = args.get(1);
    if (!value.isNumber() || value.toNumber() < 1 || value.toNumber() > 9007199254740991.0 ||
        !std::isfinite(value.toNumber()) || std::floor(value.toNumber()) != value.toNumber()) {
      JS_ReportErrorASCII(cx, "Invalid Web Locks request identity"); return false;
    }
    const auto status = KandeloLockManager().Complete(environment, uint64_t(value.toNumber()));
    // Returning an immediate scalar cannot fail after the ownership release.
    args.rval().setInt32(status == kandelo::locks::Completion::Stolen ? 2 :
        status == kandelo::locks::Completion::Completed ? 1 : 0); return true;
  }
  if (!strcmp(operation.get(), "query")) {
    const auto snapshot = KandeloLockManager().Query(environment);
    RootedObject result(cx, JS_NewPlainObject(cx)), held(cx), pending(cx);
    if (!result || !KandeloLockArray(cx, snapshot.held, &held) || !KandeloLockArray(cx, snapshot.pending, &pending) ||
        !JS_DefineProperty(cx, result, "held", held, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, result, "pending", pending, JSPROP_ENUMERATE)) return false;
    args.rval().setObject(*result); return true;
  }
  JS_ReportErrorASCII(cx, "Unknown Web Locks native operation"); return false;
}
static bool KandeloNativeLocks(JSContext* cx, unsigned argc, Value* vp) {
  try { return KandeloLockDispatch(cx, argc, vp); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  catch (const std::exception& error) { JS_ReportErrorASCII(cx, "%s", error.what()); return false; }
}
}  // namespace
