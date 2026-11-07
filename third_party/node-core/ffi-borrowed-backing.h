// Actual foreign-byte alias descriptors. Caller owns the payload lifetime;
// these capabilities own only real metadata, never physical payload/free rights.
#ifndef KANDELO_NODE_FFI_BORROWED_BACKING_H_
#define KANDELO_NODE_FFI_BORROWED_BACKING_H_
#include <atomic>
#include <memory>
#include <stdexcept>
#include <utility>
#include "js/experimental/KandeloBackingCapabilities.h"
namespace kandelo::ffi {
namespace Backing = JS::KandeloBacking;
using TrackBorrowMetadata = Backing::MetadataRef (*)(size_t, const Backing::AccountRef&);
class BorrowedAllocation;
class BorrowedOwner final : public Backing::Owner {
  Backing::AllocationRef allocation_;
  Backing::MetadataRef metadata_;
 public:
  BorrowedOwner(Backing::AllocationRef allocation, Backing::MetadataRef metadata)
      : allocation_(std::move(allocation)), metadata_(std::move(metadata)) {}
  Backing::AllocationRef Store() const noexcept override { return allocation_; }
};
class BorrowedSpan final : public Backing::Span {
  Backing::AllocationRef allocation_;
  const size_t offset_, length_;
  Backing::MetadataRef metadata_;
 public:
  BorrowedSpan(Backing::AllocationRef allocation, size_t offset, size_t length, Backing::MetadataRef metadata)
      : allocation_(std::move(allocation)), offset_(offset), length_(length), metadata_(std::move(metadata)) {}
  uint8_t* Data() const noexcept override {
    return offset_ ? allocation_->Data() + offset_ : allocation_->Data();
  }
  size_t Length() const noexcept override { return length_; }
  size_t Offset() const noexcept override { return offset_; }
  size_t Capacity() const noexcept override { return allocation_->Capacity(); }
  bool Shared() const noexcept override { return false; }
  Backing::AllocationRef Store() const noexcept override { return allocation_; }
};
class BorrowedAllocation final : public Backing::Allocation,
    public std::enable_shared_from_this<BorrowedAllocation> {
  uint8_t* const data_;
  const size_t capacity_;
  const TrackBorrowMetadata track_;
  Backing::MetadataRef metadata_;
  std::atomic<bool> committed_{false};
  std::atomic<size_t> synchronizedJsOwners_{0};
 public:
  BorrowedAllocation(uint8_t* data, size_t capacity, TrackBorrowMetadata track,
                     const Backing::AccountRef& account)
      : data_(data), capacity_(capacity), track_(track), metadata_(track ? track(sizeof(BorrowedAllocation), account) : Backing::MetadataRef{}) {
    if ((!data && capacity) || !track || !metadata_) throw std::invalid_argument("invalid borrowed backing descriptor");
  }
  uint8_t* Data() const noexcept override { return data_; }
  size_t Capacity() const noexcept override { return capacity_; }
  bool Shared() const noexcept override { return false; }
  void Commit() noexcept override { committed_.store(true, std::memory_order_release); }
  bool Committed() const noexcept override { return committed_.load(std::memory_order_acquire); }
  void SynchronizeJsOwners(size_t count) noexcept override {
    synchronizedJsOwners_.store(count, std::memory_order_release);
  }
  Backing::OwnerRef MakeOwner(const Backing::AccountRef& account, bool) override {
    // No engineAccountsPayload claim: no allocation/free authority over caller
    // storage is transferred by an unsafe zero-copy FFI view.
    auto metadata = track_(sizeof(BorrowedOwner), account);
    if (!metadata) throw std::bad_alloc();
    return std::make_unique<BorrowedOwner>(shared_from_this(), std::move(metadata));
  }
  Backing::SpanRef Capture(size_t offset, size_t length, const Backing::AccountRef& account) override {
    if (!Committed() || offset > capacity_ || length > capacity_ - offset)
      throw std::out_of_range("borrowed span exceeds actual descriptor bounds");
    auto metadata = track_(sizeof(BorrowedSpan), account);
    if (!metadata) throw std::bad_alloc();
    return std::make_shared<BorrowedSpan>(shared_from_this(), offset, length, std::move(metadata));
  }
};
}  // namespace kandelo::ffi
#endif
