/**
 * Test SysV IPC message queues, semaphores, and shared memory.
 * Single-process test to verify the IPC table is wired up.
 */
#include <stdio.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <sys/sem.h>
#include <sys/shm.h>

/* Use a custom struct for message passing (system msgbuf has mtext[1]) */
struct my_msgbuf {
    long mtype;
    char mtext[64];
};

int test_msgq(void) {
    /* Create a message queue */
    int qid = msgget(IPC_PRIVATE, IPC_CREAT | 0666);
    if (qid < 0) {
        perror("msgget");
        return 1;
    }
    printf("msgget: qid=%d\n", qid);

    /* Send a message */
    struct my_msgbuf msg;
    msg.mtype = 1;
    strcpy(msg.mtext, "hello ipc");
    if (msgsnd(qid, &msg, strlen(msg.mtext) + 1, 0) != 0) {
        perror("msgsnd");
        return 1;
    }
    printf("msgsnd: sent '%s'\n", msg.mtext);

    /* Receive the message */
    struct my_msgbuf recv_msg;
    memset(&recv_msg, 0, sizeof(recv_msg));
    int n = msgrcv(qid, &recv_msg, sizeof(recv_msg.mtext), 0, 0);
    if (n < 0) {
        perror("msgrcv");
        return 1;
    }
    printf("msgrcv: type=%ld text='%s'\n", recv_msg.mtype, recv_msg.mtext);

    if (recv_msg.mtype != 1 || strcmp(recv_msg.mtext, "hello ipc") != 0) {
        printf("FAIL: message mismatch\n");
        return 1;
    }

    /* Remove the queue */
    if (msgctl(qid, IPC_RMID, NULL) != 0) {
        perror("msgctl IPC_RMID");
        return 1;
    }
    printf("msgq: PASS\n");
    return 0;
}

int test_sem(void) {
    /* Create a semaphore set with 1 semaphore */
    int semid = semget(IPC_PRIVATE, 1, IPC_CREAT | 0666);
    if (semid < 0) {
        perror("semget");
        return 1;
    }
    printf("semget: semid=%d\n", semid);

    /* Set semaphore value to 1 */
    union semun {
        int val;
        struct semid_ds *buf;
        unsigned short *array;
    } arg;
    arg.val = 1;
    if (semctl(semid, 0, SETVAL, arg) != 0) {
        perror("semctl SETVAL");
        return 1;
    }

    /* Check value */
    int val = semctl(semid, 0, GETVAL);
    printf("semctl GETVAL: val=%d\n", val);
    if (val != 1) {
        printf("FAIL: expected val=1, got %d\n", val);
        return 1;
    }

    /* Decrement (P operation) */
    struct sembuf sop = { .sem_num = 0, .sem_op = -1, .sem_flg = 0 };
    if (semop(semid, &sop, 1) != 0) {
        perror("semop P");
        return 1;
    }

    val = semctl(semid, 0, GETVAL);
    printf("after P: val=%d\n", val);
    if (val != 0) {
        printf("FAIL: expected val=0 after P, got %d\n", val);
        return 1;
    }

    /* Increment (V operation) */
    sop.sem_op = 1;
    if (semop(semid, &sop, 1) != 0) {
        perror("semop V");
        return 1;
    }

    val = semctl(semid, 0, GETVAL);
    printf("after V: val=%d\n", val);
    if (val != 1) {
        printf("FAIL: expected val=1 after V, got %d\n", val);
        return 1;
    }

    /* Remove */
    if (semctl(semid, 0, IPC_RMID) != 0) {
        perror("semctl IPC_RMID");
        return 1;
    }
    printf("sem: PASS\n");
    return 0;
}

int test_shm(void) {
    /* Create shared memory segment */
    int shmid = shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0666);
    if (shmid < 0) {
        perror("shmget");
        return 1;
    }
    printf("shmget: shmid=%d\n", shmid);

    /* Attach */
    void *ptr = shmat(shmid, NULL, 0);
    if (ptr == (void *)-1) {
        perror("shmat");
        return 1;
    }
    printf("shmat: ptr=%p\n", ptr);

    /* Write and read */
    strcpy((char *)ptr, "shared memory test");
    char buf[64];
    strcpy(buf, (char *)ptr);
    printf("shm read: '%s'\n", buf);

    if (strcmp(buf, "shared memory test") != 0) {
        printf("FAIL: shm content mismatch\n");
        return 1;
    }

    /* Detach */
    if (shmdt(ptr) != 0) {
        perror("shmdt");
        return 1;
    }

    /* Remove */
    if (shmctl(shmid, IPC_RMID, NULL) != 0) {
        perror("shmctl IPC_RMID");
        return 1;
    }
    printf("shm: PASS\n");
    return 0;
}

int main(void) {
    int failures = 0;
    failures += test_msgq();
    failures += test_sem();
    failures += test_shm();

    if (failures == 0) {
        printf("ALL TESTS PASSED\n");
    } else {
        printf("FAILURES: %d\n", failures);
    }
    return failures;
}
