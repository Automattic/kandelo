#define _POSIX_C_SOURCE 200809L

#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <sys/sem.h>
#include <sys/shm.h>
#include <unistd.h>

struct test_message {
    long type;
    char text[8];
};

static int has_dir_entry(const char *path, const char *name) {
    DIR *dir = opendir(path);
    struct dirent *entry;

    if (!dir) {
        perror(path);
        return 0;
    }
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, name) == 0) {
            closedir(dir);
            return 1;
        }
    }
    closedir(dir);
    return 0;
}

static int read_ipc_row(const char *path, int id, char *row, size_t capacity) {
    FILE *file = fopen(path, "r");
    int key;
    int found_id;

    if (!file) {
        perror(path);
        return -1;
    }
    if (!fgets(row, (int)capacity, file)) {
        fclose(file);
        return -1;
    }
    while (fgets(row, (int)capacity, file)) {
        if (sscanf(row, "%d %d", &key, &found_id) == 2 && found_id == id) {
            fclose(file);
            return 0;
        }
    }
    fclose(file);
    return -1;
}

int main(void) {
    struct test_message message = { .type = 1, .text = "abc" };
    char row[512] = {0};
    unsigned long long cbytes, qnum, size, nattch, rss, swap;
    long long first_time, second_time, third_time;
    int qid = -1, semid = -1, shmid = -1;
    unsigned int mode;
    int key, id, first_pid, second_pid;
    int uid, gid, cuid, cgid;
    int result = 1;

    if (!has_dir_entry("/proc", "sysvipc") ||
        !has_dir_entry("/proc/sysvipc", "msg") ||
        !has_dir_entry("/proc/sysvipc", "sem") ||
        !has_dir_entry("/proc/sysvipc", "shm")) {
        fprintf(stderr, "missing /proc/sysvipc directory entries\n");
        goto cleanup;
    }

    qid = msgget(IPC_PRIVATE, IPC_CREAT | 0660);
    if (qid < 0 || msgsnd(qid, &message, 4, 0) != 0) {
        perror("message queue setup");
        goto cleanup;
    }
    if (read_ipc_row("/proc/sysvipc/msg", qid, row, sizeof(row)) != 0 ||
        sscanf(row, "%d %d %o %llu %llu %d %d %d %d %d %d %lld %lld %lld",
               &key, &id, &mode, &cbytes, &qnum, &first_pid, &second_pid,
               &uid, &gid, &cuid, &cgid, &first_time, &second_time,
               &third_time) != 14 ||
        id != qid || mode != 0660 || cbytes != 4 || qnum != 1 ||
        first_pid != (int)getpid() || uid != (int)getuid() ||
        gid != (int)getgid() || cuid != uid || cgid != gid) {
        fprintf(stderr, "invalid /proc/sysvipc/msg row: %s", row);
        goto cleanup;
    }

    semid = semget(IPC_PRIVATE, 2, IPC_CREAT | 0620);
    if (semid < 0) {
        perror("semget");
        goto cleanup;
    }
    if (read_ipc_row("/proc/sysvipc/sem", semid, row, sizeof(row)) != 0 ||
        sscanf(row, "%d %d %o %llu %d %d %d %d %lld %lld",
               &key, &id, &mode, &size, &uid, &gid, &cuid, &cgid,
               &first_time, &second_time) != 10 ||
        id != semid || mode != 0620 || size != 2 || uid != (int)getuid() ||
        gid != (int)getgid() || cuid != uid || cgid != gid) {
        fprintf(stderr, "invalid /proc/sysvipc/sem row: %s", row);
        goto cleanup;
    }

    shmid = shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0600);
    if (shmid < 0) {
        perror("shmget");
        goto cleanup;
    }
    if (read_ipc_row("/proc/sysvipc/shm", shmid, row, sizeof(row)) != 0 ||
        sscanf(row, "%d %d %o %llu %d %d %llu %d %d %d %d %lld %lld %lld %llu %llu",
               &key, &id, &mode, &size, &first_pid, &second_pid, &nattch,
               &uid, &gid, &cuid, &cgid, &first_time, &second_time,
               &third_time, &rss, &swap) != 16 ||
        id != shmid || mode != 0600 || size != 4096 ||
        first_pid != (int)getpid() || nattch != 0 || uid != (int)getuid() ||
        gid != (int)getgid() || cuid != uid || cgid != gid ||
        rss != 4096 || swap != 0) {
        fprintf(stderr, "invalid /proc/sysvipc/shm row: %s", row);
        goto cleanup;
    }

    puts("proc-sysvipc-ok");
    result = 0;

cleanup:
    if (qid >= 0) msgctl(qid, IPC_RMID, NULL);
    if (semid >= 0) semctl(semid, 0, IPC_RMID);
    if (shmid >= 0) shmctl(shmid, IPC_RMID, NULL);
    return result;
}
