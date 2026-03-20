#define _XOPEN_SOURCE 700
#define _GNU_SOURCE
#include <stddef.h>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <sys/sem.h>
#include <sys/shm.h>

/* Export offsets as global variables — inspect with wasm-objdump or similar */
#define OFF(name, type, field) \
    const int name = offsetof(type, field);
#define SZ(name, type) \
    const int name = sizeof(type);

/* Sizes */
SZ(sz_ipc_perm, struct ipc_perm)
SZ(sz_msqid_ds, struct msqid_ds)
SZ(sz_semid_ds, struct semid_ds)
SZ(sz_shmid_ds, struct shmid_ds)
SZ(sz_sembuf, struct sembuf)

/* ipc_perm */
OFF(off_perm_key, struct ipc_perm, key)
OFF(off_perm_uid, struct ipc_perm, uid)
OFF(off_perm_gid, struct ipc_perm, gid)
OFF(off_perm_cuid, struct ipc_perm, cuid)
OFF(off_perm_cgid, struct ipc_perm, cgid)
OFF(off_perm_mode, struct ipc_perm, mode)
OFF(off_perm_seq, struct ipc_perm, seq)

/* msqid_ds */
OFF(off_msg_perm, struct msqid_ds, msg_perm)
OFF(off_msg_stime, struct msqid_ds, msg_stime)
OFF(off_msg_rtime, struct msqid_ds, msg_rtime)
OFF(off_msg_ctime, struct msqid_ds, msg_ctime)
OFF(off_msg_cbytes, struct msqid_ds, msg_cbytes)
OFF(off_msg_qnum, struct msqid_ds, msg_qnum)
OFF(off_msg_qbytes, struct msqid_ds, msg_qbytes)
OFF(off_msg_lspid, struct msqid_ds, msg_lspid)
OFF(off_msg_lrpid, struct msqid_ds, msg_lrpid)

/* semid_ds */
OFF(off_sem_perm, struct semid_ds, sem_perm)
OFF(off_sem_otime, struct semid_ds, sem_otime)
OFF(off_sem_ctime, struct semid_ds, sem_ctime)
OFF(off_sem_nsems, struct semid_ds, sem_nsems)

/* shmid_ds */
OFF(off_shm_perm, struct shmid_ds, shm_perm)
OFF(off_shm_segsz, struct shmid_ds, shm_segsz)
OFF(off_shm_atime, struct shmid_ds, shm_atime)
OFF(off_shm_dtime, struct shmid_ds, shm_dtime)
OFF(off_shm_ctime, struct shmid_ds, shm_ctime)
OFF(off_shm_cpid, struct shmid_ds, shm_cpid)
OFF(off_shm_lpid, struct shmid_ds, shm_lpid)
OFF(off_shm_nattch, struct shmid_ds, shm_nattch)

/* sembuf */
OFF(off_sembuf_num, struct sembuf, sem_num)
OFF(off_sembuf_op, struct sembuf, sem_op)
OFF(off_sembuf_flg, struct sembuf, sem_flg)

/* msgbuf: long type + char data[] */
SZ(sz_long, long)
