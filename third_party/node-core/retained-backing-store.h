#ifndef KANDELO_NODE_RETAINED_BACKING_STORE_H
#define KANDELO_NODE_RETAINED_BACKING_STORE_H
#include "native-retained-memory.h"
#include <cstdint>
#include <stdexcept>

namespace kandelo::buffer {
class BackingStore;
using StoreHandle = std::shared_ptr<BackingStore>;
// The callback retires the actual allocator/raw-buffer ownership. It must be
// threadsafe and must never enter JS or use a context that may have retired.
using ReleaseAllocation = void (*)(void*, size_t, void*) noexcept;

class BackingStore {
  uint8_t* const data_;
  const size_t capacity_;
  const ReleaseAllocation release_;
  void* const userData_;
  mutable std::mutex mutex_;
  size_t jsOwners_ = 0;
  bool committed_ = false;
  kandelo::memory::Allocation material_{sizeof(BackingStore)};
  void Update() noexcept {
    // Existing engine JS owners account their actual backing allocation.
    // Native-only retention uses the existing process ledger, not a second
    // embedding account or a foreign-thread JSAPI memory credit.
    material_.Resize(sizeof(BackingStore) + (committed_ && !jsOwners_ ? capacity_ : 0));
  }
 public:
  struct PrepareTag {};
  BackingStore(PrepareTag, uint8_t* data, size_t capacity,
               ReleaseAllocation release, void* userData)
      : data_(data), capacity_(capacity), release_(release), userData_(userData) {}
  BackingStore(const BackingStore&) = delete;
  BackingStore& operator=(const BackingStore&) = delete;
  ~BackingStore() {
    assert(!jsOwners_);
    if (committed_) release_(data_, capacity_, userData_);
  }
  // Prepare never consumes the caller's allocation. Create any owner/registry
  // metadata first; only the infallible commit transfers actual deallocation.
  static StoreHandle Prepare(uint8_t* data, size_t capacity,
                             ReleaseAllocation release, void* userData = nullptr) {
    if ((!data && capacity) || !release || capacity > SIZE_MAX - sizeof(BackingStore))
      throw std::invalid_argument("invalid backing allocation");
    return std::make_shared<BackingStore>(PrepareTag{}, data, capacity, release, userData);
  }
  void Commit() noexcept {
    std::lock_guard lock(mutex_); assert(!committed_);
    committed_ = true; Update();
  }
  bool Committed() const noexcept { std::lock_guard lock(mutex_); return committed_; }
  void AddJsOwner() noexcept {
    std::lock_guard lock(mutex_); assert(jsOwners_ < SIZE_MAX);
    ++jsOwners_; Update();
  }
  void DropJsOwner() noexcept {
    std::lock_guard lock(mutex_); assert(jsOwners_);
    --jsOwners_; Update();
  }
  uint8_t* Data() const noexcept { return data_; }
  size_t Capacity() const noexcept { return capacity_; }
  const kandelo::memory::RecordHandle& Record() const noexcept { return material_.Handle(); }
};

// This actual native owner is heap allocated once; copying its shared handle
// aliases the same ownership/claim rather than inventing another JS wrapper.
class JsBackingOwner {
  StoreHandle store_;
  kandelo::memory::Allocation material_{sizeof(JsBackingOwner)};
  kandelo::memory::Claim storeClaim_;
  kandelo::memory::Claim selfClaim_;
 public:
  JsBackingOwner(StoreHandle store, const kandelo::memory::AccountHandle& account)
      : store_(std::move(store)), storeClaim_(store_->Record(), account),
        selfClaim_(material_.Handle(), account) { store_->AddJsOwner(); }
  JsBackingOwner(const JsBackingOwner&) = delete;
  ~JsBackingOwner() { store_->DropJsOwner(); }
  const StoreHandle& Store() const noexcept { return store_; }
};
using JsOwnerHandle = std::shared_ptr<JsBackingOwner>;

class BackingSpan {
  StoreHandle store_;
  const size_t offset_, length_;
  kandelo::memory::Allocation material_{sizeof(BackingSpan)};
  kandelo::memory::Claim storeClaim_;
  kandelo::memory::Claim selfClaim_;
 public:
  struct CaptureTag {};
  BackingSpan(CaptureTag, StoreHandle store, size_t offset, size_t length,
              const kandelo::memory::AccountHandle& account)
      : store_(std::move(store)), offset_(offset), length_(length),
        storeClaim_(store_->Record(), account), selfClaim_(material_.Handle(), account) {}
  BackingSpan(const BackingSpan&) = delete;
  static std::shared_ptr<BackingSpan> Capture(StoreHandle store, size_t offset, size_t length,
                         const kandelo::memory::AccountHandle& account = {}) {
    if (!store || !store->Committed() || offset > store->Capacity() ||
        length > store->Capacity() - offset)
      throw std::out_of_range("captured span exceeds retained allocation");
    return std::make_shared<BackingSpan>(CaptureTag{}, std::move(store), offset, length, account);
  }
  uint8_t* Data() const noexcept { return offset_ ? store_->Data() + offset_ : store_->Data(); }
  size_t Length() const noexcept { return length_; }
  size_t Offset() const noexcept { return offset_; }
  size_t AllocationCapacity() const noexcept { return store_->Capacity(); }
  const StoreHandle& Store() const noexcept { return store_; }
};
using SpanHandle = std::shared_ptr<BackingSpan>;
}  // namespace kandelo::buffer
#endif
