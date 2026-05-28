/*
 * The upstream process-group wait tests use alarm(2) as an internal deadlock
 * guard after a child intentionally sleeps for one second. Under the CI
 * runner's parallel Node/worker load, that guard can fire before the child
 * gets scheduled to perform the setpgid/setsid transition. Keep the outer
 * harness timeout authoritative and give only these tests a wider guard.
 */
#ifndef KANDELO_SORTIX_MIN_WAITPID_ALARM_H
#define KANDELO_SORTIX_MIN_WAITPID_ALARM_H

#include <unistd.h>

static inline unsigned int kandelo_sortix_min_waitpid_alarm(unsigned int seconds)
{
	if (seconds != 0 && seconds < 8)
		seconds = 8;
	return alarm(seconds);
}

#define alarm(seconds) kandelo_sortix_min_waitpid_alarm(seconds)

#endif
