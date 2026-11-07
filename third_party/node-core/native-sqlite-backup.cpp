// Per-batch real SQLite backup work. SQLite owns its pages and connection
// mutexes; only the context thread owns JS roots, callbacks and finalization.
#include "kandelo-node-sqlite-backup.h"
namespace {
struct KandeloSqliteBackupWork final : js::shell::KandeloNativeWork {
  std::unique_ptr<kandelo::sqlite::Backup> backup;
  JS::PersistentRootedObject source, nativeSource, promise, progress;
  kandelo::memory::Allocation material{sizeof(KandeloSqliteBackupWork)};
  kandelo::memory::Claim claim;
  KandeloSqliteBackupWork(JSContext* cx, HandleObject source, HandleObject nativeSource,
                          HandleObject promise, HandleObject progress)
      : source(cx, source), nativeSource(cx, nativeSource), promise(cx, promise), progress(cx, progress),
        claim(material.Handle(), KandeloNativeMemoryOwner(cx)) {}
  ~KandeloSqliteBackupWork() override {
    // Even an exception-stack/OOM failure finishes SQLite while every real
    // source/callback root is still registered on the owning context thread.
    backup.reset();
  }
  struct Delete { void operator()(KandeloSqliteBackupWork* work) const { js_delete(work); } };
  using Owner = std::unique_ptr<KandeloSqliteBackupWork, Delete>;
  static Owner Create(JSContext* cx, HandleObject source, HandleObject nativeSource,
                      HandleObject promise, HandleObject progress) {
    void* memory = js_malloc(sizeof(KandeloSqliteBackupWork));
    if (!memory) throw std::bad_alloc();
    try { return Owner(new (memory) KandeloSqliteBackupWork(cx, source, nativeSource, promise, progress)); }
    catch (...) { js_free(memory); throw; }
  }
  void Run() override { backup->Step(); }
  void ClearOwners() {
    backup.reset(); source.reset(); nativeSource.reset(); progress.reset(); promise.reset();
  }
  void Cancel(JSContext*) override { ClearOwners(); } // Queue joins first; no JS during teardown.
  bool RejectPending(JSContext* cx) {
    RootedObject result(cx, promise);
    // Interrupted/OOM/forced-return paths may fail without a catchable value.
    // Retire actual native ownership and preserve that engine failure.
    if (!JS_IsExceptionPending(cx)) { ClearOwners(); return false; }
    JS::ExceptionStack exception(cx);
    if (!JS::StealPendingExceptionStack(cx, &exception)) return false;
    RootedValue reason(cx, exception.exception());
    ClearOwners();
    return JS::RejectPromise(cx, result, reason);
  }
  bool RejectSqlite(JSContext* cx, const SqliteError& error) {
    KandeloSqliteRaise(cx, error); return RejectPending(cx);
  }
  bool CompleteBody(JSContext* cx) {
    if (failure != Failure::None) {
      if (failure == Failure::OutOfMemory) JS_ReportOutOfMemory(cx);
      else JS_ReportErrorASCII(cx, "SQLite backup native work failed");
      return RejectPending(cx);
    }
    backup->CheckStep();
    const int total = backup->TotalPages(), remaining = backup->RemainingPages();
    if (remaining != 0) {
      if (progress) {
        RootedObject info(cx, JS_NewPlainObject(cx));
        if (!info || !JS_DefineProperty(cx, info, "totalPages", total, JSPROP_ENUMERATE) ||
            !JS_DefineProperty(cx, info, "remainingPages", remaining, JSPROP_ENUMERATE)) return RejectPending(cx);
        RootedValue callback(cx, ObjectValue(*progress));
        if (!JS_WrapValue(cx, &callback)) return RejectPending(cx);
        JS::RootedValueArray<1> args(cx); args[0].setObject(*info); RootedValue ignored(cx);
        // Pinned BackupJob uses an exact null receiver and catches callback
        // exceptions into the returned Promise, not an uncaught JS callback.
        if (!JS::Call(cx, JS::NullHandleValue, callback, args, &ignored)) return RejectPending(cx);
      }
      if (GetShellContext(cx)->quitting) { ClearOwners(); return true; }
      RootedObject sourceOwner(cx, source), nativeOwner(cx, nativeSource), result(cx, promise), callback(cx, progress);
      auto next = Create(cx, sourceOwner, nativeOwner, result, callback);
      next->backup = std::move(backup);
      if (!queue->Submit(next.get())) {
        backup = std::move(next->backup);
        JS_ReportErrorASCII(cx, "SQLite backup work queue is closing"); return RejectPending(cx);
      }
      next.release(); // The actual queue owns its new batch before this one retires.
      source.reset(); nativeSource.reset(); progress.reset(); promise.reset();
      return true;
    }
    if (backup->Status() != SQLITE_DONE) return RejectSqlite(cx, backup->DestinationError());
    RootedObject result(cx, promise); RootedValue value(cx, Int32Value(total));
    ClearOwners(); // Finish real SQLite/owner capability before Promise reactions.
    return JS::ResolvePromise(cx, result, value);
  }
  bool Complete(JSContext* cx) override {
    RootedObject result(cx, promise); JSAutoRealm realm(cx, result);
    RootedObject resource(cx, JS_NewPlainObject(cx));
    if (!resource) return RejectPending(cx);
    KandeloNativeInternalCallbackScope scope(cx, resource);
    if (!scope.Enter()) return false;
    if (scope.Stopped()) { ClearOwners(); return scope.Close(); }
    bool ok;
    try { ok = CompleteBody(cx); }
    catch (const SqliteError& error) { ok = RejectSqlite(cx, error); }
    catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); ok = RejectPending(cx); }
    return ok ? scope.Close() : scope.Fail();
  }
};
static bool KandeloSqliteBackup(JSContext* cx, const CallArgs& args) {
  auto* owner = KandeloSqliteOwner(args.get(1), 0);
  owner->connection->Require();
  std::string path, sourceName, targetName;
  if (args.get(2).isString()) {
    if (!KandeloSqliteString(cx, args[2], &path)) return false;
  } else {
    // The public frontend copied an actual Uint8Array before option getters.
    // Reuse the checked, rooted no-GC byte-source owner for its native copy.
    KandeloCryptoByteSource bytes(cx);
    if (!bytes.Init(args.get(2))) {
      if (!JS_IsExceptionPending(cx))
        throw SqliteError("ERR_INVALID_ARG_TYPE", "SQLite backup path requires actual byte storage or a string");
      return false;
    }
    if (!bytes.WithBytes([&](SharedMem<uint8_t*> data, size_t length) {
      path.resize(length);
      for (size_t i = 0; i < length; i++) path[i] = char(__atomic_load_n(data.unwrap() + i, __ATOMIC_RELAXED));
      return true;
    })) return false;
  }
  if (path.find('\0') != std::string::npos)
    throw SqliteError("ERR_INVALID_ARG_TYPE", "The \"path\" argument must be a string, Uint8Array, or URL without null bytes.");
  if (!KandeloSqliteString(cx, args.get(3), &sourceName) || !KandeloSqliteString(cx, args.get(4), &targetName)) return false;
  // SpiderMonkey's numeric tag is not Node/V8's semantic IsInt32 test.
  // Accept every actual integral Number in range, including double-tag values.
  const double rate = args.get(5).isNumber() ? args[5].toNumber() : 0;
  if (!std::isfinite(rate) || rate < 1 || rate > INT32_MAX || std::floor(rate) != rate || !args.get(7).isObject()) {
    JS_ReportErrorASCII(cx, "Invalid native SQLite backup arguments"); return false;
  }
  RootedObject callback(cx);
  if (!args.get(6).isUndefined()) {
    if (!args[6].isObject() || !JS::IsCallable(&args[6].toObject())) {
      JS_ReportErrorASCII(cx, "Invalid SQLite backup progress callback"); return false;
    }
    callback = &args[6].toObject();
  }
  RootedObject source(cx, &args[7].toObject()), nativeSource(cx, &args[1].toObject());
  RootedObject promise(cx, JS::NewPromiseObject(cx, nullptr)); if (!promise) return false;
  args.rval().setObject(*promise);
  auto work = KandeloSqliteBackupWork::Create(cx, source, nativeSource, promise, callback);
  try {
    work->backup = std::make_unique<kandelo::sqlite::Backup>(owner->connection, path, sourceName, targetName,
        int(rate), KandeloNativeMemoryOwner(cx));
  } catch (const SqliteError& error) { return work->RejectSqlite(cx, error); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return work->RejectPending(cx); }
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx);
  if (!queue) return work->RejectPending(cx);
  if (!queue->Submit(work.get())) {
    JS_ReportErrorASCII(cx, "SQLite backup work queue is closing"); return work->RejectPending(cx);
  }
  work.release(); return true;
}
} // namespace
