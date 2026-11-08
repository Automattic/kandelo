// Connection/statement ownership shared by the guest native binding and the
// focused backend controls. This uses actual SQLite state, not SQL emulation.
#ifndef KANDELO_NODE_SQLITE_STORE_H
#define KANDELO_NODE_SQLITE_STORE_H
#include <cstdint>
#include <exception>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <sqlite3.h>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include "sqlite-limit-names.h"

namespace kandelo::sqlite {
struct Error : std::runtime_error {
  std::string code;
  int errcode;
  std::string errstr;
  Error(std::string code, std::string message, int number = 0, std::string description = {})
      : std::runtime_error(std::move(message)), code(std::move(code)),
        errcode(number), errstr(std::move(description)) {}
};
inline void StateError(const char* message) { throw Error("ERR_INVALID_STATE", message); }
inline Error DatabaseError(sqlite3* db, int result) {
  const int number = db ? sqlite3_extended_errcode(db) : result;
  return Error("ERR_SQLITE_ERROR", db ? sqlite3_errmsg(db) : sqlite3_errstr(result),
      number, sqlite3_errstr(number));
}
struct Options {
  bool readOnly = false, foreignKeys = true, doubleQuotedStrings = false, defensive = true;
  int timeout = 0;
  std::array<std::optional<int>, 11> limits{};
};
struct Cell {
  int type = SQLITE_NULL;
  int64_t integer = 0;
  double number = 0;
  std::string text;
  std::vector<uint8_t> bytes;
};
// A real SQLite-owned allocation. size is its image length, not an RSS or
// allocator-capacity claim. FREEONCLOSE consumes this allocation on every
// sqlite3_deserialize result (with a valid connection and nonnegative sizes).
struct Image {
  struct Free { void operator()(unsigned char* p) const { sqlite3_free(p); } };
  std::unique_ptr<unsigned char, Free> data;
  sqlite3_int64 size = 0;
  static Image Allocate(size_t length) {
    if (length > size_t(std::numeric_limits<sqlite3_int64>::max()))
      throw Error("ERR_MEMORY_ALLOCATION_FAILED", "Failed to allocate memory");
    Image image;
    image.size = sqlite3_int64(length);
    image.data.reset(static_cast<unsigned char*>(sqlite3_malloc64(length)));
    if (!image.data) throw Error("ERR_MEMORY_ALLOCATION_FAILED", "Failed to allocate memory");
    return image;
  }
};
class Statement;
#if defined(SQLITE_ENABLE_SESSION)
class Session;
#endif
class Connection : public std::enable_shared_from_this<Connection> {
  sqlite3* db_ = nullptr;
  std::string path_;
  Options options_;
  std::vector<std::weak_ptr<Statement>> statements_;
#if defined(SQLITE_ENABLE_SESSION)
  std::vector<std::weak_ptr<Session>> sessions_;
#endif
  size_t callbackDepth_ = 0;
 public:
  Connection(std::string path, Options options) : path_(std::move(path)), options_(options) {
    if (path_.find('\0') != std::string::npos) throw Error("ERR_INVALID_ARG_VALUE", "Database path must not contain null bytes");
  }
  ~Connection();
  Connection(const Connection&) = delete;
  Connection& operator=(const Connection&) = delete;
  sqlite3* Require() const {
    if (!db_) StateError("database is not open");
    return db_;
  }
  bool IsOpen() const { return db_ != nullptr; }
  bool IsTransaction() const { return sqlite3_get_autocommit(Require()) == 0; }
  std::string Location(const std::string& schema = "main") const {
    const char* path = sqlite3_db_filename(Require(), schema.c_str());
    return path ? path : "";
  }
  void Open() {
    if (db_) StateError("database is already open");
    sqlite3* candidate = nullptr;
    int result = sqlite3_open_v2(path_.c_str(), &candidate,
        SQLITE_OPEN_URI | (options_.readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE), nullptr);
    // sqlite3_open_v2 can return a sick handle even on failure. Keep it owned
    // until the message is copied, then close it on every partial-open path.
    std::unique_ptr<sqlite3, decltype(&sqlite3_close_v2)> guard(candidate, sqlite3_close_v2);
    if (result != SQLITE_OK) throw DatabaseError(candidate, result);
    for (const auto setting : {std::pair<int, int>{SQLITE_DBCONFIG_DQS_DML, options_.doubleQuotedStrings},
        {SQLITE_DBCONFIG_DQS_DDL, options_.doubleQuotedStrings},
        {SQLITE_DBCONFIG_ENABLE_FKEY, options_.foreignKeys},
        {SQLITE_DBCONFIG_DEFENSIVE, options_.defensive},
        {SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 0}}) {
      result = sqlite3_db_config(candidate, setting.first, setting.second, nullptr);
      if (result != SQLITE_OK) throw DatabaseError(candidate, result);
    }
    result = sqlite3_busy_timeout(candidate, options_.timeout);
    if (result != SQLITE_OK) throw DatabaseError(candidate, result);
    for (size_t i = 0; i < options_.limits.size(); ++i) {
      if (options_.limits[i]) sqlite3_limit(candidate, int(i), *options_.limits[i]);
    }
    db_ = guard.release();
  }
  void Close();
  void FinalizeStatements();
  void CheckDeserialize() const {
    Require();
    if (InCallback()) StateError("database cannot be deserialized while in a callback");
  }
  Image Serialize(const std::string& schema = "main") const {
    auto* db = Require();
    Image image;
    image.data.reset(sqlite3_serialize(db, schema.c_str(), &image.size, 0));
    if (!image.data && image.size != 0) throw DatabaseError(db, SQLITE_ERROR);
    return image;
  }
  void Deserialize(Image image, const std::string& schema = "main");
  void Exec(const std::string& sql) {
    sqlite3* db = Require();
#if defined(SQLITE_ENABLE_SESSION)
    // User SQL functions may trigger GC while SQLite is walking attached
    // sessions. Keep the actual native sessions through the whole operation,
    // not only until the nested JavaScript callback returns.
    const auto sessions = PinSessions();
#endif
    const int result = sqlite3_exec(db, sql.c_str(), nullptr, nullptr, nullptr);
    if (result != SQLITE_OK) throw DatabaseError(db, result);
  }
  std::shared_ptr<Statement> Prepare(const std::string& sql, bool persistent = false);
  int64_t Changes() const { return sqlite3_changes64(Require()); }
  int64_t LastInsertRowid() const { return sqlite3_last_insert_rowid(Require()); }
  int Limit(int id) const {
    if (id < 0 || size_t(id) >= options_.limits.size()) throw Error("ERR_OUT_OF_RANGE", "Invalid SQLite limit");
    return sqlite3_limit(Require(), id, -1);
  }
  void SetLimit(int id, int value) {
    Limit(id);
    sqlite3_limit(Require(), id, value);
    options_.limits[size_t(id)] = value;
  }
  void EnableDefensive(bool active) {
    auto* db = Require();
    const int result = sqlite3_db_config(db, SQLITE_DBCONFIG_DEFENSIVE, active, nullptr);
    if (result != SQLITE_OK) throw DatabaseError(db, result);
    options_.defensive = active;
  }
  bool InCallback() const { return callbackDepth_ != 0; }
#if defined(SQLITE_ENABLE_SESSION)
  std::shared_ptr<Session> CreateSession(const std::string& schema, const std::string& table);
  std::vector<std::shared_ptr<Session>> PinSessions() const {
    std::vector<std::shared_ptr<Session>> result;
    for (const auto& reference : sessions_) if (auto session = reference.lock()) result.push_back(std::move(session));
    return result;
  }
  bool ApplyChangeset(const std::vector<uint8_t>& bytes,
      const std::function<bool(const char*)>& filter = {},
      const std::function<int(int)>& conflict = {}) {
    auto* db = Require();
    if (bytes.size() > size_t(std::numeric_limits<int>::max())) throw Error("ERR_OUT_OF_RANGE", "The changeset is too large.");
    struct Callbacks {
      const std::function<bool(const char*)>& filter;
      const std::function<int(int)>& conflict;
      std::exception_ptr failure;
    } callbacks{filter, conflict, {}};
    // Never unwind C++ (or later JS) through SQLite's C callback stack.
    auto select = [](void* data, const char* table) -> int {
      auto& state = *static_cast<Callbacks*>(data);
      if (state.failure) return 0;
      try { return state.filter(table) ? 1 : 0; }
      catch (...) { state.failure = std::current_exception(); return 0; }
    };
    auto resolve = [](void* data, int type, sqlite3_changeset_iter*) -> int {
      auto& state = *static_cast<Callbacks*>(data);
      if (state.failure || !state.conflict) return SQLITE_CHANGESET_ABORT;
      try { return state.conflict(type); }
      catch (...) { state.failure = std::current_exception(); return SQLITE_CHANGESET_ABORT; }
    };
    // A callback can drop the last JS session reference and trigger GC while
    // SQLite is walking its session list. Pin native owners until it returns.
    const auto sessions = PinSessions();
    CallbackScope guard(*this);
    const int result = sqlite3changeset_apply(db, int(bytes.size()),
        bytes.empty() ? const_cast<void*>(static_cast<const void*>("")) : static_cast<void*>(const_cast<uint8_t*>(bytes.data())),
        filter ? +select : nullptr, +resolve, &callbacks);
    if (callbacks.failure) std::rethrow_exception(callbacks.failure);
    if (result == SQLITE_OK) return true;
    if (result == SQLITE_ABORT) return false;
    const std::string description = sqlite3_errstr(result);
    throw Error("ERR_SQLITE_ERROR", description, result, description);
  }
#endif
  // A future JS callback bridge must hold this actual callback scope while
  // entering JS. Close cannot free a connection currently on SQLite's stack.
  class CallbackScope {
    Connection& owner_;
   public:
    explicit CallbackScope(Connection& owner) : owner_(owner) { ++owner_.callbackDepth_; }
    ~CallbackScope() { --owner_.callbackDepth_; }
    CallbackScope(const CallbackScope&) = delete;
  };
};
class Statement {
  std::shared_ptr<Connection> owner_;
  sqlite3_stmt* stmt_;
  bool executing_ = false;
  class ExecutionScope {
    Statement& statement_;
   public:
    explicit ExecutionScope(Statement& statement) : statement_(statement) {
      if (statement_.executing_) StateError("statement is already being executed");
      statement_.executing_ = true;
    }
    ~ExecutionScope() { statement_.executing_ = false; }
    ExecutionScope(const ExecutionScope&) = delete;
  };
 public:
  Statement(std::shared_ptr<Connection> owner, sqlite3_stmt* statement)
      : owner_(std::move(owner)), stmt_(statement) {}
  ~Statement() { Finalize(); }
  Statement(const Statement&) = delete;
  Statement& operator=(const Statement&) = delete;
  sqlite3_stmt* Require() const {
    if (!stmt_) StateError("statement has been finalized");
    owner_->Require();
    return stmt_;
  }
  bool IsFinalized() const { return stmt_ == nullptr; }
  void Close(bool dispose = false) {
    if (!stmt_) {
      if (!dispose) StateError("statement has been finalized");
      return;
    }
    if (executing_) StateError("statement is already being executed");
    Finalize();
  }
  void Finalize() {
    // sqlite3_finalize may invoke aggregate finalizers and reenter JavaScript.
    // Retire the owning pointer first, as the target unique_ptr reset does.
    sqlite3_stmt* statement = std::exchange(stmt_, nullptr);
    if (statement) sqlite3_finalize(statement);
  }
  void Reset(bool clear = false, bool ignorePreviousError = false) {
    auto* stmt = Require();
    ExecutionScope execution(*this);
#if defined(SQLITE_ENABLE_SESSION)
    const auto sessions = owner_->PinSessions();
#endif
    // reset returns the previous step error. An execution cleanup scope can
    // consume that already-reported error; a new explicit reset must check it.
    const int resetResult = sqlite3_reset(stmt);
    if (resetResult != SQLITE_OK && !ignorePreviousError) throw DatabaseError(owner_->Require(), resetResult);
    if (clear) {
      const int result = sqlite3_clear_bindings(stmt);
      if (result != SQLITE_OK) throw DatabaseError(owner_->Require(), result);
    }
  }
  int Stat(std::string_view name) const {
    auto* stmt = Require();
    for (const auto& info : kStatusMapping) {
      if (info.js_name == name)
        return sqlite3_stmt_status(stmt, info.sqlite_status_id, false);
    }
    throw Error("ERR_INVALID_ARG_VALUE", "The \"counter\" argument is not a valid statistic name.");
  }
  void ResetStats() {
    auto* stmt = Require();
    for (const auto& info : kStatusMapping) {
      if (info.sqlite_status_id != SQLITE_STMTSTATUS_MEMUSED)
        sqlite3_stmt_status(stmt, info.sqlite_status_id, true);
    }
    // This owner obtains names directly from the live SQLite VM, with no
    // reprepare-count column-name cache to invalidate after clearing it.
  }
  int ParameterCount() const { return sqlite3_bind_parameter_count(Require()); }
  std::string ParameterName(int index) const {
    const char* name = sqlite3_bind_parameter_name(Require(), index);
    return name ? name : "";
  }
  int ParameterIndex(const std::string& name) const {
    return sqlite3_bind_parameter_index(Require(), name.c_str());
  }
  void Bind(int index, const Cell& value) {
    auto* stmt = Require();
    int result;
    switch (value.type) {
      case SQLITE_NULL: result = sqlite3_bind_null(stmt, index); break;
      case SQLITE_INTEGER: result = sqlite3_bind_int64(stmt, index, value.integer); break;
      case SQLITE_FLOAT: result = sqlite3_bind_double(stmt, index, value.number); break;
      case SQLITE_TEXT:
        result = sqlite3_bind_text64(stmt, index, value.text.data(), value.text.size(), SQLITE_TRANSIENT, SQLITE_UTF8); break;
      case SQLITE_BLOB:
        // A null pointer means SQL NULL, even with length zero. Preserve a
        // caller's empty BLOB as an actual BLOB, not a fabricated null cell.
        result = sqlite3_bind_blob64(stmt, index, value.bytes.empty() ? static_cast<const void*>("") : value.bytes.data(),
            value.bytes.size(), SQLITE_TRANSIENT); break;
      default: throw Error("ERR_INVALID_ARG_TYPE", "Unsupported SQLite binding value");
    }
    if (result != SQLITE_OK) throw DatabaseError(owner_->Require(), result);
  }
  bool Step() {
    Require();
    ExecutionScope execution(*this);
#if defined(SQLITE_ENABLE_SESSION)
    const auto sessions = owner_->PinSessions();
#endif
    const int result = sqlite3_step(Require());
    if (result == SQLITE_ROW) return true;
    if (result == SQLITE_DONE) return false;
    throw DatabaseError(owner_->Require(), result);
  }
  int ColumnCount() const { return sqlite3_column_count(Require()); }
  std::string ColumnName(int index) const {
    const char* name = sqlite3_column_name(Require(), index);
    return name ? name : "";
  }
  std::array<std::optional<std::string>, 5> ColumnMetadata(int index) const {
    auto* stmt = Require();
    auto copy = [](const char* value) -> std::optional<std::string> {
      return value ? std::optional<std::string>(value) : std::nullopt;
    };
    return {copy(sqlite3_column_origin_name(stmt, index)),
      copy(sqlite3_column_database_name(stmt, index)), copy(sqlite3_column_name(stmt, index)),
      copy(sqlite3_column_table_name(stmt, index)), copy(sqlite3_column_decltype(stmt, index))};
  }
  std::vector<Cell> Row() const {
    auto* stmt = Require();
    std::vector<Cell> row;
    row.reserve(sqlite3_column_count(stmt));
    for (int i = 0; i < sqlite3_column_count(stmt); ++i) {
      Cell value;
      value.type = sqlite3_column_type(stmt, i);
      switch (value.type) {
        case SQLITE_INTEGER: value.integer = sqlite3_column_int64(stmt, i); break;
        case SQLITE_FLOAT: value.number = sqlite3_column_double(stmt, i); break;
        case SQLITE_TEXT: {
          const auto* bytes = sqlite3_column_text(stmt, i);
          const int length = sqlite3_column_bytes(stmt, i);
          if (!bytes && sqlite3_errcode(owner_->Require()) == SQLITE_NOMEM) throw DatabaseError(owner_->Require(), SQLITE_NOMEM);
          if (length) value.text.assign(reinterpret_cast<const char*>(bytes), length);
          break;
        }
        case SQLITE_BLOB: {
          const auto* bytes = static_cast<const uint8_t*>(sqlite3_column_blob(stmt, i));
          const int length = sqlite3_column_bytes(stmt, i);
          if (!bytes && sqlite3_errcode(owner_->Require()) == SQLITE_NOMEM) throw DatabaseError(owner_->Require(), SQLITE_NOMEM);
          if (length) value.bytes.assign(bytes, bytes + length);
          break;
        }
      }
      row.push_back(std::move(value));
    }
    return row;
  }
  std::string SourceSQL() const { return sqlite3_sql(Require()); }
  std::string ExpandedSQL() const {
    std::unique_ptr<char, decltype(&sqlite3_free)> value(sqlite3_expanded_sql(Require()), sqlite3_free);
    if (!value) throw std::bad_alloc();
    return value.get();
  }
  std::shared_ptr<Connection> Owner() const { return owner_; }
};
#if defined(SQLITE_ENABLE_SESSION)
class Session {
  std::shared_ptr<Connection> owner_;
  sqlite3_session* session_;
  bool generating_ = false;
 public:
  Session(std::shared_ptr<Connection> owner, sqlite3_session* session)
      : owner_(std::move(owner)), session_(session) {}
  ~Session() { Delete(); }
  Session(const Session&) = delete;
  bool IsOpen() const { return session_ != nullptr; }
  void Delete() {
    if (session_) { sqlite3session_delete(session_); session_ = nullptr; }
  }
  void Close(bool dispose = false) {
    if (dispose && !session_) return;
    if (!dispose) {
      owner_->Require();
      if (!session_) StateError("session is not open");
    }
    if (generating_) StateError("session is currently in use");
    if (owner_->InCallback()) StateError("session cannot be closed while in a callback");
    Delete();
  }
  std::vector<uint8_t> Changeset(bool patch) {
    auto* db = owner_->Require();
    if (!session_) StateError("session is not open");
    struct Generation { bool& state; explicit Generation(bool& value) : state(value) { state = true; } ~Generation() { state = false; } } guard(generating_);
    void* raw = nullptr;
    int length = 0;
    const int result = patch ? sqlite3session_patchset(session_, &length, &raw)
                             : sqlite3session_changeset(session_, &length, &raw);
    std::unique_ptr<void, decltype(&sqlite3_free)> bytes(raw, sqlite3_free);
    if (result != SQLITE_OK) throw DatabaseError(db, result);
    if (!length) return {};
    const auto* data = static_cast<const uint8_t*>(raw);
    return {data, data + length};
  }
};
inline std::shared_ptr<Session> Connection::CreateSession(const std::string& schema, const std::string& table) {
  auto* db = Require();
  sqlite3_session* raw = nullptr;
  int result = sqlite3session_create(db, schema.c_str(), &raw);
  std::unique_ptr<sqlite3_session, decltype(&sqlite3session_delete)> guard(raw, sqlite3session_delete);
  if (result != SQLITE_OK) throw DatabaseError(db, result);
  result = sqlite3session_attach(raw, table.empty() ? nullptr : table.c_str());
  if (result != SQLITE_OK) throw DatabaseError(db, result);
  auto session = std::make_shared<Session>(shared_from_this(), raw);
  guard.release();
  for (auto i = sessions_.begin(); i != sessions_.end();) {
    if (i->expired()) i = sessions_.erase(i); else ++i;
  }
  sessions_.push_back(session);
  return session;
}
#endif
inline Connection::~Connection() { if (db_) sqlite3_close_v2(db_); }
inline void Connection::FinalizeStatements() {
  // Finalizers may prepare/close statements. Never retain an iterator into the
  // observer vector across callbacks; also retire statements created by them.
  while (!statements_.empty()) {
    auto statements = std::move(statements_);
    statements_.clear();
    for (auto& reference : statements) if (auto statement = reference.lock()) statement->Finalize();
  }
}
inline void Connection::Deserialize(Image image, const std::string& schema) {
  CheckDeserialize();
  auto* db = Require();
  FinalizeStatements();
  // Actual SQLite takes ownership on success AND on failure. Release before
  // entering it; retaining a second deleter would double-free failed imports.
  const int result = sqlite3_deserialize(db, schema.c_str(), image.data.release(),
      image.size, image.size, SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE);
  if (result != SQLITE_OK) throw DatabaseError(db, result);
}
inline void Connection::Close() {
  auto* db = Require();
  if (callbackDepth_) StateError("database cannot be closed while in a callback");
  FinalizeStatements();
#if defined(SQLITE_ENABLE_SESSION)
  // SQLite requires sessions to retire before their database connection.
  for (auto& reference : sessions_) if (auto session = reference.lock()) session->Delete();
  sessions_.clear();
#endif
  const int result = sqlite3_close_v2(db);
  if (result != SQLITE_OK) throw DatabaseError(db, result);
  db_ = nullptr;
}
inline std::shared_ptr<Statement> Connection::Prepare(const std::string& sql, bool persistent) {
  auto* db = Require();
  if (sql.size() > size_t(std::numeric_limits<int>::max())) throw Error("ERR_OUT_OF_RANGE", "SQL text exceeds SQLite length range");
  sqlite3_stmt* raw = nullptr;
  const int result = sqlite3_prepare_v3(db, sql.data(), int(sql.size()), persistent ? SQLITE_PREPARE_PERSISTENT : 0, &raw, nullptr);
  std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> guard(raw, sqlite3_finalize);
  if (result != SQLITE_OK) throw DatabaseError(db, result);
  if (!raw) throw Error("ERR_INVALID_ARG_VALUE", "The SQL query contains no statements.");
  auto statement = std::make_shared<Statement>(shared_from_this(), raw);
  guard.release();
  // Keep only live observers; the statement owns the connection, never the
  // reverse. This prevents both a reference cycle and unbounded dead entries.
  for (auto i = statements_.begin(); i != statements_.end();) {
    if (i->expired()) i = statements_.erase(i); else ++i;
  }
  statements_.push_back(statement);
  return statement;
}
}  // namespace kandelo::sqlite
#endif
