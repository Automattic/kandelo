// Actual portable owner/ledger controls. Uses a real native stat worker and
// owning-thread completion, not synthetic metadata or inline async callbacks.
#include "stat-poll.h"
#include "native-retained-memory.h"
#include "monotonic-clock.h"
#include <atomic>
#include <cassert>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <string>
#include <thread>
#include <unistd.h>
namespace F=kandelo::fs_poll;
static std::atomic<bool> failAllocation{false};
void* operator new(size_t size){if(failAllocation.exchange(false))throw std::bad_alloc();if(auto* p=std::malloc(size?size:1))return p;throw std::bad_alloc();}
void operator delete(void* p) noexcept{std::free(p);}
void operator delete(void* p,size_t) noexcept{std::free(p);}
struct Owner {
 F::uv_loop_t loop;F::uv_fs_poll_t handle;F::uv_fs_t* request=nullptr;
 std::thread worker;struct stat metadata{};int error=0,changes=0,closed=0;
};
static int Submit(F::uv_loop_t* loop,F::uv_fs_t* request){
 auto* owner=static_cast<Owner*>(loop->data);assert(!owner->request);owner->request=request;
 owner->worker=std::thread([owner,request]{owner->error=F::StatPath(request->path,&owner->metadata);});return 0;
}
static void Changed(F::uv_fs_poll_t* handle,int error,const F::uv_stat_t* previous,const F::uv_stat_t* current){
 auto* owner=static_cast<Owner*>(handle->data);assert(error==-ENOENT);assert(previous->st_size==0&&current->st_size==0);++owner->changes;F::ClosePoll(handle);
}
static void Closed(F::uv_fs_poll_t* handle){++static_cast<Owner*>(handle->data)->closed;}
static void Initialize(Owner& owner){
 owner.loop.data=&owner;owner.loop.submit=Submit;owner.loop.closed=Closed;
 F::uv_fs_poll_init(&owner.loop,&owner.handle);owner.handle.data=&owner;
 uint64_t now;assert(kandelo::clock::Nanoseconds(&now)==0);F::UpdateTime(&owner.loop,now/1000000);
}
int main(int argc,char** argv){
 assert(argc==2);std::string pattern=std::string(argv[1])+"/owner-XXXXXX";char* directory=mkdtemp(pattern.data());assert(directory);
 const std::string missing=pattern+"/missing";
 {
  Owner owner;Initialize(owner);auto account=std::make_shared<kandelo::memory::Account>();
  failAllocation=true;const int error=F::StartPoll(&owner.handle,Changed,missing.c_str(),5,account);
  assert(error==-ENOMEM&&!failAllocation);assert(!F::Active(&owner.handle)&&!owner.handle.poll_ctx&&!owner.request);
  assert(F::NextDelay(&owner.loop)==-1);auto snapshot=kandelo::memory::processLedger.Inspect();assert(snapshot.retained==0&&snapshot.pending==0&&account->Desired()==0);
 }
 for(bool stopBeforeCompletion:{false,true}){
  Owner owner;Initialize(owner);auto account=std::make_shared<kandelo::memory::Account>();std::string source=missing;
  assert(F::StartPoll(&owner.handle,Changed,source.c_str(),0,account)==0);
  assert(F::Active(&owner.handle)&&F::HasRef(&owner.handle));
  auto live=kandelo::memory::processLedger.Inspect();assert(live.retained>0&&live.pending==0&&account->Desired()==live.retained);
  // The unchanged polling context owns the copied path; mutate the caller's
  // source only after its first native request has been asynchronously queued.
  source.assign(source.size(),'x');F::Ref(&owner.handle,false);assert(!F::HasRef(&owner.handle));
  if(stopBeforeCompletion){F::ClosePoll(&owner.handle);account->Detach();auto pending=kandelo::memory::processLedger.Inspect();assert(pending.accounts==0&&pending.pending==pending.retained&&pending.retained==live.retained);}
  owner.worker.join();assert(owner.error==-ENOENT);
  F::CompleteStat(owner.request,owner.error,nullptr);owner.request=nullptr;
  assert(owner.changes==(stopBeforeCompletion?0:1));assert(F::Closing(&owner.handle));
  while(F::RunOneClose(&owner.loop)){}
  assert(owner.closed==1&&!owner.handle.poll_ctx&&!owner.loop.timers&&F::NextDelay(&owner.loop)==-1);
  auto final=kandelo::memory::processLedger.Inspect();assert(final.retained==0&&final.pending==0&&final.allocations==0&&account->Desired()==0);
 }
 assert(rmdir(directory)==0);
 std::puts("actual native stat-poll: allocation failure rollback, real owner projection, immutable context path, asynchronous missing stat, pending stop suppression, detached-account pending ownership, exact close/free retirement PASS; VM JSAPI uncompiled");
}
