#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#define PORT 18087
#define TOTAL (256 * 1024)
static void check(int ok, const char *what) { if (!ok) {perror(what); exit(1);} }
static struct sockaddr_in address(const char *ip, int port) {
 struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(port)};
 check(inet_pton(AF_INET,ip,&a.sin_addr)==1,"inet_pton"); return a;
}
static void send_all(int fd,const unsigned char *bytes,size_t length) {
 while(length) {ssize_t n=send(fd,bytes,length,MSG_NOSIGNAL); if(n<0&&errno==EAGAIN) {struct pollfd p={fd,POLLOUT,0};check(poll(&p,1,10000)>0,"send poll");continue;} check(n>0,"send");bytes+=n;length-=n;}
}
int main(int argc,char **argv) {
 check(argc>=2,"arguments");
 int fd=socket(AF_INET,SOCK_STREAM,0);check(fd>=0,"socket");
 if(!strcmp(argv[1],"server")||!strcmp(argv[1],"reset-server")) {
  struct sockaddr_in bind_address=address("0.0.0.0",PORT);check(bind(fd,(void*)&bind_address,sizeof bind_address)==0,"bind");check(listen(fd,4)==0,"listen");
  struct sockaddr_in remote; socklen_t size=sizeof remote; int peer=accept(fd,(void*)&remote,&size);check(peer>=0,"accept");
  struct sockaddr_in actual; socklen_t actual_size=sizeof actual;check(getsockname(peer,(void*)&actual,&actual_size)==0&&actual.sin_addr.s_addr==inet_addr("10.89.0.1")&&ntohs(actual.sin_port)==PORT,"accepted local endpoint");
  char ip[INET_ADDRSTRLEN];check(inet_ntop(AF_INET,&remote.sin_addr,ip,sizeof ip)!=NULL,"remote");check(!strcmp(ip,"10.89.0.2"),"peer address");printf("accepted %s:%u\n",ip,ntohs(remote.sin_port));fflush(stdout);
  if(!strcmp(argv[1],"reset-server")) {
   unsigned char byte; errno=0;check(recv(peer,&byte,1,0)==-1&&errno==ECONNRESET,"accepted reset");
   printf("accepted guest observes ECONNRESET\n");close(peer);close(fd);return 0;
  }
  unsigned char bytes[4096];size_t total=0;
  for(;;){ssize_t n=recv(peer,bytes,sizeof bytes,0);check(n>=0,"receive");if(!n)break;for(ssize_t i=0;i<n;i++)check(bytes[i]==(unsigned char)((total+i)%251),"content");total+=n;}
  check(total==TOTAL,"complete stream before FIN");send_all(peer,(void*)"reply-after-fin",15);check(shutdown(peer,SHUT_WR)==0,"server shutdown");close(peer);close(fd);puts("server drained 256 KiB before FIN and replied");return 0;
 }
 struct sockaddr_in dst=address("10.89.0.1",PORT);
 if(!strcmp(argv[1],"client")) {
  struct sockaddr_in bound=address("0.0.0.0",18187);check(bind(fd,(void*)&bound,sizeof bound)==0,"client bind");
  check(fcntl(fd,F_SETFL,O_NONBLOCK)==0,"nonblock");errno=0;check(connect(fd,(void*)&dst,sizeof dst)==-1&&errno==EINPROGRESS,"pending connect");
  struct pollfd pending={fd,POLLOUT,0};check(poll(&pending,1,10000)>0,"connect poll");int err=-1;socklen_t es=sizeof err;check(getsockopt(fd,SOL_SOCKET,SO_ERROR,&err,&es)==0&&err==0,"SO_ERROR");
  struct sockaddr_in local; socklen_t size=sizeof local;check(getsockname(fd,(void*)&local,&size)==0,"getsockname");check(local.sin_addr.s_addr==inet_addr("10.89.0.2")&&ntohs(local.sin_port)==18187,"actual bound local endpoint");
  unsigned char bytes[16384];size_t sent=0;while(sent<TOTAL){size_t length=sizeof bytes;for(size_t i=0;i<length;i++)bytes[i]=(unsigned char)((sent+i)%251);send_all(fd,bytes,length);sent+=length;}
  check(shutdown(fd,SHUT_WR)==0,"client FIN");char reply[32];size_t received=0;
  for(;;) {ssize_t n=recv(fd,reply+received,sizeof reply-received,0);if(n<0&&errno==EAGAIN){struct pollfd p={fd,POLLIN,0};check(poll(&p,1,10000)>0,"recv poll");continue;}check(n>=0,"reply");if(!n)break;received+=n;check(received<sizeof reply,"reply limit");}
  check(received==15&&!memcmp(reply,"reply-after-fin",15),"reply bytes");close(fd);puts("nonblocking bound guest TCP sent 256 KiB, half-closed, and received reply then EOF");return 0;
 }
 check(!strcmp(argv[1],"reset-client"),"mode");check(connect(fd,(void*)&dst,sizeof dst)==0,"reset connect");puts("reset client connected");fflush(stdout);for(;;)pause();
}
