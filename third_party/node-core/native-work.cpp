/* Native guest work ownership for the SpiderMonkey Node embedding.
 * Included in shell/js.cpp after its namespace imports. Workers run through
 * guest POSIX pthreads; they never enter a JS realm or manipulate GC roots.
 * Source candidate only; no build or conformance claim.
 */
#include <pthread.h>
#include <new>

#include "js/SharedArrayBuffer.h"

namespace js::shell {
class KandeloNativeWorkQueue;

struct KandeloNativeWork {
  KandeloNativeWork* next = nullptr;
  KandeloNativeWork* externalNext = nullptr;
  KandeloNativeWorkQueue* queue = nullptr;
  bool cancelled = false;
  enum class WorkClass { Cpu, FastIo, SlowIo };
  WorkClass workClass = WorkClass::Cpu;
  enum class Failure { None, OutOfMemory, NativeException, Cancelled };
  Failure failure = Failure::None;
  virtual ~KandeloNativeWork() = default;
  virtual void Run() = 0;                       // Native worker only.
  virtual bool Complete(JSContext* cx) = 0;     // Owning JS thread only.
  virtual void Cancel(JSContext* cx) = 0;       // Owning JS thread only.
  // External producers must terminally publish after interruption. Shutdown
  // calls this without the pool lock, before joining/draining their roots.
  virtual void Interrupt() {}
};

struct KandeloNativePin {
  JS::PersistentRootedObject buffer;
  // Shared stores need a lifetime root, not a length pin. GSAB growth leaves
  // the existing address/span valid; releasing it must never unpin a different
  // owner or prevent another agent from growing that same shared store.
  bool shared;
  KandeloNativePin* next = nullptr;
  size_t references = 1;
  KandeloNativePin(JSContext* cx, JSObject* object, bool shared)
      : buffer(cx, object), shared(shared) {}
};

// A queue belongs to the shell context, rather than to a collectible JS
// object. Jobs/leases are deterministic roots of outstanding native work.
class KandeloNativeWorkQueue {
  friend struct KandeloNativeWorkPool;
  KandeloNativeWork* doneHead_ = nullptr;
  KandeloNativeWork* doneTail_ = nullptr;
  size_t outstanding_ = 0;  // Includes queued, running and completed jobs.
  size_t running_ = 0;
  size_t dispatchDepth_ = 0;
  KandeloNativeWork* externalHead_ = nullptr;
  bool closing_ = false;
  KandeloNativePin* pins_ = nullptr;  // Accessed only on the owning JS thread.

 public:
  ~KandeloNativeWorkQueue() {
    MOZ_RELEASE_ASSERT(!outstanding_ && !running_ && !doneHead_ && !externalHead_ && !pins_);
  }
  bool Submit(KandeloNativeWork* work);
  bool BeginExternal(KandeloNativeWork* work);
  void FinishExternal(KandeloNativeWork* work);
  bool TryCancel(KandeloNativeWork* work);
  bool HasWork();
  int Dispatch(JSContext* cx);
  void Shutdown(JSContext* cx);
  KandeloNativePin* Pin(JSContext* cx, JS::HandleObject view);
  void Unpin(KandeloNativePin* pin);
};

// One actual pool per guest process, with completion queues per JS context.
// A single lock protects queue membership and counts; never hold it while
// running codecs, calling JS, allocating/releasing roots, or joining threads.
struct KandeloNativeWorkPool {
  pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
  pthread_cond_t condition = PTHREAD_COND_INITIALIZER;
  pthread_t inlineThreads[4]{};
  pthread_t* threads = inlineThreads;
  unsigned threadCount = 0;
  size_t queues = 0;
  unsigned slowRunning = 0;
  bool changing = false;
  bool stopping = false;
  KandeloNativeWork* head = nullptr;
  KandeloNativeWork* tail = nullptr;

  static void Append(KandeloNativeWork*& first, KandeloNativeWork*& last,
                     KandeloNativeWork* work) {
    work->next = nullptr;
    if (last) last->next = work;
    else first = work;
    last = work;
  }

  static KandeloNativeWork* Pop(KandeloNativeWork*& first, KandeloNativeWork*& last) {
    auto* result = first;
    if (result) {
      first = result->next;
      if (!first) last = nullptr;
      result->next = nullptr;
    }
    return result;
  }

  KandeloNativeWork* EligibleWork() {
    // Blocking DNS and other slow I/O must not occupy the entire pool when
    // filesystem/CPU work is ready. The pinned libuv slow-work ceiling is
    // ceil(pool_size/2). Preserve submission order among eligible work items.
    KandeloNativeWork** link = &head;
    KandeloNativeWork* previous = nullptr;
    while (*link) {
      auto* work = *link;
      if (work->workClass != KandeloNativeWork::WorkClass::SlowIo ||
          slowRunning < (threadCount + 1) / 2) {
        *link = work->next;
        if (tail == work) tail = previous;
        work->next = nullptr;
        return work;
      }
      previous = work;
      link = &work->next;
    }
    return nullptr;
  }

