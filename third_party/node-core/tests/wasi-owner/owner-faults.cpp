// Actual Context construction/cleanup and original-memory write batching.
#include <atomic>
#include <cstdlib>
#include <new>
static long fail_after=-1;
void* operator new(std::size_t bytes) {
  if(fail_after==0)throw std::bad_alloc();
  if(fail_after>0)--fail_after;
  if(void* result=std::malloc(bytes?bytes:1))return result;
  throw std::bad_alloc();
}
void operator delete(void* value) noexcept {std::free(value);}
void operator delete(void* value,std::size_t) noexcept {std::free(value);}
#include "wasi-context.h"
#include <cassert>
#include <cstdio>
static int OpenFds(){int result=0;for(int fd=0;fd<256;fd++)if(fcntl(fd,F_GETFD)>=0)result++;return result;}
int main(){
  char file[]="/tmp/kandelo-wasi-fault-XXXXXX";int fd=mkstemp(file);assert(fd>=0);unlink(file);int stdio[3]={fd,fd,fd};
  auto account=std::make_shared<kandelo::memory::Account>();const auto baseline=account->Desired();
  const int fdBaseline=OpenFds();unsigned failures=0,successes=0;
  // Includes failures before/after both actual preopen opens/admissions. No
  // claimed/retained capacity or owned descriptor survives failed admission.
  for(long at=0;at<80;++at){
    fail_after=at;
    try{auto context=std::make_unique<kandelo::wasi::Context>(std::vector<std::string>{std::string(100,'a'),"b"},std::vector<std::string>{std::string(100,'E')},std::vector<std::string>{"/a","/tmp","/b","/tmp"},stdio,account);++successes;}
    catch(const std::bad_alloc&){++failures;}
    fail_after=-1;assert(OpenFds()==fdBaseline);assert(account->Desired()==baseline);assert(fcntl(fd,F_GETFD)>=0);
  }
  assert(failures>15&&successes>0);
  {
    kandelo::wasi::Context context({}, {}, {}, stdio, account);
    const long iovmax=sysconf(_SC_IOV_MAX);assert(iovmax>0);const uint32_t count=iovmax+3;
    std::vector<uint8_t> memory(count*9+32,0);kandelo::wasi::Memory m{memory.data(),memory.size(),false};
    for(uint32_t i=0;i<count;++i){m.Write32(i*8,count*8+i);m.Write32(i*8+4,1);memory[count*8+i]=static_cast<uint8_t>(i);}
    assert(context.Io(m,1,0,count,0,count*9,true,false)==0);assert(m.Read32(count*9)==count);
    assert(lseek(fd,0,SEEK_SET)==0);std::vector<uint8_t> got(count);assert(read(fd,got.data(),count)==count);
    for(uint32_t i=0;i<count;++i)assert(got[i]==static_cast<uint8_t>(i));
    auto desired=account->Desired();fail_after=0;
    try{context.Io(m,1,0,count,0,count*9,true,false);assert(false);}catch(const std::bad_alloc&){}
    fail_after=-1;assert(account->Desired()==desired);
  }
  assert(account->Desired()==baseline);assert(OpenFds()==fdBaseline);close(fd);
  printf("owner faults: %u failed allocations cleaned, %u successful admissions; original-memory iov batching pass\n",failures,successes);
}
