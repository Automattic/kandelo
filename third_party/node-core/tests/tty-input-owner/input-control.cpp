// Actual native PTYs and the production portable input/OFD owner. No synthetic
// TTY identity, process signals, guest syscall or native JSAPI conformance claim.
#include "terminal-operations.h"
#include <iostream>
#include <poll.h>
#include <string>
using kandelo::terminal::InputHandle;
struct Pair {
 int master=-1,slave=-1;
 Pair(){master=posix_openpt(O_RDWR|O_NOCTTY|O_CLOEXEC);assert(master>=0);assert(grantpt(master)==0&&unlockpt(master)==0);char* name=ptsname(master);assert(name);slave=open(name,O_RDWR|O_NOCTTY|O_CLOEXEC);assert(slave>=0);}
 ~Pair(){if(slave>=0)close(slave);if(master>=0)close(master);}
};
static char ReadByte(int fd){pollfd event{fd,POLLIN,0};assert(poll(&event,1,1000)==1);char byte;assert(read(fd,&byte,1)==1);return byte;}
int main(int argc,char** argv){assert(argc==9);unsigned long nativeInitial[4],nativeNormal[4];for(int i=0;i<4;++i){nativeInitial[i]=std::stoul(argv[i+1]);nativeNormal[i]=std::stoul(argv[i+5]);}int checks=0;Pair original,replacement;termios initial{};assert(tcgetattr(original.slave,&initial)==0);assert(initial.c_lflag==nativeInitial[0]&&initial.c_iflag==nativeInitial[1]&&initial.c_oflag==nativeInitial[2]&&initial.c_cflag==nativeInitial[3]);
 int alias=fcntl(original.slave,F_DUPFD_CLOEXEC,3);assert(alias>=0);int flags=fcntl(alias,F_GETFL);assert(flags>=0);assert(fcntl(alias,F_SETFL,flags&~O_NONBLOCK)==0);
 InputHandle input;assert(input.Open(original.slave)==0);int captured=input.Descriptor();assert(captured>=0&&captured!=original.slave);struct stat a{},b{};assert(fstat(captured,&a)==0&&fstat(alias,&b)==0&&a.st_dev==b.st_dev&&a.st_ino==b.st_ino);checks++;
 assert(fcntl(captured,F_GETFL)&O_NONBLOCK);assert(fcntl(original.slave,F_GETFL)&O_NONBLOCK);assert(!(fcntl(alias,F_GETFL)&O_NONBLOCK));checks++;
 assert(fcntl(captured,F_GETFD)&FD_CLOEXEC);checks++;
 assert(input.SetMode(2)==0);termios raw{};assert(tcgetattr(alias,&raw)==0);assert(!(raw.c_lflag&(ICANON|ECHO|ISIG)));checks++;
 assert(write(original.master,"A",1)==1);assert(ReadByte(captured)=='A');checks++;
 const int supplied=original.slave;assert(close(supplied)==0);original.slave=-1;assert(dup2(replacement.slave,supplied)==supplied);checks++;
 assert(fstat(captured,&a)==0&&fstat(supplied,&b)==0&&(a.st_dev!=b.st_dev||a.st_ino!=b.st_ino));checks++;
 assert(write(replacement.master,"B\n",2)==2);char byte;assert(read(captured,&byte,1)==-1&&(errno==EAGAIN||errno==EWOULDBLOCK));checks++;
 assert(write(original.master,"C",1)==1);assert(ReadByte(captured)=='C');checks++;
 assert(input.SetMode(0)==0);termios restored{};assert(tcgetattr(alias,&restored)==0);assert(restored.c_lflag==nativeNormal[0]&&restored.c_iflag==nativeNormal[1]&&restored.c_oflag==nativeNormal[2]&&restored.c_cflag==nativeNormal[3]);checks++;
 input.Close();assert(tcgetattr(alias,&restored)==0);assert(restored.c_lflag==initial.c_lflag&&restored.c_iflag==initial.c_iflag&&restored.c_oflag==initial.c_oflag&&restored.c_cflag==initial.c_cflag);assert(input.Descriptor()==-1);assert(fcntl(captured,F_GETFD)==-1&&errno==EBADF);assert(fcntl(supplied,F_GETFD)>=0&&isatty(supplied));checks++;
 int reused=open("/dev/null",O_RDONLY|O_CLOEXEC);assert(reused>=0);input.Close();assert(fcntl(reused,F_GETFD)>=0);close(reused);checks++;
 assert(input.SetMode(1)==-EBADF);checks++;
 {InputHandle bad;assert(bad.Open(-1)==-EBADF&&bad.Descriptor()==-1);checks++;}
 {int file=open("/dev/null",O_RDONLY|O_CLOEXEC);assert(file>=0);InputHandle bad;assert(bad.Open(file)==-ENOTTY);assert(fcntl(file,F_GETFD)>=0);close(file);checks++;}
 {InputHandle master;assert(master.Open(original.master)==-ENOTSUP);assert(fcntl(original.master,F_GETFD)>=0);}
 close(supplied);close(alias);
 std::cout<<"{\"checks\":"<<checks<<",\"realPTYCapturedFdReuse\":true,\"isolatedNonblockingOFD\":true,\"actualModeRestoration\":true,\"master\":\"ENOTSUP remains implementation gap, not public compatibility pass\",\"guestRuntime\":false}\n";
}