  void Lock() { MOZ_RELEASE_ASSERT(pthread_mutex_lock(&mutex) == 0); }
  void Unlock() { MOZ_RELEASE_ASSERT(pthread_mutex_unlock(&mutex) == 0); }
  void Wake() { MOZ_RELEASE_ASSERT(pthread_cond_broadcast(&condition) == 0); }
  void Wait() { MOZ_RELEASE_ASSERT(pthread_cond_wait(&condition, &mutex) == 0); }

  static void* Worker(void* data) {
    auto* self = static_cast<KandeloNativeWorkPool*>(data);
    self->Lock();
    while (true) {
      KandeloNativeWork* work = nullptr;
      while (!self->stopping && !(work = self->EligibleWork())) self->Wait();
      if (self->stopping) break;
      ++work->queue->running_;
      if (work->workClass == KandeloNativeWork::WorkClass::SlowIo) ++self->slowRunning;
      self->Unlock();
      // Native allocation/error formatting can throw with this engine's
      // exception-enabled C++ configuration. Always publish a completion and
      // retire the running count, even when the codec cannot finish normally.
      try {
        work->Run();  // No JS values, object access, callback, or GC operation.
      } catch (const std::bad_alloc&) {
        work->failure = KandeloNativeWork::Failure::OutOfMemory;
      } catch (...) {
        work->failure = KandeloNativeWork::Failure::NativeException;
      }
      self->Lock();
      --work->queue->running_;
      if (work->workClass == KandeloNativeWork::WorkClass::SlowIo) --self->slowRunning;
      Append(work->queue->doneHead_, work->queue->doneTail_, work);
      self->Wake();
    }
    self->Unlock();
    return nullptr;
  }

  static unsigned ConfiguredThreads() {
    // Match the pinned libuv configuration policy for ordinary integer input:
    // default four, zero/invalid -> one, unsigned negative/max -> 1024. Its
    // fixed getenv buffer accepts at most 15 bytes. Avoid atoi overflow UB.
    const char* value = getenv("UV_THREADPOOL_SIZE");
    if (!value || strlen(value) >= 16) return 4;
    char* end;
    const long count = strtol(value, &end, 10);
    if (end == value || count == 0) return 1;
    if (count < 0 || count > 1024) return 1024;
    return static_cast<unsigned>(count);
  }

  // Called with the pool lock held. Thread creation may allocate native
  // resources; partial failure joins every started worker before returning.
  int Acquire() {
    while (changing) Wait();
    if (queues) { ++queues; return 0; }
    changing = true;
    const unsigned desired = ConfiguredThreads();
    if (desired > 4) {
      threads = static_cast<pthread_t*>(malloc(desired * sizeof(pthread_t)));
      if (!threads) threads = inlineThreads;
    }
    const unsigned count = threads == inlineThreads ? std::min(desired, 4u) : desired;
    pthread_attr_t attributes;
    int error = pthread_attr_init(&attributes);
    if (!error) {
      // Native codec stacks use the pinned libuv 8 MiB stack policy, rather
      // than silently inheriting the target's 128 KiB pthread default. This
      // allocates real guest stack memory, not another host Wasm reservation.
      error = pthread_attr_setstacksize(&attributes, 8u << 20);
      if (!error) {
        for (; threadCount < count; ++threadCount) {
          error = pthread_create(&threads[threadCount], &attributes, Worker, this);
          if (error) break;
        }
      }
      MOZ_RELEASE_ASSERT(pthread_attr_destroy(&attributes) == 0);
    }
    if (error) {
      stopping = true;
      Wake();
      Unlock();
      for (unsigned i = 0; i < threadCount; ++i) MOZ_RELEASE_ASSERT(pthread_join(threads[i], nullptr) == 0);
      Lock();
      if (threads != inlineThreads) free(threads);
      threads = inlineThreads;
      threadCount = 0;
      stopping = false;
    } else {
      queues = 1;
    }
    changing = false;
    Wake();
    return error;
  }

