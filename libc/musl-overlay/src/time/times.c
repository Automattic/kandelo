#include <sys/times.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

/* Kandelo has no SYS_times. times() reports the kernel's CPU-time
 * accounting through getrusage(), so it agrees with getrusage(), clock()
 * and the CPU-time clocks, and the elapsed real time from CLOCK_MONOTONIC,
 * all in clock ticks. Like Linux's, the return value wraps once it no
 * longer fits in clock_t. */

static clock_t ticks(long long sec, long long frac, long long frac_per_sec,
                     long hz)
{
	unsigned long long t = (unsigned long long)sec * hz
		+ (unsigned long long)(frac / (frac_per_sec / hz));
	return (clock_t)t;
}

clock_t times(struct tms *tms)
{
	struct rusage self, children;
	struct timespec now;
	long hz = sysconf(_SC_CLK_TCK);

	if (getrusage(RUSAGE_SELF, &self)
	    || getrusage(RUSAGE_CHILDREN, &children)
	    || clock_gettime(CLOCK_MONOTONIC, &now))
		return (clock_t)-1;
	if (tms) {
		tms->tms_utime = ticks(self.ru_utime.tv_sec,
			self.ru_utime.tv_usec, 1000000, hz);
		tms->tms_stime = ticks(self.ru_stime.tv_sec,
			self.ru_stime.tv_usec, 1000000, hz);
		tms->tms_cutime = ticks(children.ru_utime.tv_sec,
			children.ru_utime.tv_usec, 1000000, hz);
		tms->tms_cstime = ticks(children.ru_stime.tv_sec,
			children.ru_stime.tv_usec, 1000000, hz);
	}
	return ticks(now.tv_sec, now.tv_nsec, 1000000000, hz);
}
