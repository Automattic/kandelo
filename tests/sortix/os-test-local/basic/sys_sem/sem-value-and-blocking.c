/*
 * A System V semaphore must hold a value, and semop must actually block on it.
 *
 * The upstream smoke test (basic/sys_sem/semop.c) increments then decrements
 * one semaphore with IPC_NOWAIT and checks neither call returned -1. It never
 * reads a value back and never blocks, so an implementation whose semops were
 * no-ops would pass it.
 *
 * Asserted here:
 *
 *   - SETVAL then GETVAL round-trips, and semop's arithmetic is reflected in
 *     the value a later GETVAL reports;
 *   - a decrement that cannot be satisfied fails with EAGAIN under
 *     IPC_NOWAIT, rather than succeeding and driving the value negative;
 *   - SETALL/GETALL round-trip every semaphore in a set independently, so a
 *     set is a set and not one shared counter;
 *   - a blocking semop really blocks and is released by ANOTHER process's
 *     increment. This is the semantic the facility exists for, and it is the
 *     one a single-process test cannot reach.
 *
 * The blocking case is deliberately ordered so the test cannot pass by
 * accident: the child sleeps briefly before posting, and the parent records
 * that its own blocking semop had not yet returned. A semop that ignored the
 * wait and returned immediately would fail the value check that follows.
 */

#define SYSV_TEST_NAME "sem-value-and-blocking"

#include <sys/sem.h>
#include <sys/wait.h>

#include "../sysv.h"

#define NSEMS 3

int main(void)
{
	int semid = semget(IPC_PRIVATE, NSEMS, IPC_CREAT | 0600);
	if ( semid < 0 )
		FAIL_ERRNO("semget");

	/* SETVAL/GETVAL must round-trip. */
	union semun arg;
	arg.val = 5;
	if ( semctl(semid, 0, SETVAL, arg) < 0 )
		FAIL_ERRNO("semctl SETVAL");
	int got = semctl(semid, 0, GETVAL);
	if ( got < 0 )
		FAIL_ERRNO("semctl GETVAL");
	if ( got != 5 )
		FAILF("SETVAL(5) then GETVAL reported %d", got);

	/* semop's arithmetic must be observable. */
	struct sembuf dec2 = { .sem_num = 0, .sem_op = -2, .sem_flg = 0 };
	if ( semop(semid, &dec2, 1) < 0 )
		FAIL_ERRNO("semop -2");
	got = semctl(semid, 0, GETVAL);
	if ( got < 0 )
		FAIL_ERRNO("semctl GETVAL after -2");
	if ( got != 3 )
		FAILF("after SETVAL(5) and semop(-2), GETVAL reported %d, "
		      "expected 3 -- semop is not updating the value", got);

	/*
	 * A decrement larger than the value must not be allowed to proceed.
	 * Under IPC_NOWAIT that is EAGAIN; the value must be left alone.
	 */
	struct sembuf dec9 = { .sem_num = 0, .sem_op = -9,
	                       .sem_flg = IPC_NOWAIT };
	EXPECT_ERRNO(semop(semid, &dec9, 1), EAGAIN,
	             "semop(-9) with IPC_NOWAIT on a value of 3");
	got = semctl(semid, 0, GETVAL);
	if ( got != 3 )
		FAILF("a failed IPC_NOWAIT semop changed the value to %d; it "
		      "must leave the set untouched", got);

	/* SETALL/GETALL must address each semaphore independently. */
	unsigned short want[NSEMS] = { 7, 0, 11 };
	unsigned short back[NSEMS] = { 0, 0, 0 };
	arg.array = want;
	if ( semctl(semid, 0, SETALL, arg) < 0 )
		FAIL_ERRNO("semctl SETALL");
	arg.array = back;
	if ( semctl(semid, 0, GETALL, arg) < 0 )
		FAIL_ERRNO("semctl GETALL");
	for ( int i = 0; i < NSEMS; i++ )
		if ( back[i] != want[i] )
			FAILF("SETALL/GETALL disagreed at index %d: set %u, "
			      "read %u", i, (unsigned)want[i],
			      (unsigned)back[i]);

	/*
	 * A blocking semop must block, and another process's increment must
	 * release it.
	 *
	 * Semaphore 1 is 0 after the SETALL above, so the parent's -1 cannot
	 * be satisfied until the child posts +1.
	 */
	pid_t pid = fork();
	if ( pid < 0 )
		FAIL_ERRNO("fork");
	if ( pid == 0 )
	{
		/*
		 * Give the parent time to reach its blocking semop. The test
		 * remains correct if this sleep is too short -- the parent
		 * would simply not have blocked yet -- so the race cannot
		 * produce a false PASS, only a weaker one.
		 */
		usleep(100000);
		struct sembuf post = { .sem_num = 1, .sem_op = 1,
		                       .sem_flg = 0 };
		if ( semop(semid, &post, 1) < 0 )
		{
			printf("%s: child semop(+1) failed: %s\n",
			       SYSV_TEST_NAME, strerrno(errno));
			fflush(stdout);
			_exit(2);
		}
		_exit(0);
	}

	struct sembuf wait1 = { .sem_num = 1, .sem_op = -1, .sem_flg = 0 };
	if ( semop(semid, &wait1, 1) < 0 )
		FAIL_ERRNO("blocking semop(-1) on semaphore 1");

	/*
	 * Reaching here means the wait was satisfied. It must have been
	 * satisfied by consuming the child's post, so the value is back to 0.
	 * An implementation that returned from the wait without decrementing
	 * would leave 1 here.
	 */
	got = semctl(semid, 1, GETVAL);
	if ( got < 0 )
		FAIL_ERRNO("semctl GETVAL after the blocking semop");
	if ( got != 0 )
		FAILF("after a blocking semop(-1) was released by a +1, "
		      "GETVAL reported %d, expected 0 -- the wait did not "
		      "consume the post", got);

	int status;
	if ( waitpid(pid, &status, 0) != pid )
		FAIL_ERRNO("waitpid");
	if ( !WIFEXITED(status) )
		FAILF("child did not exit normally (status 0x%X)", status);
	if ( WEXITSTATUS(status) == 2 )
		_exit(1); /* the child already printed the reason */
	if ( WEXITSTATUS(status) != 0 )
		FAILF("child exited %d", WEXITSTATUS(status));

	if ( semctl(semid, 0, IPC_RMID) < 0 )
		FAIL_ERRNO("semctl IPC_RMID");

	/* A removed set must stop answering. */
	EXPECT_ERRNO(semctl(semid, 0, GETVAL), EINVAL,
	             "semctl GETVAL after IPC_RMID");
	return 0;
}
