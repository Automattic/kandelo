struct timespec;
int sem_timedwait(void *restrict, const struct timespec *restrict);

int sem_clockwait(void *restrict sem, int clock, const struct timespec *restrict at)
{
	return sem_timedwait(sem, at);
}
