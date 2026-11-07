#include "socket-owner.h"
#include "retained-backing-store.h"
#include <arpa/inet.h>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <new>
#include <poll.h>
static bool failAllocation;
void* operator new(size_t size) {
  if (std::exchange(failAllocation, false)) throw std::bad_alloc();
  if (void* p = std::malloc(size ? size : 1)) return p;
  throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, size_t) noexcept { std::free(p); }
using kandelo::socket::Owner;
using kandelo::socket::Lease;
using kandelo::socket::Shutdown;
using Write = kandelo::socket::Write<kandelo::buffer::SpanHandle>;
struct Pair {
  Owner owner{7}; int peer = -1;
  Pair() {
    int listener=::socket(AF_INET, SOCK_STREAM, 0); assert(listener>=0);
    sockaddr_in addr{};addr.sin_family=AF_INET;addr.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    assert(::bind(listener,reinterpret_cast<sockaddr*>(&addr),sizeof(addr))==0);
    socklen_t size=sizeof(addr);assert(::getsockname(listener,reinterpret_cast<sockaddr*>(&addr),&size)==0);
    assert(::listen(listener,4)==0);peer=::socket(AF_INET,SOCK_STREAM,0);assert(peer>=0);
    assert(::connect(peer,reinterpret_cast<sockaddr*>(&addr),sizeof(addr))==0);
    int accepted=::accept(listener,nullptr,nullptr);assert(accepted>=0);::close(listener);
    assert(::fcntl(accepted,F_SETFL,::fcntl(accepted,F_GETFL)|O_NONBLOCK)==0);
    assert(::fcntl(peer,F_SETFL,::fcntl(peer,F_GETFL)|O_NONBLOCK)==0);
    Lease lease(accepted);assert(owner.Adopt(lease));
  }
  ~Pair(){owner.Close();if(peer>=0)::close(peer);}
};
static auto backing(size_t size) {
  auto* data=static_cast<uint8_t*>(std::malloc(size));assert(data);std::memset(data,0x57,size);
  auto store=kandelo::buffer::BackingStore::Prepare(data,size,
    [](void* p,size_t,void*)noexcept{std::free(p);});store->Commit();
  return kandelo::buffer::BackingSpan::Capture(std::move(store),0,size);
}
int main() {
  size_t groups=0;
  { Pair p;Shutdown q(7);assert(p.owner.QueueShutdown(q)==0&&q.queued&&!q.complete);
    uint8_t byte;assert(::recv(p.peer,&byte,1,0)<0&&(errno==EAGAIN||errno==EWOULDBLOCK));
    assert(!p.owner.ProgressShutdown(q,true)&&!q.complete);
    assert(p.owner.ProgressShutdown(q,false)&&q.complete&&q.error==0);
    pollfd fd{p.peer,POLLIN,0};assert(::poll(&fd,1,1000)==1);assert(::read(p.peer,&byte,1)==0);groups++;
  }
  { Pair p;Shutdown a(7),b(7);assert(p.owner.QueueShutdown(a)==0);assert(p.owner.QueueShutdown(b)==ENOTCONN);
    Write later(backing(8));assert(p.owner.ValidateWrite(later)==EPIPE);assert(p.owner.ProgressWrite(later));assert(later.error==EPIPE);groups++;
  }
  { Pair p;int size=4096;assert(::setsockopt(p.owner.Fd(),SOL_SOCKET,SO_SNDBUF,&size,sizeof(size))==0);
    Write prior(backing(2*1024*1024));assert(p.owner.ValidateWrite(prior)==0);p.owner.ProgressWrite(prior);
    assert(!prior.complete);Shutdown q(7);assert(p.owner.QueueShutdown(q)==0);assert(!p.owner.ProgressShutdown(q,true));
    size_t received=0;uint8_t bytes[65536];
    for(size_t turn=0;turn<200000&&(!prior.complete||received<prior.totalBytes);++turn){
      if(!prior.complete)p.owner.ProgressWrite(prior,true);
      ssize_t n=::read(p.peer,bytes,sizeof(bytes));
      if(n>0){for(ssize_t i=0;i<n;++i)assert(bytes[i]==0x57);received+=size_t(n);}
      else assert(n<0&&(errno==EAGAIN||errno==EWOULDBLOCK));
    }
    assert(prior.complete&&prior.error==0&&received==prior.totalBytes);
    assert(p.owner.ProgressShutdown(q,false)&&q.error==0);pollfd fd{p.peer,POLLIN,0};assert(::poll(&fd,1,1000)==1);assert(::read(p.peer,bytes,1)==0);groups++;
  }
  { Pair p;const int old=p.owner.Fd();Shutdown q(7);assert(p.owner.QueueShutdown(q)==0);p.owner.Close();
    int replacement[2];assert(::socketpair(AF_UNIX,SOCK_STREAM,0,replacement)==0);
    // The real fd allocator may put the peer at old. Preserve that actual
    // endpoint before dup2 rather than closing it through an alias.
    if(replacement[1]==old)std::swap(replacement[0],replacement[1]);
    if(replacement[0]!=old){assert(::dup2(replacement[0],old)==old);::close(replacement[0]);}
    assert(p.owner.ProgressShutdown(q,false)&&q.error==ECANCELED);
    assert(::write(old,"x",1)==1);char byte;assert(::read(replacement[1],&byte,1)==1&&byte=='x');
    ::close(old);::close(replacement[1]);groups++;
  }
  { Owner empty(9);Shutdown q(9);assert(empty.QueueShutdown(q)==ENOTCONN&&!q.queued);groups++; }
  { Owner unconnected(10);Lease fd(::socket(AF_INET,SOCK_STREAM,0));assert(fd.Fd()>=0&&unconnected.Adopt(fd));
    Shutdown q(10);assert(unconnected.QueueShutdown(q)==0);assert(unconnected.ProgressShutdown(q,false));assert(q.error==ENOTCONN);groups++;
  }
  { Pair p;const auto initial=kandelo::memory::processLedger.Inspect();bool threw=false;failAllocation=true;
    try{auto q=std::make_unique<Shutdown>(7);}catch(const std::bad_alloc&){threw=true;}assert(threw);
    const auto after=kandelo::memory::processLedger.Inspect();assert(after.allocations==initial.allocations);
    Write before(backing(8));assert(p.owner.ValidateWrite(before)==0);
    {auto q=std::make_unique<Shutdown>(7);assert(p.owner.QueueShutdown(*q)==0);assert(p.owner.ProgressShutdown(*q,false)&&q->error==0);}
    groups++;
  }
  std::printf("{\"groups\":%zu,\"scope\":\"Actual portable Owner/Shutdown/Write and native TCP/POSIX/memory ledger; no guest JSAPI callback dispatch\"}\n",groups);
  assert(groups==7);
}
