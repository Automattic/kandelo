/*
 * A System V segment must be shared BETWEEN processes.
 *
 * This is the property the facility exists for, and no upstream test reaches
 * it: every sys_shm case is single-process.
 *
 * The test uses one attachment per process and a semaphore for ordering, so
 * it isolates cross-process visibility from the separate question of whether
 * two attachments in ONE process alias (shm-attach-aliasing covers that).
 * Keeping them apart matters because they can fail independently, and a
 * combined test would stop at the first and report nothing about the second.
 *
 * Ordering uses a System V semaphore rather than a sleep so the test cannot
 * pass or fail on timing: each side blocks until the other has actually
 * written.
 */

#define SYSV_TEST_NAME "shm-cross-process"

#include <sys/sem.h>
#include <sys/shm.h>
#include <sys/wait.h>

#include "../sysv.h"

#define PARENT_BYTE 0xA5
#define CHILD_BYTE 0x5A

/* Semaphore 0: parent has written. Semaphore 1: child has written. */
#define SEM_PARENT_WROTE 0
#define SEM_CHILD_WROTE 1

static int semid;

static int sem_post(int num)
{
	struct sembuf op = { .sem_num = (unsigned short)num, .sem_op = 1,
	                     .sem_flg = 0 };
	return semop(semid, &op, 1);
}

static int sem_wait_for(int num)
{
	struct sembuf op = { .sem_num = (unsigned short)num, .sem_op = -1,
	                     .sem_flg = 0 };
	return semop(semid, &op, 1);
}

int main(void)
{
	long pagesize = sysconf(_SC_PAGESIZE);
	if ( pagesize <= 0 )
		FAIL_ERRNO("sysconf _SC_PAGESIZE");

	int shmid = shmget(IPC_PRIVATE, (size_t)pagesize, IPC_CREAT | 0600);
	if ( shmid < 0 )
		FAIL_ERRNO("shmget");
	semid = semget(IPC_PRIVATE, 2, IPC_CREAT | 0600);
	if ( semid < 0 )
		FAIL_ERRNO("semget");

	unsigned char *parent = shmat(shmid, NULL, 0);
	if ( parent == (void *)-1 )
		FAIL_ERRNO("shmat (parent)");
	parent[0] = PARENT_BYTE;

	pid_t pid = fork();
	if ( pid < 0 )
		FAIL_ERRNO("fork");
	if ( pid == 0 )
	{
		/* Announce the parent's write is in place before reading. */
		if ( sem_post(SEM_PARENT_WROTE) < 0 )
			_exit(3);
		if ( parent[0] != PARENT_BYTE )
		{
			printf("%s: child did not see the parent's write: "
			       "expected 0x%02X, read 0x%02X -- the segment is "
			       "not shared across processes\n",
			       SYSV_TEST_NAME, PARENT_BYTE, parent[0]);
			fflush(stdout);
			_exit(2);
		}
		parent[1] = CHILD_BYTE;
		if ( sem_post(SEM_CHILD_WROTE) < 0 )
			_exit(3);
		_exit(0);
	}

	/* Wait until the child has written before looking. */
	if ( sem_wait_for(SEM_CHILD_WROTE) < 0 )
		FAIL_ERRNO("semop waiting for the child's write");

	if ( parent[1] != CHILD_BYTE )
		FAILF("the parent did not see the child's write: expected "
		      "0x%02X, read 0x%02X -- the segment is not shared across "
		      "processes", CHILD_BYTE, parent[1]);

	int status;
	if ( waitpid(pid, &status, 0) != pid )
		FAIL_ERRNO("waitpid");
	if ( !WIFEXITED(status) )
		FAILF("child did not exit normally (status 0x%X)", status);
	if ( WEXITSTATUS(status) == 2 )
		_exit(1); /* the child already printed the reason */
	if ( WEXITSTATUS(status) == 3 )
		FAILF("child failed to signal through the ordering semaphore");
	if ( WEXITSTATUS(status) != 0 )
		FAILF("child exited %d", WEXITSTATUS(status));

	if ( shmdt(parent) < 0 )
		FAIL_ERRNO("shmdt");
	if ( shmctl(shmid, IPC_RMID, NULL) < 0 )
		FAIL_ERRNO("shmctl IPC_RMID");
	if ( semctl(semid, 0, IPC_RMID) < 0 )
		FAIL_ERRNO("semctl IPC_RMID");
	return 0;
}
