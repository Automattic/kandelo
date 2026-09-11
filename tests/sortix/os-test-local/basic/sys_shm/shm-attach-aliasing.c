/*
 * Two attachments to one System V segment must alias one backing store.
 *
 * POSIX: shmat "attaches the shared memory segment to the address space of
 * the calling process". Attaching twice gives two addresses for the SAME
 * segment, so a store through one is immediately loadable through the other.
 * There is no synchronisation point involved; it is the same memory.
 *
 * Nothing upstream asks this. basic/sys_shm/shmat.c attaches once and checks
 * the result is not (void *)-1, so an implementation that hands each shmat a
 * private copy of the segment's bytes passes it.
 *
 * Kandelo materialises each attachment as a host-written byte mirror in the
 * guest's address space (see kernel_ipc_shm_record_mapping_for_process, whose
 * own comment notes "the host byte mirror is not authoritative"), which is
 * why this case is currently an expected failure: see BASIC_EXPECTED_FAIL in
 * scripts/run-sortix-tests.sh. The test is written to assert the POSIX
 * semantic rather than the present behaviour, so it turns into an XPASS --
 * which the runner treats as an error -- the moment the gap closes.
 */

#define SYSV_TEST_NAME "shm-attach-aliasing"

#include <sys/shm.h>

#include "../sysv.h"

#define FIRST_BYTE 0xA5
#define SECOND_BYTE 0x3C

int main(void)
{
	long pagesize = sysconf(_SC_PAGESIZE);
	if ( pagesize <= 0 )
		FAIL_ERRNO("sysconf _SC_PAGESIZE");

	int shmid = shmget(IPC_PRIVATE, (size_t)pagesize, IPC_CREAT | 0600);
	if ( shmid < 0 )
		FAIL_ERRNO("shmget");

	unsigned char *first = shmat(shmid, NULL, 0);
	if ( first == (void *)-1 )
		FAIL_ERRNO("shmat (first)");
	unsigned char *second = shmat(shmid, NULL, 0);
	if ( second == (void *)-1 )
		FAIL_ERRNO("shmat (second)");

	if ( first == second )
		FAILF("shmat returned the same address twice (%p); this test "
		      "cannot distinguish aliasing from a single mapping",
		      (void *)first);

	first[0] = FIRST_BYTE;
	if ( second[0] != FIRST_BYTE )
		FAILF("a store through the first attachment was not visible "
		      "through the second: wrote 0x%02X, read 0x%02X -- the "
		      "two attachments do not alias one segment",
		      FIRST_BYTE, second[0]);

	second[1] = SECOND_BYTE;
	if ( first[1] != SECOND_BYTE )
		FAILF("a store through the second attachment was not visible "
		      "through the first: wrote 0x%02X, read 0x%02X",
		      SECOND_BYTE, first[1]);

	if ( shmdt(first) < 0 )
		FAIL_ERRNO("shmdt (first)");
	if ( shmdt(second) < 0 )
		FAIL_ERRNO("shmdt (second)");
	if ( shmctl(shmid, IPC_RMID, NULL) < 0 )
		FAIL_ERRNO("shmctl IPC_RMID");
	return 0;
}
