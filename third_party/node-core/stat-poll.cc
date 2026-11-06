// Real native stat/timer/close port for the unchanged pinned fs-poll.c.
#include "stat-poll.h"
#include "native-retained-memory.h"
#include <assert.h>
#include <errno.h>
#include <limits>
#include <new>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
namespace kandelo::fs_poll {
#include "upstream/stat-poll/deps/uv/src/fs-poll.c"
#include "upstream/stat-poll/deps/uv/src/to-stat.inc"
namespace {
constexpr unsigned Closed = 16, PollClose = 32;
thread_local kandelo::memory::AccountHandle allocatorAccount;
struct alignas(std::max_align_t) AllocationHeader {
  kandelo::memory::Allocation material;
  kandelo::memory::Claim claim;
  explicit AllocationHeader(size_t bytes) : material(bytes),claim(material.Handle(),allocatorAccount) {}
};
void RemoveTimer(uv_timer_t* timer) {
  if (!(timer->flags & UV_HANDLE_ACTIVE)) return;
  if (timer->previous) timer->previous->next=timer->next;
  else timer->loop->timers=timer->next;
  if (timer->next) timer->next->previous=timer->previous;
  timer->next=timer->previous=nullptr;timer->flags&=~UV_HANDLE_ACTIVE;
}
void QueueClose(uv_handle_t* handle) {
  auto* loop=handle->loop;handle->closingNext=nullptr;
  if(loop->closingTail)loop->closingTail->closingNext=handle;
  else loop->closing=handle;
  loop->closingTail=handle;
}
}
static poll_ctx* uv__calloc(size_t count,size_t size) {
  if (count && size > (SIZE_MAX-sizeof(AllocationHeader))/count) return nullptr;
  const size_t bytes=count*size+sizeof(AllocationHeader);
  void* memory=calloc(1,bytes);if(!memory)return nullptr;
  try { auto* header=new(memory)AllocationHeader(bytes);return reinterpret_cast<poll_ctx*>(header+1); }
  catch(const std::bad_alloc&){free(memory);return nullptr;}
}
static void uv__free(void* memory) {
  if(!memory)return;
  auto* header=static_cast<AllocationHeader*>(memory)-1;
  header->~AllocationHeader();free(header);
}
static int uv_timer_init(uv_loop_t* loop,uv_timer_t* timer) {
  uv__handle_init(loop,timer,0);return 0;
}
static int uv_timer_start(uv_timer_t* timer,uv_timer_cb cb,uint64_t timeout,uint64_t repeat) {
  assert(!repeat && !(timer->flags&UV_HANDLE_CLOSING));
  RemoveTimer(timer);auto* loop=timer->loop;
  timer->callback=cb;timer->due=timeout>UINT64_MAX-loop->time?UINT64_MAX:loop->time+timeout;
  timer->order=loop->order++;
  timer->previous=nullptr;timer->next=loop->timers;
  if(timer->next)timer->next->previous=timer;
  loop->timers=timer;timer->flags|=UV_HANDLE_ACTIVE;return 0;
}
static void uv_close(uv_handle_t* handle,uv_close_cb callback) {
  assert(!(handle->flags&UV_HANDLE_CLOSING));
  RemoveTimer(handle);handle->flags|=UV_HANDLE_CLOSING;
  handle->closeCallback=callback;QueueClose(handle);
}
static void uv__poll_close_pending(uv_fs_poll_t* handle) {
  assert(handle->flags&UV_HANDLE_CLOSING);
  handle->flags|=PollClose;QueueClose(handle);
}
int StartPoll(uv_fs_poll_t* handle,uv_fs_poll_cb callback,const char* path,unsigned interval,
              const kandelo::memory::AccountHandle& account) {
  struct Scope {
    kandelo::memory::AccountHandle previous;
    explicit Scope(const kandelo::memory::AccountHandle& account)
        : previous(std::move(allocatorAccount)) { allocatorAccount=account; }
    ~Scope() { allocatorAccount=std::move(previous); }
  } scope(account);
  return uv_fs_poll_start(handle,callback,path,interval);
}
void ClosePoll(uv_fs_poll_t* handle) {
  if(handle->flags&UV_HANDLE_CLOSING)return;
  handle->flags|=UV_HANDLE_CLOSING;uv__fs_poll_close(handle);
}
void Ref(uv_fs_poll_t* handle,bool referenced) noexcept {
  if(referenced)handle->flags|=UV_HANDLE_REF;else handle->flags&=~UV_HANDLE_REF;
}
bool HasRef(const uv_fs_poll_t* handle) noexcept {return handle->flags&UV_HANDLE_REF;}
bool Active(const uv_fs_poll_t* handle) noexcept {return handle->flags&UV_HANDLE_ACTIVE;}
bool OwnsRequest(const uv_fs_poll_t* handle,const uv_fs_t* request) noexcept {
  for(auto* context=handle->poll_ctx;context;context=context->previous)
    if(&context->fs_req==request)return true;
  return false;
}
bool Closing(const uv_fs_poll_t* handle) noexcept {return handle->flags&UV_HANDLE_CLOSING;}
void UpdateTime(uv_loop_t* loop,uint64_t now) noexcept {loop->time=now;}
bool RunOneTimer(uv_loop_t* loop) {
  uv_timer_t* next=nullptr;
  for(auto* timer=loop->timers;timer;timer=timer->next)
    if(timer->due<=loop->time && (!next || timer->due<next->due ||
       (timer->due==next->due && timer->order<next->order)))next=timer;
  if(!next)return false;
  RemoveTimer(next);next->callback(next);return true;
}
bool RunOneClose(uv_loop_t* loop) {
  auto* handle=loop->closing;if(!handle)return false;
  loop->closing=handle->closingNext;if(!loop->closing)loop->closingTail=nullptr;
  handle->flags|=Closed;
  if(handle->flags&PollClose){assert(loop->closed);loop->closed(handle);}
  else handle->closeCallback(handle);
  return true;
}
int64_t NextDelay(const uv_loop_t* loop) noexcept {
  if(loop->closing)return 0;
  uint64_t due=UINT64_MAX;bool found=false;
  for(auto* timer=loop->timers;timer;timer=timer->next){if(timer->due<due)due=timer->due;found=true;}
  if(!found)return -1;
  const uint64_t delay=due>loop->time?due-loop->time:0;
  return delay>uint64_t(INT64_MAX)?INT64_MAX:int64_t(delay);
}
int StatPath(const char* path,struct stat* result) noexcept {
  int status;
  do { status=::stat(path,result); } while(status<0 && errno==EINTR);
  return status<0?-errno:0;
}
void CompleteStat(uv_fs_t* request,int error,const struct stat* metadata) {
  request->result=error;
  if(!error){
    assert(metadata);
    struct stat copy=*metadata;
    uv__to_stat(&copy,&request->statbuf);
  }
  request->callback(request);
}
}  // namespace kandelo::fs_poll
