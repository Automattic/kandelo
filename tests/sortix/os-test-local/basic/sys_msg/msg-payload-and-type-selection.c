/*
 * A System V message queue must carry payloads and honour msgtyp selection.
 *
 * The upstream smoke tests (basic/sys_msg/msgsnd.c, msgget.c, msgctl.c) send
 * a message and check the return value. Nothing receives one, so nothing
 * asserts that the bytes survive, that the type is recorded, or that msgrcv's
 * selection rules work. A queue that discarded every message would pass them.
 *
 * Asserted here:
 *
 *   - a sent payload comes back byte for byte, with its mtype;
 *   - msgtyp > 0 selects that type specifically, out of arrival order;
 *   - msgtyp == 0 is first-in-first-out;
 *   - msgtyp < 0 selects the lowest type <= |msgtyp|;
 *   - a receive larger than msgsz fails with E2BIG and LEAVES the message on
 *     the queue, while MSG_NOERROR truncates instead;
 *   - IPC_NOWAIT on an empty queue is ENOMSG, not a hang or a zero-length
 *     read;
 *   - IPC_STAT reports the number of messages actually queued.
 *
 * The E2BIG case matters most: the failure mode of getting it wrong is
 * silent message loss, and no return-value check can see it.
 */

#define SYSV_TEST_NAME "msg-payload-and-type-selection"

#include <sys/msg.h>

#include "../sysv.h"

#define MAXTEXT 64

struct msg {
	long mtype;
	char mtext[MAXTEXT];
};

static void send_msg(int qid, long type, const char *text)
{
	struct msg m;
	memset(&m, 0, sizeof(m));
	m.mtype = type;
	size_t len = strlen(text);
	if ( MAXTEXT < len )
		FAILF("test bug: message text longer than MAXTEXT");
	memcpy(m.mtext, text, len);
	if ( msgsnd(qid, &m, len, 0) < 0 )
		FAILF("msgsnd(type %ld): %s", type, strerrno(errno));
}

static void expect_recv(int qid, long msgtyp, long want_type,
                        const char *want_text)
{
	struct msg m;
	memset(&m, 0, sizeof(m));
	ssize_t n = msgrcv(qid, &m, MAXTEXT, msgtyp, 0);
	if ( n < 0 )
		FAILF("msgrcv(msgtyp %ld): %s", msgtyp, strerrno(errno));
	size_t want_len = strlen(want_text);
	if ( (size_t)n != want_len )
		FAILF("msgrcv(msgtyp %ld) returned %zd bytes, expected %zu",
		      msgtyp, n, want_len);
	if ( m.mtype != want_type )
		FAILF("msgrcv(msgtyp %ld) returned mtype %ld, expected %ld",
		      msgtyp, m.mtype, want_type);
	if ( memcmp(m.mtext, want_text, want_len) != 0 )
		FAILF("msgrcv(msgtyp %ld) returned \"%.*s\", expected \"%s\" "
		      "-- the payload did not survive the queue",
		      msgtyp, (int)n, m.mtext, want_text);
}

int main(void)
{
	int qid = msgget(IPC_PRIVATE, IPC_CREAT | 0600);
	if ( qid < 0 )
		FAIL_ERRNO("msgget");

	/* An empty queue with IPC_NOWAIT must say so, not block or return 0. */
	struct msg scratch;
	errno = 0;
	ssize_t n = msgrcv(qid, &scratch, MAXTEXT, 0, IPC_NOWAIT);
	if ( 0 <= n )
		FAILF("msgrcv on an empty queue with IPC_NOWAIT returned %zd; "
		      "expected failure with ENOMSG", n);
	if ( errno != ENOMSG )
		FAILF("msgrcv on an empty queue with IPC_NOWAIT failed with "
		      "%s, expected ENOMSG", strerrno(errno));

	/* Round-trip a payload. */
	send_msg(qid, 1, "alpha");
	expect_recv(qid, 0, 1, "alpha");

	/*
	 * Type selection. Send three types in an order that differs from the
	 * order they are collected in, so an implementation that ignores
	 * msgtyp and always returns the head fails.
	 */
	send_msg(qid, 10, "ten");
	send_msg(qid, 20, "twenty");
	send_msg(qid, 30, "thirty");

	/* msgtyp > 0 selects that exact type, not the head. */
	expect_recv(qid, 20, 20, "twenty");

	/* msgtyp < 0 selects the LOWEST type <= |msgtyp|. */
	expect_recv(qid, -30, 10, "ten");

	/* msgtyp == 0 takes what is left, in arrival order. */
	expect_recv(qid, 0, 30, "thirty");

	/*
	 * E2BIG must not consume the message; MSG_NOERROR must truncate it.
	 * Getting this wrong loses data silently.
	 */
	send_msg(qid, 7, "abcdefgh");

	struct msg small;
	memset(&small, 0, sizeof(small));
	errno = 0;
	n = msgrcv(qid, &small, 3, 7, 0);
	if ( 0 <= n )
		FAILF("msgrcv with msgsz 3 for an 8-byte message returned %zd; "
		      "expected failure with E2BIG", n);
	if ( errno != E2BIG )
		FAILF("msgrcv with an undersized buffer failed with %s, "
		      "expected E2BIG", strerrno(errno));

	/* IPC_STAT must still count the message E2BIG left behind. */
	struct msqid_ds ds;
	memset(&ds, 0, sizeof(ds));
	if ( msgctl(qid, IPC_STAT, &ds) < 0 )
		FAIL_ERRNO("msgctl IPC_STAT");
	if ( ds.msg_qnum != 1 )
		FAILF("after E2BIG, IPC_STAT reported msg_qnum %llu, expected "
		      "1 -- a failed receive consumed the message",
		      (unsigned long long)ds.msg_qnum);

	/* MSG_NOERROR truncates the same message instead of failing. */
	memset(&small, 0, sizeof(small));
	n = msgrcv(qid, &small, 3, 7, MSG_NOERROR);
	if ( n < 0 )
		FAIL_ERRNO("msgrcv with MSG_NOERROR");
	if ( n != 3 )
		FAILF("msgrcv with MSG_NOERROR and msgsz 3 returned %zd bytes, "
		      "expected 3", n);
	if ( memcmp(small.mtext, "abc", 3) != 0 )
		FAILF("MSG_NOERROR returned \"%.3s\", expected \"abc\"",
		      small.mtext);

	memset(&ds, 0, sizeof(ds));
	if ( msgctl(qid, IPC_STAT, &ds) < 0 )
		FAIL_ERRNO("msgctl IPC_STAT (after MSG_NOERROR)");
	if ( ds.msg_qnum != 0 )
		FAILF("after a successful receive, IPC_STAT reported msg_qnum "
		      "%llu, expected 0",
		      (unsigned long long)ds.msg_qnum);

	if ( msgctl(qid, IPC_RMID, NULL) < 0 )
		FAIL_ERRNO("msgctl IPC_RMID");
	return 0;
}
