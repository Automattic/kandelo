/*
 * putenv_test.c — Test that setenv/getenv/putenv/unsetenv work
 * and that environment variables populated by the kernel at startup
 * are visible to getenv().
 *
 * Expected usage: the host sets HOME=/home/test and PATH=/usr/bin
 * in proc.environ before calling _start.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <bits/kandelo_limits.h>

#ifdef KANDELO_ENV_TRANSACTION_TEST_WRAPPERS
/*
 * This fixture is linked with --wrap for allocator and raw syscall fault
 * injection. Production libc has no test hook: the wrappers exist only in the
 * test program and delegate unless a single failure has been armed.
 */
#if __SIZEOF_POINTER__ == 4
typedef long long raw_syscall_arg_t;
#else
typedef long raw_syscall_arg_t;
#endif

void *__real_malloc(size_t);
void *__real_realloc(void *, size_t);
long __real___syscall1(long, raw_syscall_arg_t);
long __real___syscall3(
    long, raw_syscall_arg_t, raw_syscall_arg_t, raw_syscall_arg_t);

static int allocations_before_failure = -1;
static int fail_next_setenv_syscall;
static int fail_next_unsetenv_syscall;
static unsigned long setenv_syscall_count;
static unsigned long unsetenv_syscall_count;

static int allocation_should_fail(void)
{
    if (allocations_before_failure < 0) return 0;
    if (allocations_before_failure-- > 0) return 0;
    allocations_before_failure = -1;
    errno = ENOMEM;
    return 1;
}

void *__wrap_malloc(size_t size)
{
    if (allocation_should_fail()) return NULL;
    return __real_malloc(size);
}

void *__wrap_realloc(void *pointer, size_t size)
{
    if (allocation_should_fail()) return NULL;
    return __real_realloc(pointer, size);
}

long __wrap___syscall1(long number, raw_syscall_arg_t arg1)
{
    if (number == SYS_unsetenv) {
        unsetenv_syscall_count++;
        if (fail_next_unsetenv_syscall) {
            fail_next_unsetenv_syscall = 0;
            return -EIO;
        }
    }
    return __real___syscall1(number, arg1);
}

long __wrap___syscall3(long number, raw_syscall_arg_t arg1,
    raw_syscall_arg_t arg2, raw_syscall_arg_t arg3)
{
    if (number == SYS_setenv) {
        setenv_syscall_count++;
        if (fail_next_setenv_syscall) {
            fail_next_setenv_syscall = 0;
            return -EIO;
        }
    }
    return __real___syscall3(number, arg1, arg2, arg3);
}
#endif

static int kernel_environment_equals(
    const char *name, const char *expected, size_t expected_len)
{
    size_t capacity = expected ? expected_len : 1;
    unsigned char *buf = malloc(capacity ? capacity : 1);
    if (!buf) {
        perror("malloc kernel environment buffer");
        return 0;
    }

    errno = 0;
    long length = syscall(SYS_getenv, name, buf, capacity);
    int matches = expected
        ? length == (long)expected_len &&
            memcmp(buf, expected, expected_len) == 0
        : length == -1 && errno == ENOENT;
    free(buf);
    return matches;
}

static int environment_equals(
    const char *name, const char *expected, size_t expected_len)
{
    const char *local = getenv(name);
    if (expected) {
        if (!local || strlen(local) != expected_len ||
            memcmp(local, expected, expected_len) != 0)
            return 0;
    } else if (local) {
        return 0;
    }
    return kernel_environment_equals(name, expected, expected_len);
}

static char *filled_string(size_t length, char byte)
{
    char *string = malloc(length + 1);
    if (!string) return NULL;
    memset(string, byte, length);
    string[length] = 0;
    return string;
}

