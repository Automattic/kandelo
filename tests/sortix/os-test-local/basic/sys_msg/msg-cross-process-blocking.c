/*
 * A message queue must carry messages BETWEEN processes, and a blocking
 * msgrcv must block until one arrives.
 *
 * Every upstream sys_msg test is single-process, so nothing asserts the
 * facility's reason for existing. An implementation whose queues were
 * per-process would pass all of them.
 *
 * Asserted here:
 *
 *   - a child's msgsnd is received by the parent through the identifier the
 *     parent created, with the payload intact;
 *   - the parent's msgrcv without IPC_NOWAIT waits for that message rather
 *     than failing with ENOMSG on an empty queue;
 *   - the reverse direction works too, so the queue is not a one-way channel
 *     that happens to be inherited;
 *   - msg_lspid names the process that last sent.
 *
 * The blocking direction cannot produce a false PASS from a race: the child
 * sleeps before sending, so if msgrcv did not block it would find the queue
 * empty and fail with ENOMSG rather than returning the message.
 */

#define SYSV_TEST_NAME "msg-cross-process-blocking"

#include <sys/msg.h>
#include <sys/wait.h>

#include "../sysv.h"

#define MAXTEXT 64
#define TO_PARENT 1
#define TO_CHILD 2

struct msg {
	long mtype;
	char mtext[MAXTEXT];
};

static const char CHILD_TEXT[] = "from-the-child";
static const char PARENT_TEXT[] = "from-the-parent";

int main(void)
{
	int qid = msgget(IPC_PRIVATE, IPC_CREAT | 0600);
	if ( qid < 0 )
		FAIL_ERRNO("msgget");

	pid_t pid = fork();
	if ( pid < 0 )
		FAIL_ERRNO("fork");
	if ( pid == 0 )
	{
		struct msg m;

		/*
		 * Sleep first, so the parent is already inside a blocking
		 * msgrcv on an empty queue. A msgrcv that did not block would
		 * have failed with ENOMSG by now.
		 */
		usleep(100000);

		memset(&m, 0, sizeof(m));
		m.mtype = TO_PARENT;
		memcpy(m.mtext, CHILD_TEXT, sizeof(CHILD_TEXT) - 1);
		if ( msgsnd(qid, &m, sizeof(CHILD_TEXT) - 1, 0) < 0 )
			_exit(2); /* child: msgsnd failed */

		/* Now receive the parent's reply, blocking. */
		memset(&m, 0, sizeof(m));
		ssize_t n = msgrcv(qid, &m, MAXTEXT, TO_CHILD, 0);
		if ( n < 0 )
			_exit(3); /* child: blocking msgrcv failed */
		if ( (size_t)n != sizeof(PARENT_TEXT) - 1 )
			_exit(4); /* child: wrong length from msgrcv */
		if ( memcmp(m.mtext, PARENT_TEXT, n) != 0 )
			_exit(5); /* child: wrong payload from msgrcv */
		_exit(0);
	}

	/* Blocking receive of the child's message. */
	struct msg m;
	memset(&m, 0, sizeof(m));
	ssize_t n = msgrcv(qid, &m, MAXTEXT, TO_PARENT, 0);
	if ( n < 0 )
		FAIL_ERRNO("parent msgrcv (blocking)");
	if ( (size_t)n != sizeof(CHILD_TEXT) - 1 )
		FAILF("parent msgrcv returned %zd bytes, expected %zu", n,
		      sizeof(CHILD_TEXT) - 1);
	if ( memcmp(m.mtext, CHILD_TEXT, n) != 0 )
		FAILF("parent received \"%.*s\", expected \"%s\" -- the "
		      "payload did not cross the process boundary", (int)n,
		      m.mtext, CHILD_TEXT);

	/* msg_lspid must name the child as the last sender. */
	struct msqid_ds ds;
	memset(&ds, 0, sizeof(ds));
	if ( msgctl(qid, IPC_STAT, &ds) < 0 )
		FAIL_ERRNO("msgctl IPC_STAT");
	if ( ds.msg_lspid != pid )
		FAILF("IPC_STAT reported msg_lspid %ld after the child sent; "
		      "the child is %ld", (long)ds.msg_lspid, (long)pid);

	/* Reply, so the reverse direction is exercised too. */
	memset(&m, 0, sizeof(m));
	m.mtype = TO_CHILD;
	memcpy(m.mtext, PARENT_TEXT, sizeof(PARENT_TEXT) - 1);
	if ( msgsnd(qid, &m, sizeof(PARENT_TEXT) - 1, 0) < 0 )
		FAIL_ERRNO("parent msgsnd");

	int status;
	if ( waitpid(pid, &status, 0) != pid )
		FAIL_ERRNO("waitpid");
	if ( !WIFEXITED(status) )
		FAILF("child did not exit normally (status 0x%X)", status);
	switch ( WEXITSTATUS(status) )
	{
	case 0: break;
	case 2: FAILF("the child's msgsnd into the inherited queue failed");
	case 3: FAILF("the child's blocking msgrcv failed; the parent's reply "
	              "never reached it");
	case 4: FAILF("the child's msgrcv returned the wrong length for the "
	              "parent's reply");
	case 5: FAILF("the child's msgrcv returned the wrong payload for the "
	              "parent's reply");
	default: FAILF("child exited %d", WEXITSTATUS(status));
	}

	if ( msgctl(qid, IPC_RMID, NULL) < 0 )
		FAIL_ERRNO("msgctl IPC_RMID");
	return 0;
}
