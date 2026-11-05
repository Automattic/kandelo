#include "terminal-operations.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
static std::string Snapshot(int fd) {
  termios t{};if (tcgetattr(fd,&t)) return "null";
  std::array<unsigned,2> size{};int err=kandelo::terminal::WindowSize(fd,&size);if(err)return "null";
  char out[512];snprintf(out,sizeof(out),"[%llu,%llu,%llu,%llu,%u,%u,%u,%u]",
    static_cast<unsigned long long>(t.c_iflag),static_cast<unsigned long long>(t.c_oflag),
    static_cast<unsigned long long>(t.c_cflag),static_cast<unsigned long long>(t.c_lflag),
    unsigned(t.c_cc[VMIN]),unsigned(t.c_cc[VTIME]),size[0],size[1]);return out;
}
int main(int argc,char** argv) {
  if(argc!=3)return 2;int fd=open(argv[1],O_RDWR|O_NOCTTY);if(fd<0)return 3;
  if(strcmp(argv[2],"snapshot")==0){puts(Snapshot(fd).c_str());close(fd);return 0;}
  kandelo::terminal::BorrowedInputMode owner;int status=owner.Open(fd);if(status)return 4;
  std::vector<std::string> states{Snapshot(fd)};
  for(int mode:{3,2,0,1}){status=owner.SetMode(mode);if(status)return 5;states.push_back(Snapshot(fd));}
  owner.Close();states.push_back(Snapshot(fd));
  if(owner.SetMode(1)!=-EBADF || fcntl(fd,F_GETFD)<0)return 6;
  printf("[");for(size_t i=0;i<states.size();i++)printf("%s%s",i?",":"",states[i].c_str());puts("]");
  close(fd);return 0;
}
