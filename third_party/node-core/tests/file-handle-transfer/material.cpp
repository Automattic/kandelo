#include "file-handle-owner.h"
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <memory>
#include <thread>
#define MOZ_RELEASE_ASSERT(value) do { if (!(value)) std::abort(); } while (false)
#include "actual-transfer.inc"
using Lease=kandelo::nodefs::FileHandleLease;
static int Open(){char name[]="/tmp/kandelo-file-transfer-XXXXXX";int fd=mkstemp(name);assert(fd>=0);assert(unlink(name)==0);return fd;}
static bool Alive(int fd){return fcntl(fd,F_GETFD)>=0;}
int main(){unsigned groups=0;
 {int fd=Open();{Lease source(fd);auto sidecar=std::make_unique<KandeloFileHandleTransfer>();assert(sidecar->descriptor.Adopt(source));assert(source.Fd()==-1&&Alive(fd));}assert(!Alive(fd));++groups;}
 {int fd=Open();{Lease source(fd);KandeloFileHandleTransfer sidecar;assert(sidecar.descriptor.Adopt(source));sidecar.Abort();assert(!Alive(fd));int replacement=Open();if(replacement!=fd){assert(dup2(replacement,fd)==fd);assert(close(replacement)==0);}sidecar.Abort();assert(Alive(fd));}assert(Alive(fd));assert(close(fd)==0);++groups;}
 {int fd=Open();Lease source(fd),receiver;assert(write(fd,"abc",3)==3);assert(lseek(fd,0,SEEK_SET)==0);int alias=dup(fd);assert(alias>=0);{KandeloFileHandleTransfer sidecar;assert(sidecar.descriptor.Adopt(source));assert(receiver.Adopt(sidecar.descriptor));}char b;assert(read(alias,&b,1)==1&&b=='a');assert(read(receiver.Fd(),&b,1)==1&&b=='b');assert(receiver.Fd()==fd&&Alive(fd));assert(close(alias)==0);assert(receiver.Close()==0&&!Alive(fd));++groups;}
 {int fd=Open();Lease source(fd);auto sidecar=std::make_unique<KandeloFileHandleTransfer>();assert(sidecar->descriptor.Adopt(source));std::thread receiver([material=std::move(sidecar)]()mutable{Lease fd;assert(fd.Adopt(material->descriptor));material.reset();assert(Alive(fd.Fd()));assert(fd.Close()==0);});receiver.join();assert(!Alive(fd));++groups;}
 {int fd=Open();Lease source(fd),receiver,actualCloseOwner;{KandeloFileHandleTransfer material;assert(material.descriptor.Adopt(source));assert(receiver.Adopt(material.descriptor));assert(actualCloseOwner.Adopt(receiver));material.Abort();assert(receiver.Close()==0&&Alive(fd));}std::thread closing([&]{assert(actualCloseOwner.Close()==0);});closing.join();assert(!Alive(fd));++groups;}
 std::printf("{\"groups\":%u,\"failed\":0,\"scope\":\"Exact extracted new native transfer-material struct and real production lease over native descriptors/OFD/thread; release-assert dependency supplied, fatal path not executed, no SC/JSAPI/packet proof\"}\n",groups);
}
