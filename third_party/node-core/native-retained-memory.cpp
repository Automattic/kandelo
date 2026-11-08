// Owner-thread JSAPI projection of the process native ledger. Included before
// callback/portable material adapters. No anchor is created lazily in a VM realm.
#include "native-retained-memory.h"
#include "js/MemoryMetrics.h"
#include "js/BigInt.h"
#include "mozilla/mozalloc.h"
#include <map>
#include <pthread.h>
static bool IsKandeloNodeMode();
namespace {
struct KandeloNativeMemoryAccount {
  kandelo::memory::AccountHandle account = std::make_shared<kandelo::memory::Account>();
  JS::KandeloBacking::AccountRef backingAccount = KandeloMakeBackingAccount(account);
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
static JS::KandeloBacking::AccountRef KandeloNativeBackingAccount(JSContext* cx) noexcept {
  const auto found = kandeloNativeMemoryAccounts.find(cx);
  return found == kandeloNativeMemoryAccounts.end() ? JS::KandeloBacking::AccountRef{} : found->second->backingAccount;
}
static JSObject* KandeloNativeMemoryEnvironment(JSContext* cx) {
  const auto found = kandeloNativeMemoryAccounts.find(cx);
  return found == kandeloNativeMemoryAccounts.end() ? nullptr : found->second->anchor.get();
}
static void KandeloFlushNativeMemory(JSContext* cx) noexcept {
  const auto found = kandeloNativeMemoryAccounts.find(cx);
  if (found != kandeloNativeMemoryAccounts.end()) found->second->Flush();
}
// Context-owned diagnostic category provider. The byte operation is the
// actual configured allocator, never retained capacity or host Node telemetry.
static size_t KandeloBackingAllocationSize(const void* data) {
#if defined(__wasm__)
  // The declared engine recipe disables jemalloc; JS malloc contents use this
  // same guest musl allocator. Do not depend on a missing configure probe that
  // makes moz_malloc_size_of's generic fallback silently return zero.
  return malloc_usable_size(const_cast<void*>(data));
#else
  return moz_malloc_size_of(data);
#endif
}
static bool KandeloNativeBackingSnapshot(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedObject environment(cx, KandeloNativeMemoryEnvironment(cx));
  if (!environment) { JS_ReportErrorASCII(cx, "Backing snapshot requires its live primary environment");return false; }
#if !defined(__wasm__) && !defined(XP_DARWIN) && !defined(XP_WIN) && !defined(HAVE_MALLOC_USABLE_SIZE) && !defined(MOZ_MEMORY)
  JS_ReportErrorASCII(cx, "Backing allocation usable-size provider is unavailable");return false;
#else
  JS::KandeloArrayBufferSnapshot snapshot;
  const auto status = JS::CollectKandeloArrayBufferSnapshot(cx, KandeloBackingAllocationSize, &snapshot);
  if (status == JS::KandeloArrayBufferSnapshotStatus::OutOfMemory) { JS_ReportOutOfMemory(cx);return false; }
  if (status != JS::KandeloArrayBufferSnapshotStatus::Ok) {
    JS_ReportErrorASCII(cx, status == JS::KandeloArrayBufferSnapshotStatus::Busy
        ? "Backing snapshot requires an idle nonincremental heap"
        : "Backing snapshot byte count overflow");return false;
  }
  // The protected walk and its native staging have ended before any JS value
  // allocation or property publication. These are historical scalar values.
  RootedObject result(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));if (!result) return false;
  auto field = [&](const char* name, uint64_t value) {
    JS::Rooted<JS::BigInt*> integer(cx, JS::NumberToBigInt(cx, value));if (!integer) return false;
    RootedValue encoded(cx, JS::BigIntValue(integer));return JS_DefineProperty(cx, result, name, encoded, JSPROP_ENUMERATE);
  };
  if (!field("realms", snapshot.realms) || !field("arrayBufferObjects", snapshot.arrayBufferObjects) ||
      !field("detachedObjects", snapshot.detachedObjects) || !field("noDataObjects", snapshot.noDataObjects) ||
      !field("inlineObjects", snapshot.inlineObjects) || !field("inlinePayloadBytes", snapshot.inlinePayloadBytes) ||
      !field("mallocBackedObjects", snapshot.mallocBackedObjects) || !field("uniqueMallocAllocations", snapshot.uniqueMallocAllocations) ||
      !field("mallocUsableBytes", snapshot.mallocUsableBytes) || !field("mappedObjects", snapshot.mappedObjects) ||
      !field("wasmObjects", snapshot.wasmObjects) || !field("externalObjects", snapshot.externalObjects) ||
      !field("userOwnedObjects", snapshot.userOwnedObjects) || !field("sharedObjects", snapshot.sharedObjects) ||
      !field("unmaterializedTenuredTypedArrayObjects", snapshot.unmaterializedTenuredTypedArrayObjects)) return false;
  RootedValue nursery(cx, BooleanValue(snapshot.nurseryEmpty));
  RootedString scope(cx, JS_NewStringCopyZ(cx, "current-runtime-arraybuffer-objects"));if (!scope) return false;
  RootedValue scopeValue(cx, StringValue(scope));
  if (!JS_DefineProperty(cx, result, "nurseryEmpty", nursery, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, result, "scope", scopeValue, JSPROP_ENUMERATE)) return false;
  args.rval().setObject(*result);return true;
#endif
}
class KandeloNativeMemoryEnvironmentScope {
  JSContext* cx_ = nullptr;
  bool ready_ = false;
 public:
  KandeloNativeMemoryEnvironmentScope(JSContext* cx, HandleObject primaryEnvironment) {
    if (!IsKandeloNodeMode()) { ready_ = true; return; }
    if (!KandeloRegisterBackingCapabilities()) {
      JS_ReportErrorASCII(cx, "Backing allocation provider is already registered"); return;
    }
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
