/*
 * shmget's key namespace, and what shmctl must report about a segment.
 *
 * None of this is covered upstream: basic/sys_shm/shmget.c passes IPC_PRIVATE,
 * which bypasses the key namespace entirely, so every rule below is untested.
 *
 * Asserted here:
 *
 *   - a key created once is returned again for the same key (the namespace
 *     resolves, rather than minting a fresh segment per call);
 *   - IPC_CREAT|IPC_EXCL on an existing key fails with EEXIST;
 *   - a key that was never created, requested without IPC_CREAT, fails with
 *     ENOENT;
 *   - IPC_STAT reports the size the segment was created with and the creating
 *     process as shm_cpid;
 *   - after IPC_RMID the key no longer resolves.
 *
 * The error cases use EXPECT_ERRNO, which treats an unexpected SUCCESS as a
 * failure. That direction is the point: an implementation that ignores
 * IPC_EXCL and hands back the existing identifier is exactly what a
 * return-value smoke test cannot distinguish from correct behaviour.
 */

#define SYSV_TEST_NAME "shm-key-lifecycle"

#include <sys/shm.h>

#include "../sysv.h"

/*
 * Two keys this test owns. They are arbitrary but fixed, and the test runs
 * against a private per-test machine, so they cannot collide with anything
 * else. ABSENT_KEY is never created by anyone.
 */
#define OWNED_KEY ((key_t)0x4B53484D) /* "KSHM" */
#define ABSENT_KEY ((key_t)0x4B534841) /* "KSHA" */

int main(void)
{
	long pagesize = sysconf(_SC_PAGESIZE);
	if ( pagesize <= 0 )
		FAIL_ERRNO("sysconf _SC_PAGESIZE");
	size_t size = (size_t)pagesize;

	/* A key nobody has created must not resolve without IPC_CREAT. */
	EXPECT_ERRNO(shmget(ABSENT_KEY, size, 0600), ENOENT,
	             "shmget of a key that was never created");

	int created = shmget(OWNED_KEY, size, IPC_CREAT | IPC_EXCL | 0600);
	if ( created < 0 )
		FAIL_ERRNO("shmget IPC_CREAT|IPC_EXCL");

	/* The same key must resolve to the same segment, not a new one. */
	int again = shmget(OWNED_KEY, size, 0600);
	if ( again < 0 )
		FAIL_ERRNO("shmget of the existing key");
	if ( again != created )
		FAILF("shmget returned a different identifier for the same key: "
		      "created %d, looked up %d -- the key namespace is minting "
		      "a new segment per call", created, again);

	/* IPC_EXCL on an existing key must fail rather than alias it. */
	EXPECT_ERRNO(shmget(OWNED_KEY, size, IPC_CREAT | IPC_EXCL | 0600),
	             EEXIST, "shmget IPC_CREAT|IPC_EXCL on an existing key");

	/* IPC_STAT must describe the segment that was actually created. */
	struct shmid_ds ds;
	memset(&ds, 0, sizeof(ds));
	if ( shmctl(created, IPC_STAT, &ds) < 0 )
		FAIL_ERRNO("shmctl IPC_STAT");
	if ( ds.shm_segsz != size )
		FAILF("IPC_STAT reported shm_segsz %llu for a segment created "
		      "with size %llu",
		      (unsigned long long)ds.shm_segsz,
		      (unsigned long long)size);
	if ( ds.shm_cpid != getpid() )
		FAILF("IPC_STAT reported shm_cpid %ld; this process is %ld",
		      (long)ds.shm_cpid, (long)getpid());

	/* After removal the key must stop resolving. */
	if ( shmctl(created, IPC_RMID, NULL) < 0 )
		FAIL_ERRNO("shmctl IPC_RMID");
	EXPECT_ERRNO(shmget(OWNED_KEY, size, 0600), ENOENT,
	             "shmget after IPC_RMID");
	return 0;
}
