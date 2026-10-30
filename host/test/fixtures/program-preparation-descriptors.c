#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static void require(int condition, const char *operation) {
    if (!condition) {
        fprintf(stderr, "descriptor preparation: %s: %s\n", operation, strerror(errno));
        exit(1);
    }
}

int main(int argc, char **argv) {
    require(argc == 2 || argc == 3, "expected destination and optional mode");
    int refuse = argc == 3 && strcmp(argv[2], "refuse") == 0;
    int pinned = argc == 3 && strcmp(argv[2], "pinned-tools") == 0;
    require(argc == 2 || refuse || pinned, "unknown preparation mode");
    int source = open("/work/input.wasm", O_RDONLY | O_CLOEXEC);
    require(source >= 0, "open source");
    int staging = open("/work/fd-staging.wasm", O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    require(staging >= 0, "create staging");
    require(unlink("/work/fd-staging.wasm") == 0, "unlink staging");
    int source_capability = fcntl(source, F_DUPFD_CLOEXEC, 10);
    int output_capability = fcntl(staging, F_DUPFD_CLOEXEC, 10);
    require(source_capability >= 10 && output_capability >= 10, "duplicate capabilities");
    require(lseek(source, 17, SEEK_SET) == 17, "position source");
    require(lseek(staging, 9, SEEK_SET) == 9, "position staging");
    struct stat before_source;
    struct stat before_output;
    require(fstat(source, &before_source) == 0 && fstat(staging, &before_output) == 0, "stat inputs");
    if (pinned) {
        int preparer = open("/bin/wasm-fork-instrument", O_RDONLY | O_CLOEXEC);
        int optimizer = open("/bin/wasm-opt", O_RDONLY | O_CLOEXEC);
        require(preparer >= 0 && optimizer >= 0, "open current tools");
        require(dup2(preparer, 40) == 40 && dup2(optimizer, 41) == 41, "pin current tools");
        require(fcntl(40, F_SETFD, FD_CLOEXEC) == 0, "close launcher descriptor on helper exec");
        require(close(preparer) == 0 && close(optimizer) == 0, "close temporary tool descriptors");
        require(rename("/bin/wasm-fork-instrument", "/work/pinned-preparer.wasm") == 0, "move preparer name");
        require(rename("/bin/wasm-opt", "/work/pinned-optimizer.wasm") == 0, "move optimizer name");
        require(setenv("WASM_OPT", "/proc/self/fd/41", 1) == 0, "select pinned optimizer");
    }
    posix_spawn_file_actions_t actions;
    require(posix_spawn_file_actions_init(&actions) == 0, "initialize spawn actions");
    require(posix_spawn_file_actions_adddup2(&actions, source_capability, 3) == 0, "assign source");
    require(posix_spawn_file_actions_adddup2(&actions, output_capability, 4) == 0, "assign output");
    char *arguments[] = {
        "wasm-fork-instrument", "--input-fd", "3", "--output-fd", "4", "--bind-original",
        "--post-optimize", "Os", "--max-input-bytes", refuse ? "1" : "16777216",
        "--max-output-bytes", "16777216", NULL
    };
    pid_t child;
    int spawned = posix_spawn(&child, pinned ? "/proc/self/fd/40" : "/bin/wasm-fork-instrument", &actions, NULL, arguments, environ);
    posix_spawn_file_actions_destroy(&actions);
    require(spawned == 0, "spawn preparer");
    close(source_capability);
    close(output_capability);
    int status;
    pid_t waited;
    do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
    require(waited == child && WIFEXITED(status), "wait preparer");
    require(WEXITSTATUS(status) == (refuse ? 1 : 0), "preparer exit");
    if (pinned) {
        require(close(40) == 0 && close(41) == 0, "close pinned tools");
        require(rename("/work/pinned-preparer.wasm", "/bin/wasm-fork-instrument") == 0, "restore preparer name");
        require(rename("/work/pinned-optimizer.wasm", "/bin/wasm-opt") == 0, "restore optimizer name");
    }
    require(lseek(source, 0, SEEK_CUR) == 17 && lseek(staging, 0, SEEK_CUR) == 9, "shared offsets unchanged");
    struct stat after_source;
    struct stat after_output;
    require(fstat(source, &after_source) == 0 && fstat(staging, &after_output) == 0, "stat completed descriptors");
    require(after_source.st_size == before_source.st_size && after_source.st_mode == before_source.st_mode, "source unchanged");
    require(after_output.st_mode == before_output.st_mode && after_output.st_nlink == 0, "private mode unchanged");
    require((fcntl(source, F_GETFD) & FD_CLOEXEC) != 0 && (fcntl(staging, F_GETFD) & FD_CLOEXEC) != 0, "parent descriptor flags unchanged");
    if (refuse) {
        require(after_output.st_size == 0, "refused output remains empty");
    } else {
        require(after_output.st_size > 8, "output present");
        int destination = open(argv[1], O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0700);
        require(destination >= 0, "publish test result");
        char buffer[65536];
        off_t position = 0;
        while (position < after_output.st_size) {
            ssize_t count = pread(staging, buffer, sizeof(buffer), position);
            if (count < 0 && errno == EINTR) continue;
            require(count > 0, "read prepared staging");
            ssize_t written = 0;
            while (written < count) {
                ssize_t part = write(destination, buffer + written, count - written);
                if (part < 0 && errno == EINTR) continue;
                require(part > 0, "write test result");
                written += part;
            }
            position += count;
        }
        require(fsync(destination) == 0 && close(destination) == 0, "sync test result");
    }
    require(close(source) == 0 && close(staging) == 0, "close capabilities");
    puts(refuse ? "DESCRIPTOR_REFUSAL_PASS" : "DESCRIPTOR_PREPARATION_PASS");
    return 0;
}
