#define _GNU_SOURCE

#include <stddef.h>
#include <sys/epoll.h>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <sys/sem.h>
#include <sys/shm.h>

#define ASSERT_OFFSET(type, field, expected) \
	_Static_assert(offsetof(type, field) == (expected), #type "." #field)

ASSERT_OFFSET(struct ipc_perm, __ipc_perm_key, 0);
ASSERT_OFFSET(struct ipc_perm, uid, 4);
ASSERT_OFFSET(struct ipc_perm, gid, 8);
ASSERT_OFFSET(struct ipc_perm, cuid, 12);
ASSERT_OFFSET(struct ipc_perm, cgid, 16);
ASSERT_OFFSET(struct ipc_perm, mode, 20);
ASSERT_OFFSET(struct ipc_perm, __ipc_perm_seq, 24);

_Static_assert(sizeof(epoll_data_t) == 8, "epoll_data_t size");
_Static_assert(_Alignof(epoll_data_t) == 8, "epoll_data_t alignment");
_Static_assert(sizeof(struct epoll_event) == 16, "epoll_event size");
_Static_assert(_Alignof(struct epoll_event) == 8, "epoll_event alignment");
ASSERT_OFFSET(struct epoll_event, events, 0);
ASSERT_OFFSET(struct epoll_event, data, 8);

_Static_assert(sizeof(long) == sizeof(void *),
	       "Kandelo process long and pointer widths must match");
ASSERT_OFFSET(struct msgbuf, mtype, 0);
_Static_assert(offsetof(struct msgbuf, mtext) == sizeof(long),
	       "msgbuf text must follow one native long");

#if __SIZEOF_POINTER__ == 4

_Static_assert(sizeof(struct ipc_perm) == 36, "wasm32 ipc_perm size");
_Static_assert(_Alignof(struct ipc_perm) == 4, "wasm32 ipc_perm alignment");
ASSERT_OFFSET(struct ipc_perm, __pad1, 28);
ASSERT_OFFSET(struct ipc_perm, __pad2, 32);

_Static_assert(sizeof(struct semid_ds) == 72, "wasm32 semid_ds size");
ASSERT_OFFSET(struct semid_ds, sem_otime, 40);
ASSERT_OFFSET(struct semid_ds, sem_ctime, 48);
ASSERT_OFFSET(struct semid_ds, sem_nsems, 56);

_Static_assert(sizeof(struct msqid_ds) == 96, "wasm32 msqid_ds size");
ASSERT_OFFSET(struct msqid_ds, msg_stime, 40);
ASSERT_OFFSET(struct msqid_ds, msg_rtime, 48);
ASSERT_OFFSET(struct msqid_ds, msg_ctime, 56);
ASSERT_OFFSET(struct msqid_ds, msg_cbytes, 64);
ASSERT_OFFSET(struct msqid_ds, msg_qnum, 68);
ASSERT_OFFSET(struct msqid_ds, msg_qbytes, 72);
ASSERT_OFFSET(struct msqid_ds, msg_lspid, 76);
ASSERT_OFFSET(struct msqid_ds, msg_lrpid, 80);
ASSERT_OFFSET(struct msqid_ds, __unused, 84);

_Static_assert(sizeof(struct shmid_ds) == 88, "wasm32 shmid_ds size");
ASSERT_OFFSET(struct shmid_ds, shm_segsz, 36);
ASSERT_OFFSET(struct shmid_ds, shm_atime, 40);
ASSERT_OFFSET(struct shmid_ds, shm_dtime, 48);
ASSERT_OFFSET(struct shmid_ds, shm_ctime, 56);
ASSERT_OFFSET(struct shmid_ds, shm_cpid, 64);
ASSERT_OFFSET(struct shmid_ds, shm_lpid, 68);
ASSERT_OFFSET(struct shmid_ds, shm_nattch, 72);
ASSERT_OFFSET(struct shmid_ds, __pad1, 76);
ASSERT_OFFSET(struct shmid_ds, __pad2, 80);

#elif __SIZEOF_POINTER__ == 8

_Static_assert(sizeof(struct ipc_perm) == 48, "wasm64 ipc_perm size");
_Static_assert(_Alignof(struct ipc_perm) == 8, "wasm64 ipc_perm alignment");
ASSERT_OFFSET(struct ipc_perm, __pad1, 32);
ASSERT_OFFSET(struct ipc_perm, __pad2, 40);

_Static_assert(sizeof(struct semid_ds) == 88, "wasm64 semid_ds size");
ASSERT_OFFSET(struct semid_ds, sem_otime, 48);
ASSERT_OFFSET(struct semid_ds, sem_ctime, 56);
ASSERT_OFFSET(struct semid_ds, sem_nsems, 64);

_Static_assert(sizeof(struct msqid_ds) == 120, "wasm64 msqid_ds size");
ASSERT_OFFSET(struct msqid_ds, msg_stime, 48);
ASSERT_OFFSET(struct msqid_ds, msg_rtime, 56);
ASSERT_OFFSET(struct msqid_ds, msg_ctime, 64);
ASSERT_OFFSET(struct msqid_ds, msg_cbytes, 72);
ASSERT_OFFSET(struct msqid_ds, msg_qnum, 80);
ASSERT_OFFSET(struct msqid_ds, msg_qbytes, 88);
ASSERT_OFFSET(struct msqid_ds, msg_lspid, 96);
ASSERT_OFFSET(struct msqid_ds, msg_lrpid, 100);
ASSERT_OFFSET(struct msqid_ds, __unused, 104);

_Static_assert(sizeof(struct shmid_ds) == 112, "wasm64 shmid_ds size");
ASSERT_OFFSET(struct shmid_ds, shm_segsz, 48);
ASSERT_OFFSET(struct shmid_ds, shm_atime, 56);
ASSERT_OFFSET(struct shmid_ds, shm_dtime, 64);
ASSERT_OFFSET(struct shmid_ds, shm_ctime, 72);
ASSERT_OFFSET(struct shmid_ds, shm_cpid, 80);
ASSERT_OFFSET(struct shmid_ds, shm_lpid, 84);
ASSERT_OFFSET(struct shmid_ds, shm_nattch, 88);
ASSERT_OFFSET(struct shmid_ds, __pad1, 96);
ASSERT_OFFSET(struct shmid_ds, __pad2, 104);

#else
#error "Kandelo supports only four- and eight-byte process pointers"
#endif
