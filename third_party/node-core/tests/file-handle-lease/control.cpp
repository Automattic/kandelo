#include "file-handle-owner.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <fcntl.h>
#include <thread>
#include <type_traits>
using kandelo::nodefs::FileHandleLease;
static int Open() { char name[]="/tmp/kandelo-fh-lease-XXXXXX"; int fd=mkstemp(name);assert(fd>=0);assert(unlink(name)==0);return fd; }
static bool OpenFd(int fd) { errno=0;return fcntl(fd,F_GETFD)>=0; }
int main() {
 static_assert(!std::is_copy_constructible_v<FileHandleLease>);
 static_assert(!std::is_copy_assignable_v<FileHandleLease>);
 static_assert(std::is_nothrow_move_constructible_v<FileHandleLease>);
 unsigned groups=0;
 // Ordinary abandonment and repeated explicit close consume once, including ABA reuse.
 {int fd=Open();{FileHandleLease lease(fd);assert(lease.Fd()==fd);assert(lease.Close()==0);assert(lease.Fd()==-1);assert(!OpenFd(fd));int another=Open();if(another!=fd){assert(dup2(another,fd)==fd);assert(close(another)==0);}assert(OpenFd(fd));assert(lease.Close()==0);}assert(OpenFd(fd));assert(close(fd)==0);++groups;}
 // Admission/move never duplicates or reopens: an existing dup observes the same OFD.
 {int fd=Open();FileHandleLease source(fd),destination;assert(write(fd,"abc",3)==3);assert(lseek(fd,0,SEEK_SET)==0);int alias=dup(fd);assert(alias>=0);assert(destination.Adopt(source));assert(source.Fd()==-1&&destination.Fd()==fd);char c;assert(read(alias,&c,1)==1&&c=='a');assert(read(destination.Fd(),&c,1)==1&&c=='b');assert(close(alias)==0);++groups;}
 // Failed adoption cannot overwrite either live owner; canceled unperformed work returns it.
 {FileHandleLease parent(Open()),occupied(Open()),work;int fd=parent.Fd(),other=occupied.Fd();assert(!occupied.Adopt(parent));assert(parent.Fd()==fd&&occupied.Fd()==other);assert(work.Adopt(parent));assert(parent.Fd()==-1&&work.Fd()==fd);assert(parent.Adopt(work));assert(parent.Fd()==fd&&work.Fd()==-1);++groups;}
 // A performed native close owns no descriptor to restore after thread completion.
 {FileHandleLease parent(Open()),work;int fd=parent.Fd();assert(work.Adopt(parent));std::thread thread([&]{assert(work.Close()==0);});thread.join();assert(parent.Fd()==-1&&work.Fd()==-1&&!OpenFd(fd));assert(!parent.Adopt(work));int replacement=Open();if(replacement!=fd){assert(dup2(replacement,fd)==fd);assert(close(replacement)==0);}assert(work.Close()==0&&OpenFd(fd));assert(close(fd)==0);++groups;}
 // Actual syscall error is retained, ownership still consumed and destructor does not retry.
 {int fd=Open();FileHandleLease lease(fd);assert(close(fd)==0);assert(lease.Close()==-EBADF);int replacement=Open();if(replacement!=fd){assert(dup2(replacement,fd)==fd);assert(close(replacement)==0);}assert(lease.Close()==0&&OpenFd(fd));assert(close(fd)==0);++groups;}
 // Real destructor closes an unconsumed lease.
 {int fd=Open();{FileHandleLease lease(fd);}assert(!OpenFd(fd));++groups;}
 std::printf("{\"groups\":%u,\"failed\":0,\"scope\":\"Actual portable FileHandleLease and real native descriptors/OFD/thread close only; not Kandelo JSAPI/work queue\"}\n",groups);
}
