// Independent canonical-mode fd/OFD ownership control. The separate strict
// raw-to-normal termios control remains failing; no mode assertion is omitted
// from it, and these ownership checks cannot establish mode compatibility.
#include "terminal-operations.h"
#include <iostream>
#include <poll.h>
#include <string>
using kandelo::terminal::InputHandle;
struct Pair {
 int master=-1,slave=-1;
 Pair(){master=posix_openpt(O_RDWR|O_NOCTTY|O_CLOEXEC);assert(master>=0);assert(grantpt(master)==0&&unlockpt(master)==0);slave=open(ptsname(master),O_RDWR|O_NOCTTY|O_CLOEXEC);assert(slave>=0);}
 ~Pair(){if(master>=0)close(master);if(slave>=0)close(slave);}
};
static std::string Read(int fd){pollfd p{fd,POLLIN,0};assert(poll(&p,1,1000)==1);char bytes[128];ssize_t size=read(fd,bytes,sizeof(bytes));assert(size>0);return std::string(bytes,size_t(size));}
int main(){int checks=0;Pair first,second;termios initial{};assert(tcgetattr(first.slave,&initial)==0);int alias=fcntl(first.slave,F_DUPFD_CLOEXEC,3);assert(alias>=0);int originalFlags=fcntl(alias,F_GETFL);assert(originalFlags>=0);assert(fcntl(alias,F_SETFL,originalFlags&~O_NONBLOCK)==0);
 InputHandle input;assert(input.Open(first.slave)==0);int owned=input.Descriptor();assert(owned>=0&&owned!=first.slave);struct stat a{},b{};assert(fstat(owned,&a)==0&&fstat(alias,&b)==0&&a.st_dev==b.st_dev&&a.st_ino==b.st_ino);++checks;
 assert(fcntl(owned,F_GETFL)&O_NONBLOCK);assert(fcntl(first.slave,F_GETFL)&O_NONBLOCK);assert(!(fcntl(alias,F_GETFL)&O_NONBLOCK));++checks;
 assert(fcntl(owned,F_GETFD)&FD_CLOEXEC);++checks;
 char byte;assert(read(owned,&byte,1)==-1&&(errno==EAGAIN||errno==EWOULDBLOCK));++checks;
 assert(write(first.master,"alpha\n",6)==6);assert(Read(owned)=="alpha\n");++checks;
 int supplied=first.slave;close(supplied);first.slave=-1;assert(dup2(second.slave,supplied)==supplied);assert(fstat(owned,&a)==0&&fstat(supplied,&b)==0&&(a.st_dev!=b.st_dev||a.st_ino!=b.st_ino));++checks;
 assert(write(second.master,"replacement\n",12)==12);assert(write(first.master,"origin\n",7)==7);assert(Read(owned)=="origin\n");++checks;
 assert(Read(supplied)=="replacement\n");++checks;
 assert(read(owned,&byte,1)==-1&&(errno==EAGAIN||errno==EWOULDBLOCK));++checks;
 input.Close();assert(input.Descriptor()==-1);assert(fcntl(owned,F_GETFD)==-1&&errno==EBADF);assert(fcntl(supplied,F_GETFD)>=0&&isatty(supplied));++checks;
 int devnull=open("/dev/null",O_RDONLY|O_CLOEXEC);assert(devnull>=0);if(devnull!=owned){assert(dup2(devnull,owned)==owned);close(devnull);}input.Close();assert(fcntl(owned,F_GETFD)>=0);close(owned);++checks;
 termios unchanged{};assert(tcgetattr(alias,&unchanged)==0);assert(unchanged.c_lflag==initial.c_lflag&&unchanged.c_iflag==initial.c_iflag&&unchanged.c_oflag==initial.c_oflag&&unchanged.c_cflag==initial.c_cflag);++checks;
 {InputHandle bad;assert(bad.Open(-1)==-EBADF&&bad.Descriptor()==-1);assert(bad.SetMode(1)==-EBADF);++checks;}
 {int fd=open("/dev/null",O_RDONLY|O_CLOEXEC);InputHandle bad;assert(bad.Open(fd)==-ENOTTY&&fcntl(fd,F_GETFD)>=0);close(fd);++checks;}
 {InputHandle master;assert(master.Open(first.master)==-ENOTSUP&&fcntl(first.master,F_GETFD)>=0);}
 close(supplied);close(alias);std::cout<<"{\"checks\":"<<checks<<",\"realPTYReadAndPublicFdReuse\":true,\"isolatedNonblockingOFD\":true,\"capturedClosePreservesReplacement\":true,\"rawModeConformance\":\"separate strict control remains failing\",\"guestRuntime\":false}\n";
}
