// Real batched SQLite backup ownership, adapted from pinned node_sqlite.cc.
// Only Step may run on a worker. Construction, inspection and finish belong
// to the creating thread; no JS values or GC operations are held here.
#ifndef KANDELO_NODE_SQLITE_BACKUP_H_
#define KANDELO_NODE_SQLITE_BACKUP_H_
#include "sqlite-store.h"
#include "native-retained-memory.h"
#include <cassert>
#include <thread>
namespace kandelo::sqlite {
class Backup {
  struct DatabaseDelete { void operator()(sqlite3* db) const noexcept { sqlite3_close_v2(db); } };
  struct BackupDelete { void operator()(sqlite3_backup* backup) const noexcept { sqlite3_backup_finish(backup); } };
  // The record outlives the buffers it measures, including destructor cleanup.
  kandelo::memory::Allocation material_{sizeof(Backup)};
  kandelo::memory::Claim claim_;
  std::shared_ptr<Connection> source_;
  std::vector<char> destinationName_, sourceName_, targetName_;
  std::unique_ptr<sqlite3, DatabaseDelete> destination_;
  std::unique_ptr<sqlite3_backup, BackupDelete> backup_;
  const std::thread::id owner_ = std::this_thread::get_id();
  int rate_, status_ = SQLITE_OK;
  static std::vector<char> Name(const std::string& text) {
    if (text.size() == SIZE_MAX) throw std::bad_alloc();
    std::vector<char> result;
    if (text.size() + 1 > result.max_size()) throw std::bad_alloc();
    result.reserve(text.size() + 1);
    result.insert(result.end(), text.begin(), text.end()); result.push_back(0);
    return result;
  }
  void OwnerThread() const noexcept { assert(owner_ == std::this_thread::get_id()); }
 public:
  Backup(std::shared_ptr<Connection> source, const std::string& path,
         const std::string& sourceName, const std::string& targetName, int rate,
         const kandelo::memory::AccountHandle& account = {})
      : claim_(material_.Handle(), account), source_(std::move(source)), destinationName_(Name(path)),
        sourceName_(Name(sourceName)), targetName_(Name(targetName)), rate_(rate) {
    material_.Resize(sizeof(Backup) + destinationName_.capacity() + sourceName_.capacity() + targetName_.capacity());
    if (rate <= 0) throw Error("ERR_OUT_OF_RANGE", "The \"options.rate\" argument must be a positive integer.");
    sqlite3* sourceDb = source_->Require();
    // The real linked Node backend is serialized. Never submit a raw handle
    // from a differently configured nonserialized backend to a worker.
    if (!sqlite3_threadsafe() || !sqlite3_db_mutex(sourceDb))
      StateError("SQLite backup requires a serialized source connection");
    sqlite3* destination = nullptr;
    status_ = sqlite3_open_v2(destinationName_.data(), &destination,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI, nullptr);
    destination_.reset(destination); // Own a sick handle on open failure too.
    if (status_ != SQLITE_OK) throw DatabaseError(destination, status_);
    backup_.reset(sqlite3_backup_init(destination_.get(), targetName_.data(), sourceDb, sourceName_.data()));
    if (!backup_) throw DatabaseError(destination_.get(), sqlite3_errcode(destination_.get()));
  }
  ~Backup() { Finish(); }
  Backup(const Backup&) = delete;
  Backup& operator=(const Backup&) = delete;
  void Step() noexcept { assert(backup_); status_ = sqlite3_backup_step(backup_.get(), rate_); }
  int Status() const noexcept { OwnerThread(); return status_; }
  int TotalPages() const noexcept { OwnerThread(); assert(backup_); return sqlite3_backup_pagecount(backup_.get()); }
  int RemainingPages() const noexcept { OwnerThread(); assert(backup_); return sqlite3_backup_remaining(backup_.get()); }
  void CheckStep() const {
    OwnerThread();
    if (status_ != SQLITE_OK && status_ != SQLITE_DONE && status_ != SQLITE_BUSY && status_ != SQLITE_LOCKED) {
      const std::string message = sqlite3_errstr(status_);
      throw Error("ERR_SQLITE_ERROR", message, status_, message);
    }
  }
  Error DestinationError() const { OwnerThread(); return DatabaseError(destination_.get(), status_); }
  void Finish() noexcept {
    OwnerThread(); backup_.reset(); destination_.reset(); source_.reset();
  }
};
} // namespace kandelo::sqlite
#endif
