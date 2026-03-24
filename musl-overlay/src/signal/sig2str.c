#include <signal.h>
#include <string.h>
#include <stdio.h>

static const struct {
	int signo;
	const char *name;
} signames[] = {
	{ SIGHUP,    "HUP" },
	{ SIGINT,    "INT" },
	{ SIGQUIT,   "QUIT" },
	{ SIGILL,    "ILL" },
	{ SIGTRAP,   "TRAP" },
	{ SIGABRT,   "ABRT" },
	{ SIGBUS,    "BUS" },
	{ SIGFPE,    "FPE" },
	{ SIGKILL,   "KILL" },
	{ SIGUSR1,   "USR1" },
	{ SIGSEGV,   "SEGV" },
	{ SIGUSR2,   "USR2" },
	{ SIGPIPE,   "PIPE" },
	{ SIGALRM,   "ALRM" },
	{ SIGTERM,   "TERM" },
	{ SIGSTKFLT, "STKFLT" },
	{ SIGCHLD,   "CHLD" },
	{ SIGCONT,   "CONT" },
	{ SIGSTOP,   "STOP" },
	{ SIGTSTP,   "TSTP" },
	{ SIGTTIN,   "TTIN" },
	{ SIGTTOU,   "TTOU" },
	{ SIGURG,    "URG" },
	{ SIGXCPU,   "XCPU" },
	{ SIGXFSZ,   "XFSZ" },
	{ SIGVTALRM, "VTALRM" },
	{ SIGPROF,   "PROF" },
	{ SIGWINCH,  "WINCH" },
	{ SIGPOLL,   "POLL" },
	{ SIGPWR,    "PWR" },
	{ SIGSYS,    "SYS" },
};

int sig2str(int signo, char *str)
{
	for (int i = 0; i < (int)(sizeof signames / sizeof *signames); i++) {
		if (signames[i].signo == signo) {
			strcpy(str, signames[i].name);
			return 0;
		}
	}
	int rtmin = SIGRTMIN;
	int rtmax = SIGRTMAX;
	if (signo >= rtmin && signo <= rtmax) {
		if (signo == rtmin)
			strcpy(str, "RTMIN");
		else if (signo == rtmax)
			strcpy(str, "RTMAX");
		else if (signo - rtmin <= (rtmax - rtmin) / 2)
			snprintf(str, SIG2STR_MAX, "RTMIN+%d", signo - rtmin);
		else
			snprintf(str, SIG2STR_MAX, "RTMAX-%d", rtmax - signo);
		return 0;
	}
	return -1;
}
