#ifndef KANDELO_NODE_READ_FILE_BUFFER_H
#define KANDELO_NODE_READ_FILE_BUFFER_H
#include "kandelo-node-backing-capabilities.h"
#include "native-retained-memory.h"
#include <stdexcept>

namespace kandelo::nodefs {
// One actual malloc/realloc owner. Capacity is the allocator request that last
// succeeded, independently of the logical read result. No JS roots/context or
// foreign-thread GC operations are retained here. It freezes at the existing
// USER_OWNED backing transaction; afterward all aliases share this same owner.
class ReadFileBuffer final : public JS::KandeloBacking::Allocation,
                             public std::enable_shared_from_this<ReadFileBuffer> {
 public:
  using ConvertAccount = kandelo::memory::AccountHandle (*)(const JS::KandeloBacking::AccountRef&);
  struct Allocator {
    void* (*allocate)(size_t);
    void* (*reallocate)(void*, size_t);
    void (*release)(void*) noexcept;
  };
 private:
  class Owner;
  class Span;
  const Allocator allocator_;
  const ConvertAccount convert_;
  uint8_t* data_ = nullptr;
  size_t capacity_ = 0;
  std::atomic<bool> committed_{false};
  kandelo::memory::Allocation material_{sizeof(ReadFileBuffer)};
  kandelo::memory::Claim claim_;
 public:
  ReadFileBuffer(Allocator allocator, const kandelo::memory::AccountHandle& account,
                 ConvertAccount convert)
      : allocator_(allocator), convert_(convert), claim_(material_.Handle(), account) {
    if (!allocator_.allocate || !allocator_.reallocate || !allocator_.release || !convert_)
      throw std::invalid_argument("ReadFileBuffer requires its actual allocator/account provider");
  }
  ~ReadFileBuffer() override { allocator_.release(data_); }
  bool Resize(size_t capacity) {
    if (Committed()) throw std::logic_error("Published ReadFileBuffer cannot reallocate");
    if (!capacity || capacity > SIZE_MAX - sizeof(ReadFileBuffer)) return false;
    void* replacement = data_ ? allocator_.reallocate(data_, capacity) : allocator_.allocate(capacity);
    if (!replacement) return false; // realloc failure retains pointer, capacity and claim.
    data_ = static_cast<uint8_t*>(replacement); capacity_ = capacity;
    material_.Resize(sizeof(ReadFileBuffer) + capacity_);
    return true;
  }
  void Clear() {
    if (Committed()) throw std::logic_error("Published ReadFileBuffer cannot clear");
    allocator_.release(data_); data_ = nullptr; capacity_ = 0;
    material_.Resize(sizeof(ReadFileBuffer));
  }
  uint8_t* Data() const noexcept override { return data_; }
  size_t Capacity() const noexcept override { return capacity_; }
  void Commit() noexcept override {
    assert(data_ && capacity_ && !Committed());
    committed_.store(true, std::memory_order_release);
  }
  bool Committed() const noexcept override { return committed_.load(std::memory_order_acquire); }
  bool Shared() const noexcept override { return false; }
  // This producer is a private nonshared USER_OWNED buffer. Only the native
  // allocation record accounts its payload; shared raw-buffer synchronization
  // and engine-accounted malloc storage are different owning contracts.
  void SynchronizeJsOwners(size_t count) noexcept override { assert(count == 0); (void)count; }
  JS::KandeloBacking::OwnerRef MakeOwner(const JS::KandeloBacking::AccountRef&, bool) override;
  JS::KandeloBacking::SpanRef Capture(size_t, size_t, const JS::KandeloBacking::AccountRef&) override;
};
class ReadFileBuffer::Owner final : public JS::KandeloBacking::Owner {
  JS::KandeloBacking::AllocationRef allocation_;
  kandelo::memory::Allocation material_{sizeof(Owner)};
  kandelo::memory::Claim allocationClaim_, selfClaim_;
 public:
  Owner(std::shared_ptr<ReadFileBuffer> allocation, const kandelo::memory::AccountHandle& account)
      : allocation_(allocation), allocationClaim_(allocation->material_.Handle(), account),
        selfClaim_(material_.Handle(), account) {}
  JS::KandeloBacking::AllocationRef Store() const noexcept override { return allocation_; }
};
class ReadFileBuffer::Span final : public JS::KandeloBacking::Span {
  std::shared_ptr<ReadFileBuffer> allocation_;
  const size_t offset_, length_;
  kandelo::memory::Allocation material_{sizeof(Span)};
  kandelo::memory::Claim allocationClaim_, selfClaim_;
 public:
  Span(std::shared_ptr<ReadFileBuffer> allocation, size_t offset, size_t length,
       const kandelo::memory::AccountHandle& account)
      : allocation_(allocation), offset_(offset), length_(length),
        allocationClaim_(allocation->material_.Handle(), account), selfClaim_(material_.Handle(), account) {}
  uint8_t* Data() const noexcept override { return offset_ ? allocation_->Data() + offset_ : allocation_->Data(); }
  size_t Length() const noexcept override { return length_; }
  size_t Offset() const noexcept override { return offset_; }
  size_t Capacity() const noexcept override { return allocation_->Capacity(); }
  JS::KandeloBacking::AllocationRef Store() const noexcept override { return allocation_; }
  bool Shared() const noexcept override { return false; }
};
inline JS::KandeloBacking::OwnerRef ReadFileBuffer::MakeOwner(
    const JS::KandeloBacking::AccountRef& account, bool engineAccounts) {
  if (engineAccounts) throw std::invalid_argument("ReadFileBuffer payload is native-accounted USER_OWNED storage");
  return std::make_unique<Owner>(shared_from_this(), convert_(account));
}
inline JS::KandeloBacking::SpanRef ReadFileBuffer::Capture(size_t offset, size_t length,
    const JS::KandeloBacking::AccountRef& account) {
  if (!Committed() || offset > capacity_ || length > capacity_ - offset)
    throw std::out_of_range("ReadFileBuffer span exceeds its frozen allocation");
  return std::make_shared<Span>(shared_from_this(), offset, length, convert_(account));
}
} // namespace kandelo::nodefs
#endif
