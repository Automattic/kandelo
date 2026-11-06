// Owner-thread JSAPI projection of the process native ledger. Included before
// callback/portable material adapters. No anchor is created lazily in a VM realm.
#include "native-retained-memory.h"
#include <map>
#include <pthread.h>
static bool IsKandeloNodeMode();
namespace {
struct KandeloNativeMemoryAccount {
  kandelo::memory::AccountHandle account = std::make_shared<kandelo::memory::Account>();
  JS::PersistentRootedObject anchor;
  const pthread_t thread = pthread_self();
  kandelo::memory::CreditBalance credit;
  KandeloNativeMemoryAccount(JSContext* cx, HandleObject environment)
      : anchor(cx, environment) {}
  void Flush() noexcept {
    MOZ_RELEASE_ASSERT(pthread_equal(thread, pthread_self()));
    credit.Flush(account->Desired(),
        [&](size_t bytes) { JS::AddAssociatedMemory(anchor, bytes, JS::MemoryUse::Embedding3); },
        [&](size_t bytes) { JS::RemoveAssociatedMemory(anchor, bytes, JS::MemoryUse::Embedding3); });
  }
  ~KandeloNativeMemoryAccount() {
    // Only primitive native account metadata may survive this point, in actual
    // queues/workers. A dying primary environment never owns a lingering root.
    account->Detach(); Flush(); anchor.reset();
  }
};
static thread_local std::map<JSContext*, std::unique_ptr<KandeloNativeMemoryAccount>> kandeloNativeMemoryAccounts;
static kandelo::memory::AccountHandle KandeloNativeMemoryOwner(JSContext* cx) {
  const auto found = kandeloNativeMemoryAccounts.find(cx);
  return found == kandeloNativeMemoryAccounts.end() ? nullptr : found->second->account;
}
static JSObject* KandeloNativeMemoryEnvironment(JSContext* cx) {
  const auto found = kandeloNativeMemoryAccounts.find(cx);
  return found == kandeloNativeMemoryAccounts.end() ? nullptr : found->second->anchor.get();
}
static void KandeloFlushNativeMemory(JSContext* cx) noexcept {
  const auto found = kandeloNativeMemoryAccounts.find(cx);
  if (found != kandeloNativeMemoryAccounts.end()) found->second->Flush();
}
class KandeloNativeMemoryEnvironmentScope {
  JSContext* cx_ = nullptr;
  bool ready_ = false;
 public:
  KandeloNativeMemoryEnvironmentScope(JSContext* cx, HandleObject primaryEnvironment) {
    if (!IsKandeloNodeMode()) { ready_ = true; return; }
    // Called only by the actual main/shell-worker/Node-worker environment
    // entries, whose existing RootedObject already owns this global lifetime.
    MOZ_RELEASE_ASSERT(!kandeloNativeMemoryAccounts.count(cx));
    try {
      auto owner = std::make_unique<KandeloNativeMemoryAccount>(cx, primaryEnvironment);
      kandeloNativeMemoryAccounts.emplace(cx, std::move(owner));
      cx_ = cx; ready_ = true; KandeloFlushNativeMemory(cx);
    } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); }
  }
  bool Ready() const { return ready_; }
  ~KandeloNativeMemoryEnvironmentScope() {
    if (cx_) kandeloNativeMemoryAccounts.erase(cx_);
  }
};
} // namespace
