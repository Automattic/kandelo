#include "listener-owner.h"
#include <cassert>
#include <cerrno>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <cstdio>
using kandelo::listener::Owner;
static int socketFd() { const int fd=socket(AF_INET,SOCK_STREAM,0);assert(fd>=0);return fd; }
int main() {
  unsigned groups=0;
  { Owner owner(1);assert(owner.Fd()==-1&&!owner.Closed()&&owner.Referenced());owner.Ref(false);assert(!owner.Referenced());assert(owner.Generation()==1);++groups; }
  int admitted=-1;
  { Owner owner(2);const int fd=socketFd();sockaddr_in address{};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    assert(bind(fd,reinterpret_cast<sockaddr*>(&address),sizeof(address))==0);assert(listen(fd,8)==0);assert(owner.Admit(fd));assert(owner.Fd()==fd);admitted=fd;++groups;
    socklen_t size=sizeof(address);assert(getsockname(owner.Fd(),reinterpret_cast<sockaddr*>(&address),&size)==0);
    const int peer=socketFd();assert(connect(peer,reinterpret_cast<sockaddr*>(&address),size)==0);const int accepted=accept(owner.Fd(),nullptr,nullptr);assert(accepted>=0);
    const char byte='x';assert(write(peer,&byte,1)==1);char out;assert(read(accepted,&out,1)==1&&out=='x');close(accepted);close(peer);++groups;
    const int rejected=socketFd();assert(!owner.Admit(rejected));assert(fcntl(rejected,F_GETFD)>=0);close(rejected);++groups;
    owner.Close();assert(owner.Closed()&&owner.Fd()==-1);assert(fcntl(fd,F_GETFD)==-1&&errno==EBADF);++groups;
    const int reused=open("/dev/null",O_RDONLY);assert(reused>=0);if(reused!=fd){assert(dup2(reused,fd)==fd);close(reused);}owner.Close();assert(fcntl(fd,F_GETFD)>=0);close(fd);++groups;
  }
  { Owner closed(3);closed.Close();const int fd=socketFd();assert(!closed.Admit(fd));assert(fcntl(fd,F_GETFD)>=0);close(fd);++groups; }
  { const int fd=socketFd();{Owner owner(4);assert(owner.Admit(fd));}assert(fcntl(fd,F_GETFD)==-1&&errno==EBADF);++groups; }
  std::printf("{\"portableOwnerGroups\":%u,\"scope\":\"actual POSIX descriptor/listen/accept/close lifetime, not JSAPI/provider/guest\"}\n",groups);
}
