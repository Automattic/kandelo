#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/shm.h>

#define PAGE 65536
#define CHECK(e) do { if (!(e)) { fprintf(stderr, "FAIL legacy-mapping line=%d errno=%d: %s\n", __LINE__, errno, #e); return 1; } } while (0)

int main(int argc, char **argv) {
    int grouped = argc > 1 && !strcmp(argv[1], "grouped");
    unsigned char *private = mmap(NULL, PAGE, PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(private != MAP_FAILED);
    memset(private, 0x5a, PAGE);
    int id = shmget(IPC_PRIVATE, PAGE, IPC_CREAT | 0600);
    CHECK(id >= 0);
    struct shmid_ds status;
    CHECK(shmctl(id, IPC_STAT, &status) == 0 && status.shm_nattch == 0);
    errno = 0;
    void *shared = shmat(id, NULL, 0);
    if (grouped) {
        CHECK(shared == (void *)-1 && errno == EOPNOTSUPP);
        CHECK(shmctl(id, IPC_STAT, &status) == 0 && status.shm_nattch == 0);
    } else {
        CHECK(shared != (void *)-1);
        ((unsigned char *)shared)[0] = 37;
        CHECK(shmctl(id, IPC_STAT, &status) == 0 && status.shm_nattch == 1);
        CHECK(shmdt(shared) == 0);
        CHECK(shmctl(id, IPC_STAT, &status) == 0 && status.shm_nattch == 0);
    }
    for (unsigned i = 0; i < PAGE; i++) CHECK(private[i] == 0x5a);
    CHECK(shmctl(id, IPC_RMID, NULL) == 0);
    CHECK(munmap(private, PAGE) == 0);
    // A declined legacy operation must not poison subsequent grouped maps.
    private = mmap(NULL, PAGE, PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(private != MAP_FAILED && private[0] == 0 && private[PAGE - 1] == 0);
    CHECK(munmap(private, PAGE) == 0);
    puts("grouped-sdk-legacy-mapping PASS");
    return 0;
}
