// Process-owned native allocation conservation and owner-thread GC projections.
// No JS values, JSContext pointers or foreign-thread JSAPI calls belong here.
#ifndef KANDELO_NODE_NATIVE_RETAINED_MEMORY_H_
#define KANDELO_NODE_NATIVE_RETAINED_MEMORY_H_
#include <atomic>
#include <cassert>
#include <cstddef>
// Guest allocation snapshots use the declared musl allocator. Keep its
// conditional declaration in the owning header, outside unity include lifting.
#if defined(__wasm__)
#  include <malloc.h>
#endif
#include <limits>
#include <memory>
#include <mutex>
#include <utility>
#include <vector>

namespace kandelo::memory {
class Account;
class Record;
class Claim;
struct Totals {
  size_t retained = 0, pending = 0, projected = 0, allocations = 0, accounts = 0;
};
class Ledger {
  friend class Account;
  friend class Record;
  friend class Claim;
  std::mutex mutex_;
  Record* records_ = nullptr;
  Account* accounts_ = nullptr;
  void Select(Record& record) noexcept;
 public:
  Totals Inspect() noexcept;
};
// Constructed before main; lazily constructed endpoint registries are retired
// before this process service. It owns no payloads, contexts or JS roots.
constinit inline Ledger processLedger;

class Account {
  friend class Ledger;
  friend class Record;
  Account* previous_ = nullptr;
  Account* next_ = nullptr;
  bool active_ = true; // ledger mutex only
  std::atomic<size_t> desired_{0};
 public:
  Account() noexcept {
    auto& l = processLedger; std::lock_guard lock(l.mutex_);
    next_ = l.accounts_;
    if (next_) next_->previous_ = this;
    l.accounts_ = this;
    for (Record* r = l.records_; r; ) { AdoptExisting(l, r); }
  }
  Account(const Account&) = delete;
  Account& operator=(const Account&) = delete;
  ~Account() { Detach(); }
  size_t Desired() const noexcept { return desired_.load(std::memory_order_acquire); }
  // Called before the owning thread removes actual GC credit and its primary
  // environment anchor. Outstanding native claims may retain this inert native
  // metadata, never the retired context or realm.
  void Detach() noexcept;
 private:
  static void AdoptExisting(Ledger&, Record*&) noexcept;
};

class Record {
  friend class Ledger;
  friend class Account;
  friend class Claim;
  Record* previous_ = nullptr;
  Record* next_ = nullptr;
  Claim* claims_ = nullptr;
  Account* charged_ = nullptr;
  size_t bytes_ = 0;
  bool live_ = true;
 public:
  explicit Record(size_t bytes) noexcept : bytes_(bytes) {
    auto& l = processLedger; std::lock_guard lock(l.mutex_);
    next_ = l.records_;
    if (next_) next_->previous_ = this;
    l.records_ = this; l.Select(*this);
  }
  Record(const Record&) = delete;
  ~Record() {
    auto& l = processLedger; std::lock_guard lock(l.mutex_);
    assert(!live_ && !bytes_ && !claims_);
    if (previous_) previous_->next_ = next_; else l.records_ = next_;
    if (next_) next_->previous_ = previous_;
  }
  void Resize(size_t bytes) noexcept {
    auto& l = processLedger; std::lock_guard lock(l.mutex_);
    assert(live_);
    if (charged_) {
      if (bytes > bytes_) charged_->desired_.fetch_add(bytes - bytes_, std::memory_order_release);
      else charged_->desired_.fetch_sub(bytes_ - bytes, std::memory_order_release);
    }
    bytes_ = bytes;
  }
  void Retire() noexcept {
    auto& l = processLedger; std::lock_guard lock(l.mutex_);
    if (charged_) charged_->desired_.fetch_sub(bytes_, std::memory_order_release);
    bytes_ = 0; live_ = false; charged_ = nullptr;
  }
};
using RecordHandle = std::shared_ptr<Record>;
using AccountHandle = std::shared_ptr<Account>;

// Exactly one of these belongs to each actual allocation/container owner.
// Claims can retain accounting metadata, but cannot extend a payload lifetime.
class Allocation {
  RecordHandle record_;
 public:
  explicit Allocation(size_t bytes = 0) : record_(std::make_shared<Record>(bytes)) {}
  Allocation(const Allocation&) = delete;
  Allocation& operator=(const Allocation&) = delete;
  Allocation(Allocation&& other) noexcept : record_(std::move(other.record_)) {}
  Allocation& operator=(Allocation&& other) noexcept {
    if (this != &other) { if (record_) record_->Retire(); record_ = std::move(other.record_); }
    return *this;
  }
  ~Allocation() { if (record_) record_->Retire(); }
  void Resize(size_t bytes) noexcept { assert(record_); record_->Resize(bytes); }
  const RecordHandle& Handle() const noexcept { return record_; }
};

// A claim describes an actual native holder in an environment. Multiple aliases
// or fan-out deliveries never multiply the physical allocation's ledger bytes.
class Claim {
  friend class Ledger;
  RecordHandle record_;
  AccountHandle account_;
  Claim* previous_ = nullptr;
  Claim* next_ = nullptr;
 public:
  Claim(RecordHandle record, AccountHandle account) noexcept
      : record_(std::move(record)), account_(std::move(account)) {
    assert(record_);
    auto& l = processLedger; std::lock_guard lock(l.mutex_);
    next_ = record_->claims_;
    if (next_) next_->previous_ = this;
    record_->claims_ = this; l.Select(*record_);
  }
  Claim(const Claim&) = delete;
  Claim& operator=(const Claim&) = delete;
  ~Claim() {
    auto& l = processLedger; std::lock_guard lock(l.mutex_);
    if (previous_) previous_->next_ = next_; else record_->claims_ = next_;
    if (next_) next_->previous_ = previous_;
    l.Select(*record_);
  }
};
// Actual advisory GC credit can lag native desired credit across threads.
// Only its owner thread calls this balance with real host Add/Remove APIs.
class CreditBalance {
  size_t associated_ = 0;
 public:
  size_t Associated() const noexcept { return associated_; }
  template<class Add, class Remove>
  void Flush(size_t desired, Add add, Remove remove) {
    if (desired > associated_) add(desired - associated_);
    else if (associated_ > desired) remove(associated_ - desired);
    associated_ = desired;
  }
};
// Reusable native holder transaction. Build a replacement without mutating
// published ownership; commit is a nonallocating swap. Callers account these
// concrete vector/node capacities in their own container record.
class Claims {
  std::vector<std::unique_ptr<Claim>> claims_;
 public:
  void Reserve(size_t count) { claims_.reserve(count); }
  void Add(const RecordHandle& record, const AccountHandle& account) {
    claims_.push_back(std::make_unique<Claim>(record, account));
  }
  void Commit(Claims& replacement) noexcept { claims_.swap(replacement.claims_); }
  void Clear() noexcept { claims_.clear(); }
  size_t MaterialBytes() const noexcept {
    return claims_.capacity() * sizeof(claims_[0]) + claims_.size() * sizeof(Claim);
  }
};
inline void Ledger::Select(Record& r) noexcept {
  Account* selected = nullptr;
  if (r.live_) {
    for (Claim* c = r.claims_; c; c = c->next_) {
      if (!c->account_ || !c->account_->active_) continue;
      // Keep an existing real claimant when possible to avoid needless moves.
      if (c->account_.get() == r.charged_) { selected = r.charged_; break; }
      if (!selected) selected = c->account_.get();
    }
    // No live claimant means native pending ownership, not a guessed receiver.
    // One live account projects this process pool into GC pressure. With no
    // live account, only the native ledger retains its cost until attachment.
    if (!selected) selected = accounts_;
  }
  if (selected == r.charged_) return;
  if (r.charged_) r.charged_->desired_.fetch_sub(r.bytes_, std::memory_order_release);
  r.charged_ = selected;
  if (selected) selected->desired_.fetch_add(r.bytes_, std::memory_order_release);
}
inline void Account::AdoptExisting(Ledger& l, Record*& record) noexcept {
  l.Select(*record); record = record->next_;
}
inline void Account::Detach() noexcept {
  auto& l = processLedger; std::lock_guard lock(l.mutex_);
  if (!active_) return;
  active_ = false;
  if (previous_) previous_->next_ = next_; else l.accounts_ = next_;
  if (next_) next_->previous_ = previous_;
  for (Record* r = l.records_; r; r = r->next_) l.Select(*r);
  assert(Desired() == 0);
}
inline Totals Ledger::Inspect() noexcept {
  std::lock_guard lock(mutex_); Totals out;
  for (Account* a = accounts_; a; a = a->next_) {
    ++out.accounts; out.projected += a->Desired();
  }
  for (Record* r = records_; r; r = r->next_) {
    if (!r->live_) continue;
    ++out.allocations; out.retained += r->bytes_;
    bool claimed = false;
    for (Claim* c = r->claims_; c; c = c->next_)
      if (c->account_ && c->account_->active_) { claimed = true; break; }
    if (!claimed) out.pending += r->bytes_;
  }
  assert(out.projected == (out.accounts ? out.retained : 0));
  return out;
}
} // namespace kandelo::memory
#endif
