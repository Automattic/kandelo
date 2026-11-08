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
#include <string>
#include <set>
#include <sys/stat.h>
static int OpenFds(){int result=0;for(int fd=0;fd<256;fd++)if(fcntl(fd,F_GETFD)>=0)result++;return result;}
int main(int argc,char**argv){
  assert(argc==2);const std::string root=argv[1];char* resolved=realpath(root.c_str(),nullptr);assert(resolved&&root==resolved);free(resolved);
  const int initialFds=OpenFds();unsigned groups=0;
  std::string file=root+"/allocation-XXXXXX";int fd=mkstemp(file.data());assert(fd>=0);unlink(file.c_str());int stdio[3]={fd,fd,fd};
  auto account=std::make_shared<kandelo::memory::Account>();const auto baseline=account->Desired();
  const int fdBaseline=OpenFds();unsigned failures=0,successes=0;
  // Includes failures before/after both actual preopen opens/admissions. No
  // claimed/retained capacity or owned descriptor survives failed admission.
  for(long at=0;at<80;++at){
    fail_after=at;
    try{auto context=std::make_unique<kandelo::wasi::Context>(std::vector<std::string>{std::string(100,'a'),"b"},std::vector<std::string>{std::string(100,'E')},std::vector<std::string>{"/a",root,"/b",root},stdio,account);++successes;}
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
  using namespace kandelo::wasi;
  auto open=[&](const char*name){const std::string path=root+"/"+name;const int out=::open(path.c_str(),O_CREAT|O_EXCL|O_RDWR,0600);assert(out>=0);return out;};
  {
    int a=open("allocate"),b=open("allocate-out"),c=open("allocate-err"),stdio3[]={a,b,c};
    {Context context({}, {}, {}, stdio3, account);struct stat st;
     assert(context.Allocate(0,7,8)==0);assert(fstat(a,&st)==0&&st.st_size==15);
     assert(context.Allocate(0,1,1)==0);assert(fstat(a,&st)==0&&st.st_size==15);
     assert(context.Allocate(0,UINT64_MAX,1)==0);assert(context.Allocate(999,0,1)==UVWASI_EBADF);
     assert(context.SetRights(0,0,0)==0);assert(context.Allocate(0,0,1)==UVWASI_ENOTCAPABLE);}
    close(a);close(b);close(c);assert(account->Desired()==baseline);assert(OpenFds()==initialFds);++groups;
  }
  {
    int a=open("times"),b=open("times-out"),c=open("times-err"),stdio3[]={a,b,c};
    {Context context({}, {}, {}, stdio3, account);struct stat st;
     assert(context.SetTimes(999,0,0,3)==UVWASI_EINVAL);assert(context.SetTimes(0,1700000000123456789ULL,1700000123987654321ULL,5)==0);
     assert(fstat(a,&st)==0);
#if defined(__APPLE__)
     assert(st.st_atimespec.tv_sec==1700000000&&st.st_atimespec.tv_nsec==0&&st.st_mtimespec.tv_sec==1700000123&&st.st_mtimespec.tv_nsec==0);
#else
     assert(st.st_atim.tv_sec==1700000000&&st.st_atim.tv_nsec==0&&st.st_mtim.tv_sec==1700000123&&st.st_mtim.tv_nsec==0);
#endif
     assert(context.SetRights(0,0,0)==0);assert(context.SetTimes(0,0,0,5)==UVWASI_ENOTCAPABLE);}
    close(a);close(b);close(c);assert(account->Desired()==baseline);assert(OpenFds()==initialFds);++groups;
  }
  {
    int a=open("renumber"),b=open("renumber-out"),c=open("renumber-err"),stdio3[]={a,b,c};
    int replacement=-1;
    {Context context({}, {}, {"/real",root}, stdio3, account);std::vector<uint8_t> data(64,0xaa);Memory m{data.data(),data.size(),false};
     assert(context.Renumber(999,999)==0);assert(context.Renumber(999,1)==UVWASI_EBADF);assert(fcntl(b,F_GETFD)>=0);
     assert(context.Renumber(3,1)==0);assert(fcntl(b,F_GETFD)<0&&errno==EBADF);replacement=open("reused-destination");assert(replacement==b);b=-1;
     assert(context.Prestat(m,3,0)==UVWASI_EBADF);assert(context.Prestat(m,1,0)==0&&m.Read32(4)==5);
     assert(context.PrestatName(m,1,16,5)==0&&!memcmp(data.data()+16,"/real",5));
     assert(account->Desired()>baseline);}
    assert(fcntl(replacement,F_GETFD)>=0&&fcntl(a,F_GETFD)>=0&&fcntl(c,F_GETFD)>=0);close(a);close(c);close(replacement);assert(b==-1);assert(account->Desired()==baseline);assert(OpenFds()==initialFds);++groups;
  }
  {
    int a=open("renumber-fail"),b=open("renumber-fail-out"),c=open("renumber-fail-err"),stdio3[]={a,b,c};
    {Context context({}, {}, {}, stdio3, account);close(b);b=-1;std::vector<uint8_t> data(32,0xaa);Memory m{data.data(),data.size(),false};
     assert(context.Renumber(0,1)==UVWASI_EBADF);assert(context.Fdstat(m,0,0)==0);assert(fcntl(a,F_GETFD)>=0);}
    close(a);close(c);assert(account->Desired()==baseline);assert(OpenFds()==initialFds);++groups;
  }
  {
    int a=open("same-raw-fd"),stdio3[]={a,a,a};
    {Context context({}, {}, {}, stdio3, account);std::vector<uint8_t> data(32,0xaa);Memory m{data.data(),data.size(),false};
     assert(context.Renumber(0,1)==0);assert(context.Fdstat(m,0,0)==UVWASI_EBADF);assert(context.Fdstat(m,1,0)==UVWASI_EBADF);}
    assert(fcntl(a,F_GETFD)<0&&errno==EBADF);assert(account->Desired()==baseline);assert(OpenFds()==initialFds);++groups;
  }
  {
    const std::string directory=root+"/directory";assert(mkdir(directory.c_str(),0700)==0);const std::string entry=directory+"/alpha";int temp=::open(entry.c_str(),O_CREAT|O_EXCL|O_WRONLY,0600);assert(temp>=0);close(temp);
    int a=open("readdir"),b=open("readdir-out"),c=open("readdir-err"),stdio3[]={a,b,c};
    {Context context({}, {}, {"/directory",directory}, stdio3, account);std::vector<uint8_t> data(128,0xa5);Memory m{data.data(),data.size(),true};const int before=OpenFds();
     for(int i=0;i<40;i++){std::fill(data.begin(),data.end(),0xa5);assert(context.Readdir(m,3,32,25,0,0)==0);assert(m.Read32(0)==25);assert(data[32+21]==0xa5&&data[32+22]==0xa5&&data[32+23]==0xa5&&data[32+24]=='a');assert(OpenFds()==before);}
     std::fill(data.begin(),data.end(),0xa5);assert(context.Readdir(m,3,32,23,0,0)==0&&m.Read32(0)==23);for(int i=32;i<55;i++)assert(data[i]==0xa5);
     assert(context.Readdir(m,3,32,25,UINT64_MAX,0)==0&&m.Read32(0)==0);assert(OpenFds()==before);
     assert(context.SetRights(3,0,0)==0);m.Write32(0,0xf1f2f3f4);assert(context.Readdir(m,3,32,25,0,0)==UVWASI_ENOTCAPABLE&&m.Read32(0)==0xf1f2f3f4);}
    close(a);close(b);close(c);assert(account->Desired()==baseline);assert(OpenFds()==initialFds);++groups;
  }
  assert(groups==6&&account->Desired()==baseline&&OpenFds()==initialFds);
  printf("{\"fdGroups\":%u,\"allocatorFaultsCleaned\":%u,\"successfulAdmissions\":%u,\"fdLeaks\":0,\"claimedCapacityRestored\":true,\"guestExecution\":false}\n",groups,failures,successes);
}
