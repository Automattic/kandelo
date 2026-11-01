#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in address = {.sin_family=AF_INET,
        .sin_port=htons((unsigned short)atoi(argv[1]))};
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    if (fd < 0 || connect(fd,(struct sockaddr *)&address,sizeof(address))) {
        perror("connect"); return 1;
    }
    unsigned char bytes[4096];
    size_t total=0;
    for (;;) {
        ssize_t n=read(fd,bytes,sizeof(bytes));
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { perror("read"); return 1; }
        if (!n) break;
        for (ssize_t i=0;i<n;i++) if(bytes[i]!=65) return 3;
        total+=(size_t)n;
        // Deliberate rate control, not a completion wait: force partial
        // writes over several inactivity intervals while bytes still move.
        struct timespec delay={.tv_sec=0,.tv_nsec=1000000};
        while (nanosleep(&delay,&delay) && errno==EINTR) {}
    }
    close(fd);
    if(total!=2097152) { fprintf(stderr,"received %zu bytes\n",total);return 4; }
    puts("socket-write-peer-ok");return 0;
}