static int test_setenv_transfer_boundary(void)
{
    const char name[] = "SET_BOUNDARY";
    const char rejected_name[] = "SET_REJECT_NEW";
    const size_t limit = KANDELO_PROCESS_METADATA_ENTRY_MAX_BYTES;
    const size_t name_len = strlen(name);
    const size_t rejected_name_len = strlen(rejected_name);
    const size_t exact_value_len = limit - name_len - 1;
    const size_t oversized_value_len = exact_value_len + 1;
    const size_t rejected_value_len = limit - rejected_name_len;
    char *exact = filled_string(exact_value_len, 's');
    char *oversized = filled_string(oversized_value_len, 'x');
    char *rejected = filled_string(rejected_value_len, 'n');
    if (!exact || !oversized || !rejected) {
        perror("allocate setenv boundary values");
        free(exact);
        free(oversized);
        free(rejected);
        return 60;
    }

    if (setenv(name, exact, 1) != 0 ||
        !environment_equals(name, exact, exact_value_len)) {
        fprintf(stderr, "exact-capacity setenv diverged\n");
        return 61;
    }

    errno = 0;
    if (setenv(name, oversized, 1) != -1 || errno != E2BIG ||
        !environment_equals(name, exact, exact_value_len)) {
        fprintf(stderr,
            "capacity+1 setenv did not preserve the prior value: errno=%d\n",
            errno);
        return 62;
    }

    errno = 0;
    if (setenv(rejected_name, rejected, 1) != -1 || errno != E2BIG ||
        !environment_equals(rejected_name, NULL, 0)) {
        fprintf(stderr,
            "capacity+1 new setenv did not remain absent: errno=%d\n",
            errno);
        return 63;
    }

    if (unsetenv(name) != 0 || !environment_equals(name, NULL, 0)) {
        fprintf(stderr, "unsetenv did not remove the exact-capacity value\n");
        return 64;
    }

    free(exact);
    free(oversized);
    free(rejected);
    puts("SETENV_BOUNDARY_PASS");
    return 0;
}

static int test_putenv_long_name_boundary(void)
{
    const size_t limit = KANDELO_PROCESS_METADATA_ENTRY_MAX_BYTES;
    const size_t name_len = 300;
    const size_t value_len = limit - name_len - 1;
    char *name = filled_string(name_len, 'L');
    char *entry = malloc(limit + 1);
    char *oversized = malloc(limit + 2);
    if (!name || !entry || !oversized) {
        perror("allocate putenv boundary values");
        free(name);
        free(entry);
        free(oversized);
        return 70;
    }

    memcpy(entry, name, name_len);
    entry[name_len] = '=';
    memset(entry + name_len + 1, 'p', value_len);
    entry[limit] = 0;

    memcpy(oversized, entry, limit);
    oversized[limit] = 'q';
    oversized[limit + 1] = 0;

    if (putenv(entry) != 0 ||
        !environment_equals(name, entry + name_len + 1, value_len)) {
        fprintf(stderr, "exact-capacity long-name putenv diverged\n");
        return 71;
    }

    errno = 0;
    if (putenv(oversized) != -1 || errno != E2BIG ||
        !environment_equals(name, entry + name_len + 1, value_len)) {
        fprintf(stderr,
            "capacity+1 putenv did not preserve the prior value: errno=%d\n",
            errno);
        return 72;
    }

    if (unsetenv(name) != 0 || !environment_equals(name, NULL, 0)) {
        fprintf(stderr, "unsetenv did not remove the long-name putenv value\n");
        return 73;
    }

    free(name);
    free(entry);
    free(oversized);
    puts("PUTENV_LONG_BOUNDARY_PASS");
    return 0;
}

