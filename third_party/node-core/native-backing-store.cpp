// C++20 embedding implementation of the engine's C++17 ownership capability.
// No VM unit includes this fragment or the Node retained-memory implementation.
#include "kandelo-node-backing-capabilities.h"
#include "retained-backing-store.h"
namespace JS::KandeloBacking { bool Register(const Hooks*) noexcept; }
namespace {
namespace Backing = JS::KandeloBacking;
static const int kandeloBackingProviderTag = 0;
static Backing::AccountRef KandeloNativeBackingAccount(JSContext*) noexcept;
struct KandeloBackingAccount final : Backing::Account {
  kandelo::memory::AccountHandle actual;
  kandelo::memory::Allocation material{sizeof(KandeloBackingAccount)};
  kandelo::memory::Claim claim;
  explicit KandeloBackingAccount(kandelo::memory::AccountHandle account)
      : actual(std::move(account)), claim(material.Handle(), actual) {}
  const void* Provider() const noexcept override { return &kandeloBackingProviderTag; }
};
static kandelo::memory::AccountHandle KandeloBackingAccountOf(const Backing::AccountRef& account) {
  if (!account) return {};
  if (account->Provider() != &kandeloBackingProviderTag) throw std::invalid_argument("foreign backing account provider");
  return static_cast<KandeloBackingAccount*>(account.get())->actual;
}
struct KandeloBackingMetadata final : Backing::Metadata {
  kandelo::memory::Allocation material;
  kandelo::memory::Claim claim;
  KandeloBackingMetadata(size_t bytes, const Backing::AccountRef& account)
      : material(sizeof(KandeloBackingMetadata) + bytes), claim(material.Handle(), KandeloBackingAccountOf(account)) {}
  void Resize(size_t bytes) noexcept override { material.Resize(sizeof(KandeloBackingMetadata) + bytes); }
};
struct KandeloBackingAllocation;
struct KandeloBackingOwner final : Backing::Owner {
  Backing::AllocationRef allocation;
  kandelo::buffer::StoreHandle store;
  kandelo::memory::Allocation material{sizeof(KandeloBackingOwner)};
  kandelo::memory::Claim storeClaim;
  kandelo::memory::Claim controllerClaim;
  kandelo::memory::Claim selfClaim;
  std::unique_ptr<kandelo::buffer::JsBackingOwner> engineOwner;
  KandeloBackingOwner(Backing::AllocationRef allocation, kandelo::buffer::StoreHandle store,
                      const kandelo::memory::RecordHandle& controller,
                      const Backing::AccountRef& account, bool engineAccounts)
      : allocation(std::move(allocation)), store(std::move(store)),
        storeClaim(this->store->Record(), KandeloBackingAccountOf(account)),
        controllerClaim(controller, KandeloBackingAccountOf(account)),
        selfClaim(material.Handle(), KandeloBackingAccountOf(account)) {
    if (engineAccounts) engineOwner = std::make_unique<kandelo::buffer::JsBackingOwner>(this->store, KandeloBackingAccountOf(account));
  }
  Backing::AllocationRef Store() const noexcept override { return allocation; }
};
struct KandeloBackingSpan final : Backing::Span {
  Backing::AllocationRef allocation;
  kandelo::buffer::SpanHandle span;
  const bool shared;
  kandelo::memory::Allocation material{sizeof(KandeloBackingSpan)};
  kandelo::memory::Claim claim;
  kandelo::memory::Claim controllerClaim;
  KandeloBackingSpan(Backing::AllocationRef allocation, kandelo::buffer::SpanHandle span,
                    const kandelo::memory::RecordHandle& controller,
                    const Backing::AccountRef& account, bool shared)
      : allocation(std::move(allocation)), span(std::move(span)), shared(shared),
        claim(material.Handle(), KandeloBackingAccountOf(account)),
        controllerClaim(controller, KandeloBackingAccountOf(account)) {}
  uint8_t* Data() const noexcept override { return span->Data(); }
  size_t Length() const noexcept override { return span->Length(); }
  size_t Offset() const noexcept override { return span->Offset(); }
  size_t Capacity() const noexcept override { return span->AllocationCapacity(); }
  bool Shared() const noexcept override { return shared; }
  Backing::AllocationRef Store() const noexcept override { return allocation; }
};
struct KandeloBackingAllocation final : Backing::Allocation,
    std::enable_shared_from_this<KandeloBackingAllocation> {
  kandelo::buffer::StoreHandle store;
  const bool shared;
  std::mutex ownerCountMutex;
  size_t synchronizedJsOwners = 0;
  kandelo::memory::Allocation material{sizeof(KandeloBackingAllocation)};
  KandeloBackingAllocation(uint8_t* data, size_t capacity, Backing::Release release, void* user, bool shared)
      : store(kandelo::buffer::BackingStore::Prepare(data, capacity, release, user)), shared(shared) {}
  uint8_t* Data() const noexcept override { return store->Data(); }
  size_t Capacity() const noexcept override { return store->Capacity(); }
  bool Shared() const noexcept override { return shared; }
  void Commit() noexcept override { store->Commit(); }
  bool Committed() const noexcept override { return store->Committed(); }
  void SynchronizeJsOwners(size_t count) noexcept override {
    std::lock_guard lock(ownerCountMutex);
    while (synchronizedJsOwners < count) { store->AddJsOwner(); ++synchronizedJsOwners; }
    while (synchronizedJsOwners > count) { store->DropJsOwner(); --synchronizedJsOwners; }
  }
  Backing::OwnerRef MakeOwner(const Backing::AccountRef& account, bool accounted) override {
    return std::make_unique<KandeloBackingOwner>(shared_from_this(), store, material.Handle(), account, accounted);
  }
  Backing::SpanRef Capture(size_t offset, size_t length, const Backing::AccountRef& account) override {
    auto captured = kandelo::buffer::BackingSpan::Capture(store, offset, length, KandeloBackingAccountOf(account));
    return std::make_shared<KandeloBackingSpan>(shared_from_this(), std::move(captured), material.Handle(), account, shared);
  }
};
static Backing::AllocationRef KandeloPrepareBacking(uint8_t* data, size_t capacity,
    Backing::Release release, void* user, bool shared) {
  return std::make_shared<KandeloBackingAllocation>(data, capacity, release, user, shared);
}
static Backing::MetadataRef KandeloTrackBackingMetadata(size_t bytes, const Backing::AccountRef& account) {
  return std::make_shared<KandeloBackingMetadata>(bytes, account);
}
static Backing::AccountRef KandeloMakeBackingAccount(const kandelo::memory::AccountHandle& account) {
  return std::make_shared<KandeloBackingAccount>(account);
}
static bool KandeloRegisterBackingCapabilities() noexcept {
  static const Backing::Hooks hooks{&kandeloBackingProviderTag, KandeloNativeBackingAccount,
      KandeloPrepareBacking, KandeloTrackBackingMetadata};
  return Backing::Register(&hooks);
}
}  // namespace
