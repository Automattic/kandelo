// Isolated native POSIX component control: actual C dispositions/pipe records.
// This executable signals only itself; it never injects a host signal into
// a production guest and does not claim guest libc or engine validation.
#include "signal-owner.h"
#include "signal-constants.h"
#include <cstdio>
#include <thread>
#include <string>
#include <vector>
using namespace kandelo::signals;
static void Custom(int) {}
static Message Dequeue(Loop& loop){Message m{};assert(loop.Read(&m)==1);auto* w=loop.Find(m.cookie);assert(w);w->RetireMessage();return m;}
int main(){
  Loop loop;assert(!loop.Initialize());
  {Watch first(loop),second(loop);
    assert(first.referenced&&!first.signum&&!loop.HasReferences());
    assert(first.Start(0)==EINVAL);assert(first.Start(-1)==EINVAL);assert(first.Start(NSIG)==EINVAL);
    assert(first.Start(SIGKILL)==EINVAL);assert(first.Start(SIGSTOP)==EINVAL);
    assert(!first.Start(SIGUSR1));first.referenced=false;assert(!loop.HasReferences());
    assert(!second.Start(SIGUSR1));assert(loop.HasReferences());second.referenced=false;
    assert(!loop.HasReferences());assert(!::raise(SIGUSR1));
    assert(first.HasPending()&&second.HasPending());
    const auto a=Dequeue(loop),b=Dequeue(loop);assert(a.cookie!=b.cookie&&a.signum==SIGUSR1&&b.signum==SIGUSR1);
    assert(!first.HasPending()&&!second.HasPending());
    std::thread sender([]{assert(!::raise(SIGUSR1));});sender.join();
    Dequeue(loop);Dequeue(loop);
    assert(!::raise(SIGUSR1));assert(!first.Close());assert(loop.HasReferences());
    assert(!first.ReadyToClose());assert(!second.Stop());
    Dequeue(loop);Dequeue(loop);assert(first.ReadyToClose());
    assert(first.Start(SIGUSR1)==EINVAL);first.closing=false;first.closed=true;
    assert(!loop.HasReferences());Message empty{};assert(!loop.Read(&empty));
    struct sigaction action{};assert(!::sigaction(SIGUSR1,nullptr,&action));assert(action.sa_handler==SIG_DFL);
    assert(!first.Close());
  }
  {struct sigaction custom{},previous{};custom.sa_handler=Custom;assert(!sigemptyset(&custom.sa_mask));assert(!::sigaction(SIGUSR2,&custom,&previous));
    Watch watch(loop);assert(watch.Start(SIGUSR2)==EBUSY);struct sigaction actual{};assert(!::sigaction(SIGUSR2,nullptr,&actual));assert(actual.sa_handler==Custom);assert(!::sigaction(SIGUSR2,&previous,nullptr));
  }
  {Watch watch(loop);assert(!watch.Start(SIGUSR1));assert(!::raise(SIGUSR1));
    assert(!watch.Start(SIGUSR2));const auto old=Dequeue(loop);assert(old.signum==SIGUSR1&&watch.signum==SIGUSR2);assert(!watch.HasPending());
    assert(!::raise(SIGUSR2));const auto current=Dequeue(loop);assert(current.signum==SIGUSR2);assert(!watch.Close());assert(watch.ReadyToClose());
  }
  {Watch watch(loop);assert(!watch.Start(SIGUSR1));
    for(unsigned i=0;i<10000;++i)assert(!::raise(SIGUSR1));
    const auto caught=watch.caught;assert(caught>0&&caught<=10000);assert(!watch.Close());
    uint64_t drained=0;Message message{};while(loop.Read(&message)>0){assert(message.cookie==watch.cookie);watch.RetireMessage();++drained;}
    assert(drained==caught&&watch.ReadyToClose());
    std::printf("PIPE queued=%llu dropped=%llu drained=%llu\n",(unsigned long long)caught,(unsigned long long)(10000-caught),(unsigned long long)drained);
  }
  std::vector<std::string> names;
  assert(DefineConstants([&](const char* name,int value){assert(value>0&&value<NSIG);names.emplace_back(name);return true;}));
  std::printf("CONSTANTS {");bool firstConstant=true;
  assert(DefineConstants([&](const char* name,int value){std::printf("%s\"%s\":%d",firstConstant?"":",",name,value);firstConstant=false;return true;}));
  std::printf("}\n");
  assert(names.size()>25);bool aborted=false;assert(!DefineConstants([&](const char*,int){aborted=true;return false;}));assert(aborted);
  std::printf("PASS real POSIX signal owner: subscriptions, actual delivery, threads, refs, pending close, stop/replacement, invalid signals, handler preservation, pipe-full counts, compiled constants (%zu)\n",names.size());
}
