// Actual portable owner + callback policy. Payload stands in for JSAPI roots;
// these controls make no SpiderMonkey, guest, GC or event-loop claim.
#include "callback-execution-stack.h"
#include "callback-scope.h"
#include "native-retained-memory.h"
#include <cassert>
#include <new>
#include <string>
using namespace kandelo;
struct Payload {
  using Info=async::ExecutionStack<Payload>::Info;
  static inline int live=0;
  memory::Allocation allocation;
  memory::Claim claim;
  std::string prior;
  Payload(Info info,const memory::AccountHandle& account,std::string prior,bool fail=false)
      : allocation(info.allocationBytes),claim(allocation.Handle(),account),prior(std::move(prior)) {
    if(fail)throw std::bad_alloc();++live;
  }
  ~Payload(){--live;}
};
using Stack=async::ExecutionStack<Payload>;
struct Host {
  Stack& stack;memory::AccountHandle account;
  unsigned depth=0;bool error=false,stopping=false,handled=true;
  int after=0,checks=0,recover=0;std::string context="prior";
  uint64_t epoch=0;
  bool Ready(){return true;}
  unsigned& Depth(){return depth;}
  bool Stopping(){return stopping;}
  bool HasError(){return error;}
  bool Before(){epoch=stack.Epoch();stack.PushScope(7,3,Stack::Owner::NativeScope,account,context);context="failing";return true;}
  bool After(){++after;stack.Pop(7,[](auto&){});return true;}
  bool Recover(){++recover;assert(stack.Id()==7&&context=="failing");if(!handled)return false;++after;stack.Clear();context="cleared";error=false;return true;}
  void Restore(){if(stack.Epoch()==epoch){if(!stack.Empty())stack.Pop(stack.Id(),[](auto&){});context="prior";}}
  bool Checkpoint(){++checks;return true;}
};
int main(){
  auto account=std::make_shared<memory::Account>();
  {Stack s;assert(s.Id()==0&&s.Trigger()==0&&s.Empty());
   s.PushJavaScript(1,0,account,"root");assert(s.Depth()==1&&s.Id()==1&&Payload::live==1&&account->Desired()>0);
   const auto bytes=account->Desired();
   try{s.PushJavaScript(9,1,account,"unused",true);assert(false);}catch(const std::bad_alloc&){}
   assert(s.Depth()==1&&s.Id()==1&&account->Desired()==bytes&&Payload::live==1);
   {auto token=s.PushNative(2,1,account,"outer");assert(s.Depth()==2&&s.Id()==2&&s.Trigger()==1);assert(token.Active()&&!token.Cleared());
    assert(s.Pop(3,[](auto&){assert(false);})==Stack::PopResult::WrongId);
    assert(s.Depth()==2);assert(token.Close());assert(!token.Active());assert(s.Id()==1&&Payload::live==2);}
   assert(Payload::live==1&&account->Desired()==bytes);
   {auto a=s.PushNative(2,1,account,"a");auto b=s.PushNative(3,2,account,"b");auto epoch=s.Epoch();
    s.Clear();assert(s.Empty()&&s.Id()==0&&s.Trigger()==0&&s.Epoch()!=epoch);
    assert(a.Cleared()&&b.Cleared()&&!a.Active()&&!b.Active());assert(Payload::live==2);assert(a.Close()&&b.Close());}
   assert(Payload::live==0&&account->Desired()==0);
   assert(s.Pop(0,[](auto&){assert(false);})==Stack::PopResult::Empty);
  }
  for(bool handled:{false,true}){Stack s;Host h{s,account};h.handled=handled;
    {async::CallbackScope<Host> scope(h);assert(scope.Enter());h.error=true;
     assert(scope.Close(false)==handled);assert(scope.Close(false)==handled);
     assert(h.recover==1&&h.after==(handled?1:0)&&h.checks==0);assert(h.context==(handled?"cleared":"prior"));}
    assert(h.depth==0);s.Clear();}
  {Stack s;Host h{s,account};{async::CallbackScope<Host> scope(h);assert(scope.Enter());assert(scope.Close());assert(h.after==1&&h.checks==1&&h.context=="prior");}assert(h.recover==0&&h.depth==0);}
  {Stack s;Host h{s,account};{async::CallbackScope<Host> scope(h);assert(scope.Enter());h.stopping=true;h.error=true;assert(!scope.Close(false));}assert(h.recover==0&&h.after==0&&h.checks==0);s.Clear();}
  {Stack s;Host h{s,account};h.depth=1;{async::CallbackScope<Host> scope(h);assert(scope.Enter());h.error=true;assert(!scope.Close(false));assert(h.recover==0&&h.after==0&&h.context=="prior"&&h.error&&s.Empty());}assert(h.depth==1);}
  assert(Payload::live==0&&account->Desired()==0);account->Detach();
}
