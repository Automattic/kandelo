#include "wasi-context.h"
#include <cassert>
#include <cstdio>
int main() {
  char name[] = "/tmp/kandelo-wasi-component-XXXXXX";
  int fd = mkstemp(name); assert(fd >= 0); unlink(name);
  int stdio[] = {fd, fd, fd};
  auto account = std::make_shared<kandelo::memory::Account>();
  const auto baseline = account->Desired();
  {
    kandelo::wasi::Context context({"hello", "world"}, {"A=B"}, {"/mapped", "/tmp"}, stdio, account);
    std::vector<uint8_t> data(65536, 0xab);
    kandelo::wasi::Memory mem{data.data(), data.size(), false};
    assert(context.Strings(mem,false,true,0,4)==0); assert(mem.Read32(0)==2); assert(mem.Read32(4)==12);
    assert(context.Strings(mem,false,false,16,32)==0); assert(mem.Read32(16)==32); assert(!memcmp(data.data()+32,"hello\0world\0",12));
    assert(context.Fdstat(mem,0,64)==0); assert(data[64]==4); assert(data[65]==0xab); assert(data[68]==0xab);
    assert(context.Prestat(mem,3,96)==0); assert(mem.Read32(100)==7); assert(data[97]==0xab);
    assert(context.PrestatName(mem,3,104,7)==0); assert(!memcmp(data.data()+104,"/mapped",7));
    memcpy(data.data()+128,"payload",7); mem.Write32(0,128); mem.Write32(4,7);
    assert(context.Io(mem,1,0,1,0,16,true,false)==0); assert(mem.Read32(16)==7);
    assert(context.Seek(mem,0,0,UVWASI_WHENCE_SET,24)==0);
    mem.Write32(0,160); assert(context.Io(mem,0,0,1,0,16,false,false)==0); assert(!memcmp(data.data()+160,"payload",7));
    assert(context.SetRights(0,UVWASI_RIGHT_FD_FDSTAT_SET_FLAGS,0)==0);
    assert(context.Io(mem,0,0,1,0,16,false,false)==UVWASI_ENOTCAPABLE);
    assert(context.SetRights(0,UVWASI_RIGHT_FD_READ,0)==UVWASI_ENOTCAPABLE);
    assert(context.Strings(mem,false,true,UINT32_MAX,0)==UVWASI_EOVERFLOW);
    assert(context.Random(mem,256,500)==0); assert(context.Clock(mem,UVWASI_CLOCK_MONOTONIC,32,false)==0);
    assert(context.Yield()==0); assert(context.Filestat(mem,1,512)==0);
    assert(context.SetSize(1,3)==0); struct stat st; assert(fstat(fd,&st)==0 && st.st_size==3);
    assert(context.Close(3)==0); assert(context.Prestat(mem,3,96)==UVWASI_EBADF);
    assert(account->Desired()>baseline);
  }
  assert(account->Desired()==baseline); assert(fcntl(fd,F_GETFL)>=0); close(fd);
  puts("owner smoke: pass");
}