#ifdef KANDELO_ENV_TRANSACTION_TEST_WRAPPERS
static int test_transaction_failures(void)
{
    const char name[] = "ENV_TRANSACTION";
    const char local_setenv_name[] = "ENV_LOCAL_SETENV_FAILURE";
    const char local_putenv_name[] = "ENV_LOCAL_PUTENV_FAILURE";
    const char initial[] = "before";
    char putenv_kernel_failure[] = "ENV_TRANSACTION=putenv-after";
    char putenv_local_failure[] = "ENV_LOCAL_PUTENV_FAILURE=new";

    if (setenv(name, initial, 1) != 0 ||
        !environment_equals(name, initial, sizeof(initial)-1)) {
        fprintf(stderr, "failed to establish transaction baseline\n");
        return 80;
    }

    unsigned long calls_before = setenv_syscall_count;
    fail_next_setenv_syscall = 1;
    errno = 0;
    if (setenv(name, "setenv-after", 1) != -1 || errno != EIO ||
        fail_next_setenv_syscall ||
        setenv_syscall_count != calls_before + 1 ||
        !environment_equals(name, initial, sizeof(initial)-1)) {
        fprintf(stderr,
            "setenv kernel errno changed local or kernel state: errno=%d\n",
            errno);
        return 81;
    }

    calls_before = setenv_syscall_count;
    fail_next_setenv_syscall = 1;
    errno = 0;
    if (putenv(putenv_kernel_failure) != -1 || errno != EIO ||
        fail_next_setenv_syscall ||
        setenv_syscall_count != calls_before + 1 ||
        !environment_equals(name, initial, sizeof(initial)-1)) {
        fprintf(stderr,
            "putenv kernel errno changed local or kernel state: errno=%d\n",
            errno);
        return 82;
    }

    unsigned long unset_calls_before = unsetenv_syscall_count;
    fail_next_unsetenv_syscall = 1;
    errno = 0;
    if (unsetenv(name) != -1 || errno != EIO ||
        fail_next_unsetenv_syscall ||
        unsetenv_syscall_count != unset_calls_before + 1 ||
        !environment_equals(name, initial, sizeof(initial)-1)) {
        fprintf(stderr,
            "unsetenv kernel errno changed local or kernel state: errno=%d\n",
            errno);
        return 83;
    }

    /*
     * Allow construction of the owned entry/name, then fail allocation of the
     * prospective environ array. The kernel syscall count must not advance.
     */
    calls_before = setenv_syscall_count;
    allocations_before_failure = 1;
    errno = 0;
    if (setenv(local_setenv_name, "new", 1) != -1 || errno != ENOMEM ||
        allocations_before_failure != -1 ||
        setenv_syscall_count != calls_before ||
        !environment_equals(local_setenv_name, NULL, 0)) {
        fprintf(stderr,
            "setenv local allocation failure reached or changed kernel state: "
            "errno=%d\n",
            errno);
        return 84;
    }

    calls_before = setenv_syscall_count;
    allocations_before_failure = 1;
    errno = 0;
    if (putenv(putenv_local_failure) != -1 || errno != ENOMEM ||
        allocations_before_failure != -1 ||
        setenv_syscall_count != calls_before ||
        !environment_equals(local_putenv_name, NULL, 0)) {
        fprintf(stderr,
            "putenv local allocation failure reached or changed kernel state: "
            "errno=%d\n",
            errno);
        return 85;
    }

    if (unsetenv(name) != 0 || !environment_equals(name, NULL, 0)) {
        fprintf(stderr, "failed to clean up transaction baseline\n");
        return 86;
    }

    puts("ENV_TRANSACTION_FAILURE_PASS");
    return 0;
}
#endif

int main(int argc, char **argv)
{
    /* 1. Test startup env population — host should have set HOME and PATH */
    const char *home = getenv("HOME");
    if (home) {
        printf("HOME=%s\n", home);
    } else {
        printf("HOME=<not set>\n");
    }

    const char *path = getenv("PATH");
    if (path) {
        printf("PATH=%s\n", path);
    } else {
        printf("PATH=<not set>\n");
    }

    /* 2. Test setenv */
    setenv("MY_VAR", "hello", 1);
    const char *my_var = getenv("MY_VAR");
    printf("MY_VAR=%s\n", my_var ? my_var : "<not set>");

    /* 3. Test setenv overwrite */
    setenv("MY_VAR", "world", 1);
    my_var = getenv("MY_VAR");
    printf("MY_VAR=%s\n", my_var ? my_var : "<not set>");

    /* 4. Test setenv no-overwrite */
    setenv("MY_VAR", "ignored", 0);
    my_var = getenv("MY_VAR");
    printf("MY_VAR=%s\n", my_var ? my_var : "<not set>");

    /* 5. Test putenv */
    putenv("PUT_VAR=from_putenv");
    const char *put_var = getenv("PUT_VAR");
    printf("PUT_VAR=%s\n", put_var ? put_var : "<not set>");

    /* 6. Test unsetenv */
    unsetenv("MY_VAR");
    my_var = getenv("MY_VAR");
    printf("MY_VAR=%s\n", my_var ? my_var : "<not set>");

    int result = test_setenv_transfer_boundary();
    if (result) return result;
    result = test_putenv_long_name_boundary();
    if (result) return result;
#ifdef KANDELO_ENV_TRANSACTION_TEST_WRAPPERS
    result = test_transaction_failures();
    if (result) return result;
#endif
    puts("ENV_COHERENCE_PASS");

    printf("DONE\n");
    return 0;
}
