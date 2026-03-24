#include <signal.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <errno.h>

static const struct {
	const char *name;
	int signo;
} signames[] = {
	{ "HUP",    SIGHUP },
	{ "INT",    SIGINT },
	{ "QUIT",   SIGQUIT },
	{ "ILL",    SIGILL },
	{ "TRAP",   SIGTRAP },
	{ "ABRT",   SIGABRT },
	{ "BUS",    SIGBUS },
	{ "FPE",    SIGFPE },
	{ "KILL",   SIGKILL },
	{ "USR1",   SIGUSR1 },
	{ "SEGV",   SIGSEGV },
	{ "USR2",   SIGUSR2 },
	{ "PIPE",   SIGPIPE },
	{ "ALRM",   SIGALRM },
	{ "TERM",   SIGTERM },
	{ "STKFLT", SIGSTKFLT },
	{ "CHLD",   SIGCHLD },
	{ "CONT",   SIGCONT },
	{ "STOP",   SIGSTOP },
	{ "TSTP",   SIGTSTP },
	{ "TTIN",   SIGTTIN },
	{ "TTOU",   SIGTTOU },
	{ "URG",    SIGURG },
	{ "XCPU",   SIGXCPU },
	{ "XFSZ",   SIGXFSZ },
	{ "VTALRM", SIGVTALRM },
	{ "PROF",   SIGPROF },
	{ "WINCH",  SIGWINCH },
	{ "POLL",   SIGPOLL },
	{ "PWR",    SIGPWR },
	{ "SYS",    SIGSYS },
};

int str2sig(const char *str, int *signo)
{
	for (int i = 0; i < (int)(sizeof signames / sizeof *signames); i++) {
		if (strcmp(str, signames[i].name) == 0) {
			*signo = signames[i].signo;
			return 0;
		}
	}
	int rtmin = SIGRTMIN;
	int rtmax = SIGRTMAX;
	if (strcmp(str, "RTMIN") == 0) {
		*signo = rtmin;
		return 0;
	}
	if (strcmp(str, "RTMAX") == 0) {
		*signo = rtmax;
		return 0;
	}
	if (strncmp(str, "RTMIN+", 6) == 0) {
		char *end;
		long n = strtol(str + 6, &end, 10);
		if (*end == '\0' && n >= 0 && rtmin + n <= rtmax) {
			*signo = rtmin + (int)n;
			return 0;
		}
	}
	if (strncmp(str, "RTMAX-", 6) == 0) {
		char *end;
		long n = strtol(str + 6, &end, 10);
		if (*end == '\0' && n >= 0 && rtmax - n >= rtmin) {
			*signo = rtmax - (int)n;
			return 0;
		}
	}
	/* Numeric string */
	if (isdigit((unsigned char)*str)) {
		char *end;
		long n = strtol(str, &end, 10);
		if (*end == '\0' && n > 0 && n < _NSIG) {
			*signo = (int)n;
			return 0;
		}
	}
	return -1;
}
