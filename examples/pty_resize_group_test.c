#define _GNU_SOURCE 1
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

/* Ordinary SDK/PTY/process/signal regression, independent of Foot or Bash.
 * Foreground readers keep SIGWINCH blocked outside pselect: pending delivery
 * cannot fall into a readiness-to-read race or rely on a fixed delay.
 * No handler performs ioctl, allocation, stdio, or other unsafe work. */
static volatile sig_atomic_t winches;
static void on_winch(int signo) { if (signo == SIGWINCH) ++winches; }
static void fail(const char *what) { perror(what); exit(1); }
static void check(int yes, const char *what) {
    if (!yes) { fprintf(stderr, "PTY_RESIZE_FAIL: %s\n", what); exit(1); }
}
struct packet {
    int kind, role, pid, pgid, sid, winches;
    struct winsize size;
};
static void send_packet(int fd, int kind, int role, int tty) {
    struct packet p = {.kind=kind, .role=role, .pid=getpid(),
        .pgid=getpgrp(), .sid=getsid(0), .winches=winches};
    if (ioctl(tty, TIOCGWINSZ, &p.size) < 0) fail("TIOCGWINSZ child");
    ssize_t n;
    do n=write(fd, &p, sizeof p); while (n<0 && errno==EINTR);
    check(n==(ssize_t)sizeof p, "atomic child report");
}
static struct packet receive(int fd) {
    fd_set reads; FD_ZERO(&reads); FD_SET(fd,&reads);
    struct timespec limit={.tv_sec=5};
    int n=pselect(fd+1,&reads,NULL,NULL,&limit,NULL);
    check(n==1, "bounded real child report readiness");
    struct packet p; size_t at=0;
    while (at<sizeof p) {
        ssize_t got=read(fd,(char *)&p+at,sizeof p-at);
        if (got<0 && errno==EINTR) continue;
        check(got>0,"complete child report"); at+=(size_t)got;
    }
    check(p.role>=0 && p.role<3,"reported child role");
    return p;
}
static void command(int fd, char value) {
    ssize_t n; do n=write(fd,&value,1); while(n<0 && errno==EINTR);
    check(n==1,"parent control write");
}
static int same_size(struct winsize a, struct winsize b) {
    return a.ws_row==b.ws_row && a.ws_col==b.ws_col &&
        a.ws_xpixel==b.ws_xpixel && a.ws_ypixel==b.ws_ypixel;
}
static void child_loop(int role,int tty,int controls[3][2],int reports) {
    struct sigaction sa={.sa_handler=on_winch}; sigemptyset(&sa.sa_mask);
    if(sigaction(SIGWINCH,&sa,NULL)<0) fail("sigaction child");
    sigset_t blocked,waitmask;
    sigemptyset(&blocked); sigaddset(&blocked,SIGWINCH);
    if(sigprocmask(SIG_BLOCK,&blocked,&waitmask)<0) fail("block child SIGWINCH");
    sigdelset(&waitmask,SIGWINCH);
    for(int i=0;i<3;i++) { close(controls[i][1]); if(i!=role)close(controls[i][0]); }
    send_packet(reports,'R',role,tty);
    sig_atomic_t reported=0;
    for(;;) {
        if(winches!=reported) { send_packet(reports,'W',role,tty); reported=winches; }
        fd_set reads; FD_ZERO(&reads); FD_SET(controls[role][0],&reads);
        int n=pselect(controls[role][0]+1,&reads,NULL,NULL,NULL,&waitmask);
        if(n<0 && errno==EINTR) continue;
        if(n<0) fail("pselect child");
        char c; check(read(controls[role][0],&c,1)==1,"child control read");
        if(c=='Q') break;
        check(c=='S',"known control request"); send_packet(reports,'S',role,tty);
    }
    close(controls[role][0]); close(tty); close(reports);
}
int main(void) {
    struct sigaction sa={.sa_handler=on_winch}; sigemptyset(&sa.sa_mask);
    if(sigaction(SIGWINCH,&sa,NULL)<0) fail("sigaction parent");
    int master=posix_openpt(O_RDWR|O_NOCTTY); if(master<0) fail("posix_openpt");
    if(grantpt(master)<0 || unlockpt(master)<0) fail("grantpt/unlockpt");
    char *name=ptsname(master); if(!name) fail("ptsname");
    int controls[3][2],reports[2];
    for(int i=0;i<3;i++) if(pipe(controls[i])<0) fail("control pipe");
    if(pipe(reports)<0) fail("report pipe");
    pid_t leader=fork(); if(leader<0) fail("fork leader");
    if(leader==0) {
        close(reports[0]); close(master);
        if(setsid()<0) fail("setsid");
        int tty=open(name,O_RDWR); if(tty<0) fail("open slave");
        if(ioctl(tty,TIOCSCTTY,0)<0 || tcsetpgrp(tty,getpgrp())<0) fail("foreground tty");
        pid_t peer=fork(); if(peer<0) fail("fork foreground peer");
        if(peer==0) { child_loop(1,tty,controls,reports[1]); _exit(0); }
        pid_t background=fork(); if(background<0) fail("fork background");
        if(background==0) {
            if(setpgid(0,0)<0) fail("background setpgid");
            child_loop(2,tty,controls,reports[1]); _exit(0);
        }
        child_loop(0,tty,controls,reports[1]);
        int status;
        check(waitpid(peer,&status,0)==peer && WIFEXITED(status) && WEXITSTATUS(status)==0,"foreground peer clean exit");
        check(waitpid(background,&status,0)==background && WIFEXITED(status) && WEXITSTATUS(status)==0,"background clean exit");
        _exit(0);
    }
    close(reports[1]); for(int i=0;i<3;i++) close(controls[i][0]);
    struct packet ready[3]; unsigned seen=0;
    for(int i=0;i<3;i++) {
        struct packet p=receive(reports[0]);
        check(p.kind=='R' && !(seen&(1u<<p.role)),"unique real child readiness");
        ready[p.role]=p; seen|=1u<<p.role;
    }
    check(ready[0].pid==leader && ready[0].pgid==leader && ready[1].pgid==leader &&
        ready[2].pgid!=leader && ready[0].sid==leader && ready[1].sid==leader &&
        ready[2].sid==leader && getpgrp()!=leader,"two foreground members, outside setter and separate background group");
    struct winsize cases[]={
        {.ws_row=40,.ws_col=120,.ws_xpixel=1200,.ws_ypixel=800},
        {.ws_row=24,.ws_col=80,.ws_xpixel=800,.ws_ypixel=480},
        {.ws_row=24,.ws_col=80,.ws_xpixel=800,.ws_ypixel=480},
        {.ws_row=24,.ws_col=80,.ws_xpixel=801,.ws_ypixel=480},
    };
    int expected[]={1,2,2,3};
    errno=0;
    check(ioctl(master,TIOCSWINSZ,NULL)==-1 && errno==EFAULT,"null winsize rejected without a signal");
    errno=0;
    check(ioctl(-1,TIOCSWINSZ,&cases[0])==-1 && errno==EBADF,"invalid setter descriptor rejected");
    errno=0;
    check(ioctl(reports[0],TIOCSWINSZ,&cases[0])==-1 && errno==ENOTTY,"nonterminal setter rejected");
    check(winches==0,"rejected operations do not signal setter");
    for(int step=0;step<4;step++) {
        if(ioctl(master,TIOCSWINSZ,&cases[step])<0) fail("TIOCSWINSZ parent");
        check(winches==0,"setter outside foreground group must not receive resize");
        if(step!=2) {
            unsigned foreground=0;
            for(int i=0;i<2;i++) {
                struct packet p=receive(reports[0]);
                check(p.kind=='W' && p.role<2 && !(foreground&(1u<<p.role)) &&
                    p.winches==expected[step] && same_size(p.size,cases[step]),"both foreground waiters receive resize and full size");
                foreground|=1u<<p.role;
            }
        }
        for(int i=0;i<3;i++) command(controls[i][1],'S');
        unsigned snapshots=0;
        for(int i=0;i<3;i++) {
            struct packet p=receive(reports[0]);
            check(p.kind=='S' && !(snapshots&(1u<<p.role)) && same_size(p.size,cases[step]) &&
                p.winches==(p.role<2?expected[step]:0),"unchanged resize/background isolation and readback");
            snapshots|=1u<<p.role;
        }
        struct winsize got; if(ioctl(master,TIOCGWINSZ,&got)<0) fail("master readback");
        check(same_size(got,cases[step]),"master/slave shared size");
    }
    for(int i=0;i<3;i++) { command(controls[i][1],'Q'); close(controls[i][1]); }
    int status; check(waitpid(leader,&status,0)==leader && WIFEXITED(status) && WEXITSTATUS(status)==0,"session family clean exit");
    close(reports[0]); close(master);
    puts("PTY_RESIZE_GROUP_PASS"); return 0;
}