  void Release() {
    MOZ_RELEASE_ASSERT(queues);
    if (--queues) return;
    MOZ_RELEASE_ASSERT(!head && !slowRunning);
    changing = stopping = true;
    Wake();
    Unlock();
    for (unsigned i = 0; i < threadCount; ++i) MOZ_RELEASE_ASSERT(pthread_join(threads[i], nullptr) == 0);
    Lock();
    if (threads != inlineThreads) free(threads);
    threads = inlineThreads;
    threadCount = 0;
    changing = stopping = false;
    Wake();
  }
};

MOZ_RUNINIT static KandeloNativeWorkPool kandeloNativeWorkPool;

bool KandeloNativeWorkQueue::Submit(KandeloNativeWork* work) {
  auto& pool = kandeloNativeWorkPool;
  pool.Lock();
  if (closing_) { pool.Unlock(); return false; }
  MOZ_RELEASE_ASSERT(!work->queue && !work->next);
  work->queue = this;
  ++outstanding_;
  KandeloNativeWorkPool::Append(pool.head, pool.tail, work);
  pool.Wake();
  pool.Unlock();
  return true;
}

bool KandeloNativeWorkQueue::BeginExternal(KandeloNativeWork* work) {
  auto& pool = kandeloNativeWorkPool;
  pool.Lock();
  if (closing_) { pool.Unlock(); return false; }
  MOZ_RELEASE_ASSERT(!work->queue && !work->next && !work->externalNext);
  work->queue = this;
  work->externalNext = externalHead_;
  externalHead_ = work;
  ++outstanding_;
  ++running_;
  pool.Unlock();
  return true;
}

void KandeloNativeWorkQueue::FinishExternal(KandeloNativeWork* work) {
  auto& pool = kandeloNativeWorkPool;
  pool.Lock();
  KandeloNativeWork** link = &externalHead_;
  while (*link && *link != work) link = &(*link)->externalNext;
  MOZ_RELEASE_ASSERT(*link == work && work->queue == this && running_);
  *link = work->externalNext;
  work->externalNext = nullptr;
  --running_;
  KandeloNativeWorkPool::Append(doneHead_, doneTail_, work);
  pool.Wake();
  pool.Unlock();
}

bool KandeloNativeWorkQueue::TryCancel(KandeloNativeWork* target) {
  auto& pool = kandeloNativeWorkPool;
  pool.Lock();
  KandeloNativeWork** link = &pool.head;
  KandeloNativeWork* previous = nullptr;
  while (*link && *link != target) { previous = *link; link = &(*link)->next; }
  if (!*link || target->queue != this) { pool.Unlock(); return false; }
  *link = target->next;
  if (pool.tail == target) pool.tail = previous;
  // Cancellation of an idle request still delivers its normal completion
  // with ECANCELED. Context teardown uses the distinct silent Cancel path.
  target->failure = KandeloNativeWork::Failure::Cancelled;
  KandeloNativeWorkPool::Append(doneHead_, doneTail_, target);
  pool.Wake(); pool.Unlock(); return true;
}

bool KandeloNativeWorkQueue::HasWork() {
  auto& pool = kandeloNativeWorkPool;
  pool.Lock();
  // An active callback is already on this thread's stack. It must not keep a
  // recursively drained loop alive merely by waiting for its own return.
  const bool pending = outstanding_ > dispatchDepth_;
  pool.Unlock();
  return pending;
}

int KandeloNativeWorkQueue::Dispatch(JSContext* cx) {
  auto& pool = kandeloNativeWorkPool;
  pool.Lock();
  auto* work = KandeloNativeWorkPool::Pop(doneHead_, doneTail_);
  pool.Unlock();
  if (!work) return 0;
  ++dispatchDepth_;
  // Keep this job counted/rooted while a callback can reenter the event loop.
  bool success = true;
  if (work->cancelled) work->Cancel(cx);
  else success = work->Complete(cx);
  js_delete(work);  // Root and pin release occurs on this JS thread.
  --dispatchDepth_;
  pool.Lock();
  MOZ_RELEASE_ASSERT(outstanding_);
  --outstanding_;
  pool.Unlock();
  return success ? 1 : -1;
}

void KandeloNativeWorkQueue::Shutdown(JSContext* cx) {
  MOZ_RELEASE_ASSERT(!dispatchDepth_);
  auto& pool = kandeloNativeWorkPool;
  pool.Lock();
  closing_ = true;
  // Cancel only queued work. Running codec calls finish before roots/pins
  // are released; cancellation never frees storage out from under a worker.
  KandeloNativeWork** link = &pool.head;
  pool.tail = nullptr;
  while (*link) {
    auto* work = *link;
    if (work->queue == this) {
      *link = work->next;
      work->cancelled = true;
      KandeloNativeWorkPool::Append(doneHead_, doneTail_, work);
    } else {
      pool.tail = work;
      link = &work->next;
    }
  }
  // A DNS/event producer owns its own thread, not a pool worker. Cancel it
  // before waiting, without holding the lock its completion needs. Finished
  // jobs stay alive in doneHead_ until every producer has stopped publishing.
  while (externalHead_) {
    auto* work = externalHead_;
    pool.Unlock();
    work->Interrupt();
    pool.Lock();
    while (externalHead_ == work) pool.Wait();
  }
  while (running_) pool.Wait();
  auto* work = doneHead_;
  doneHead_ = doneTail_ = nullptr;
  pool.Unlock();
  while (work) {
    auto* next = work->next;
    work->Cancel(cx);  // No JS callback during context teardown.
    js_delete(work);
    MOZ_RELEASE_ASSERT(outstanding_);
    --outstanding_;
    work = next;
  }
  MOZ_RELEASE_ASSERT(!outstanding_ && !pins_);
  pool.Lock();
  pool.Release();
  pool.Unlock();
}

KandeloNativePin* KandeloNativeWorkQueue::Pin(JSContext* cx, JS::HandleObject view) {
  bool shared;
  JS::RootedObject buffer(cx, JS_GetArrayBufferViewBuffer(cx, view, &shared));
  if (!buffer) return nullptr;
  if (shared ? !JS::IsSharedArrayBufferObject(buffer) : !JS::IsArrayBufferObject(buffer)) {
    JS_ReportErrorASCII(cx, "Cannot access native work backing buffer");
    return nullptr;
  }
  if (!shared && JS::IsResizableArrayBufferView(view)) {
    JS_ReportErrorASCII(cx, "Resizable native work buffers require explicit backing-store leases");
    return nullptr;
  }
  // The public checked unwrap supplies one canonical identity across realms.
  // Never bypass a security wrapper to obtain a backing-store identity.
  buffer = shared ? JS::UnwrapSharedArrayBuffer(buffer) : JS::UnwrapArrayBuffer(buffer);
  if (!buffer) {
    JS_ReportErrorASCII(cx, "Cannot access native work backing buffer");
    return nullptr;
  }
  if (!shared && JS::IsDetachedArrayBufferObject(buffer)) {
    JS_ReportErrorASCII(cx, "Native work buffer is detached"); return nullptr;
  }
  for (auto* pin = pins_; pin; pin = pin->next) {
    if (pin->buffer == buffer) { ++pin->references; return pin; }
  }
  // SharedArrayRawBuffer owns nonmoving, refcounted storage, including GSAB's
  // maximum allocation. Its rooted JS owner retains that reference throughout
  // work/cancellation/teardown. Ordinary inline bytes must first move out.
  if (!shared && !JS::EnsureNonInlineArrayBufferOrView(cx, buffer)) return nullptr;
  auto* pin = js_new<KandeloNativePin>(cx, buffer.get(), shared);
  if (!pin) { JS_ReportOutOfMemory(cx); return nullptr; }
  if (!shared && !JS::PinArrayBufferOrViewLength(buffer, true)) {
    // Do not adopt an unrelated boolean pin: its original owner could release
    // it during our asynchronous work. A shared engine lease protocol is still
    // needed for that case; never claim safe ownership without it.
    js_delete(pin);
    JS_ReportErrorASCII(cx, "Backing buffer already has an external native pin");
    return nullptr;
  }
  pin->next = pins_;
  pins_ = pin;
  return pin;
}

void KandeloNativeWorkQueue::Unpin(KandeloNativePin* pin) {
  if (!pin) return;
  MOZ_RELEASE_ASSERT(pin->references);
  if (--pin->references) return;
  KandeloNativePin** link = &pins_;
  while (*link && *link != pin) link = &(*link)->next;
  MOZ_RELEASE_ASSERT(*link == pin);
  *link = pin->next;
  if (!pin->shared) MOZ_RELEASE_ASSERT(JS::PinArrayBufferOrViewLength(pin->buffer, false));
  js_delete(pin);
}

static KandeloNativeWorkQueue* KandeloGetNativeWorkQueue(JSContext* cx) {
  auto* sc = GetShellContext(cx);
  if (sc->kandeloNativeWork) return sc->kandeloNativeWork;
  auto* queue = js_new<KandeloNativeWorkQueue>();
  if (!queue) { JS_ReportOutOfMemory(cx); return nullptr; }
  auto& pool = kandeloNativeWorkPool;
  pool.Lock();
  const int error = pool.Acquire();
  pool.Unlock();
  if (error) {
    js_delete(queue);
    JS_ReportErrorASCII(cx, "Native worker pool initialization failed: %d", error);
    return nullptr;
  }
  sc->kandeloNativeWork = queue;
  return queue;
}

static bool KandeloNativeWorkPending(JSContext* cx) {
  auto* queue = GetShellContext(cx)->kandeloNativeWork;
  return queue && queue->HasWork();
}

static int KandeloDispatchNativeWork(JSContext* cx) {
  auto* queue = GetShellContext(cx)->kandeloNativeWork;
  return queue ? queue->Dispatch(cx) : 0;
}

static void KandeloShutdownNativeWork(ShellContext* sc) {
  if (!sc->kandeloNativeWork) return;
  sc->kandeloNativeWork->Shutdown(sc->cx_);
  js_delete(sc->kandeloNativeWork);
  sc->kandeloNativeWork = nullptr;
}
}  // namespace js::shell
